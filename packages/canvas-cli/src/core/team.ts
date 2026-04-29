/**
 * Team operations — file-backed agent team coordination on top of
 * `~/.pulse-coder/teams/{teamId}/`.
 *
 * The directory layout deliberately mirrors `pulse-coder-agent-teams`'s
 * own `Team` class so that future in-process teammates (added in v2+) can
 * share the same on-disk protocol. We only reuse the two leaf primitives —
 * `TaskList` (tasks/tasks.json + lock) and `Mailbox` (mailbox/*.json) —
 * because those are pure file IO, language- and process-agnostic. The
 * `Team` / `TeamLead` / `Teammate` classes from that package assume
 * in-process Engine instances, which doesn't match canvas (PTY CLIs).
 *
 * Style note: this module exports plain functions to match the rest of
 * `canvas-cli/core/`. State (live `TaskList` / `Mailbox` instances) lives
 * in a module-private cache because both classes wrap a stateful directory
 * handle and re-instantiating them on every call would bypass their
 * write-lock retry counters.
 */
import { promises as fsAsync } from 'fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Mailbox, TaskList } from 'pulse-coder-agent-teams';

/**
 * Roots can be overridden via `PULSE_TEAMS_ROOT` / `PULSE_TEAMS_ARCHIVE_ROOT`
 * for tests and isolated CLI runs. We resolve these per call (not at
 * module load) so tests can flip the env mid-process via `process.env`.
 */
function teamsRoot(): string {
  return process.env.PULSE_TEAMS_ROOT || join(homedir(), '.pulse-coder', 'teams');
}
function archiveRoot(): string {
  return process.env.PULSE_TEAMS_ARCHIVE_ROOT || join(homedir(), '.pulse-coder', 'teams-archive');
}

/**
 * Persisted team metadata. Stored at `{stateDir}/config.json`.
 *
 * The shape is intentionally close to `pulse-coder-agent-teams`'s
 * `PersistedTeamConfig` so the two protocols stay aligned, with a
 * `workspaceId` field added for canvas's per-workspace listings.
 */
export interface TeamConfigFile {
  teamId: string;
  teamName: string;
  workspaceId: string;
  createdAt: number;
  members: TeamMemberRecord[];
  /** memberId of the current lead, if any. Stored separately from
   *  `members[].isLead` so leadership can be rotated without rewriting
   *  the full member array. */
  leadMemberId?: string;
}

export interface TeamMemberRecord {
  memberId: string;
  /** Canvas node id of the agent — links a mailbox file back to a
   *  picture-on-the-canvas. */
  nodeId: string;
  /** "claude-code" | "codex" | "pulse-coder" */
  agentType: string;
  isLead: boolean;
  joinedAt: number;
}

export interface TeamRuntime {
  config: TeamConfigFile;
  taskList: TaskList;
  mailbox: Mailbox;
  stateDir: string;
}

interface CreateTeamArgs {
  workspaceId: string;
  teamName: string;
}

interface AddMemberArgs {
  nodeId: string;
  agentType: string;
  isLead?: boolean;
}

const runtimes = new Map<string, TeamRuntime>();

/** Brand-new team. Generates a UUID and persists an empty config + the
 *  TaskList / Mailbox bootstrap files. */
export function createTeam(args: CreateTeamArgs): TeamRuntime {
  const teamId = randomUUID();
  const stateDir = join(teamsRoot(), teamId);
  mkdirSync(stateDir, { recursive: true });

  const config: TeamConfigFile = {
    teamId,
    teamName: args.teamName,
    workspaceId: args.workspaceId,
    createdAt: Date.now(),
    members: [],
  };
  writeConfig(stateDir, config);

  const runtime: TeamRuntime = {
    config,
    stateDir,
    taskList: new TaskList(stateDir),
    mailbox: new Mailbox(stateDir),
  };
  runtimes.set(teamId, runtime);
  return runtime;
}

/** Look up an existing team. Hydrates from disk on cache miss. Returns
 *  `null` when the state directory is gone (destroyed or never existed). */
export function getTeam(teamId: string): TeamRuntime | null {
  const cached = runtimes.get(teamId);
  if (cached) return cached;

  const stateDir = join(teamsRoot(), teamId);
  if (!existsSync(stateDir)) return null;

  const config = readConfig(stateDir);
  if (!config) return null;

  const runtime: TeamRuntime = {
    config,
    stateDir,
    taskList: new TaskList(stateDir),
    mailbox: new Mailbox(stateDir),
  };
  runtimes.set(teamId, runtime);
  return runtime;
}

/** All teams scoped to a workspace. Always reads disk so listings stay
 *  fresh after restarts. */
export async function listTeams(workspaceId: string): Promise<TeamConfigFile[]> {
  if (!existsSync(teamsRoot())) return [];
  const entries = await fsAsync.readdir(teamsRoot(), { withFileTypes: true });
  const out: TeamConfigFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const config = readConfig(join(teamsRoot(), entry.name));
    if (config && config.workspaceId === workspaceId) out.push(config);
  }
  return out;
}

/** Register a member. Caller is responsible for creating the actual
 *  canvas agent node and stamping the matching `teamMembership` field on
 *  it; this function only updates the team's config.json. */
export function addMember(teamId: string, args: AddMemberArgs): TeamMemberRecord | null {
  const runtime = getTeam(teamId);
  if (!runtime) return null;

  // Counter-based memberId (rather than UUID) keeps mailbox file
  // listings ordered and human-readable when debugging.
  const nextIdx = runtime.config.members.length + 1;
  const memberId = `${teamId}-m${nextIdx}`;

  const record: TeamMemberRecord = {
    memberId,
    nodeId: args.nodeId,
    agentType: args.agentType,
    isLead: args.isLead === true,
    joinedAt: Date.now(),
  };
  runtime.config.members.push(record);
  if (record.isLead) runtime.config.leadMemberId = memberId;
  writeConfig(runtime.stateDir, runtime.config);
  return record;
}

/** Confirm a memberId actually belongs to a team. Used by every
 *  `--member-id`-taking subcommand to reject cross-team requests where
 *  one team's member tries to act on another team's mailbox. */
export function hasMember(teamId: string, memberId: string): boolean {
  const runtime = getTeam(teamId);
  if (!runtime) return false;
  return runtime.config.members.some((m) => m.memberId === memberId);
}

/** Find the member backing a canvas node id. Useful when only the PTY
 *  node is known (e.g. when an agent's PTY exits and we need to figure
 *  out which team to notify). */
export function findMemberByNodeId(teamId: string, nodeId: string): TeamMemberRecord | null {
  const runtime = getTeam(teamId);
  if (!runtime) return null;
  return runtime.config.members.find((m) => m.nodeId === nodeId) ?? null;
}

/** Tear down a team: rename its state dir into the archive root and drop
 *  the in-memory cache entry. Caller is responsible for closing PTYs and
 *  removing canvas nodes. */
export async function destroyTeam(teamId: string): Promise<{ archivedTo: string } | null> {
  const cached = runtimes.get(teamId);
  const stateDir = cached?.stateDir ?? join(teamsRoot(), teamId);
  if (!existsSync(stateDir)) return null;

  await fsAsync.mkdir(archiveRoot(), { recursive: true });
  const archivedTo = join(archiveRoot(), `${teamId}-${Date.now()}`);
  await fsAsync.rename(stateDir, archivedTo);

  runtimes.delete(teamId);
  return { archivedTo };
}

/** Test-only: drop the runtime cache. Production callers should never
 *  need this — getTeam re-hydrates on demand. */
export function _resetTeamCache(): void {
  runtimes.clear();
}

// ─── Internal config helpers ──────────────────────────────────────────

function configPath(stateDir: string): string {
  return join(stateDir, 'config.json');
}

function writeConfig(stateDir: string, config: TeamConfigFile): void {
  writeFileSync(configPath(stateDir), JSON.stringify(config, null, 2), 'utf-8');
}

function readConfig(stateDir: string): TeamConfigFile | null {
  const path = configPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TeamConfigFile;
  } catch {
    return null;
  }
}
