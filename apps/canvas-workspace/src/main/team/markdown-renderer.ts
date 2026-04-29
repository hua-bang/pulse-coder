/**
 * Tasks markdown renderer & watcher.
 *
 * Each team has a `tasks/tasks.json` (TaskList's source of truth, locked
 * via O_EXCL). Agents shouldn't have to read JSON to understand the team
 * state, and the user definitely shouldn't — so we maintain a sibling
 * `tasks.md` rendered from the JSON whenever it changes. The renderer
 * is run on:
 *   1. Main process startup (one pass for every team in `~/.pulse-coder/teams/`)
 *   2. A long-lived `fs.watch` per state directory (so subsequent
 *      changes from any agent CLI invocation flow through automatically)
 *
 * The markdown is intentionally minimal — agents and users both should
 * be able to skim it. Detailed task fields (createdAt, updatedAt) live
 * in the JSON for tooling that needs precision.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TEAMS_ROOT = join(homedir(), '.pulse-coder', 'teams');

interface MinimalTask {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  deps: string[];
  assignee: string | null;
  createdBy: string;
  result?: string;
}

interface MinimalConfig {
  teamId: string;
  teamName: string;
  members?: Array<{ memberId: string; agentType: string; isLead: boolean }>;
  leadMemberId?: string;
}

const watchers = new Map<string, FSWatcher>();
/** Coalesce bursts of fs.watch events from a single TaskList write. The
 *  TaskList does write → rename → notify-listeners, which on macOS can
 *  fire 2-3 events for one logical change. */
const debounceTimers = new Map<string, NodeJS.Timeout>();

/** Render JSON state to markdown, writing if (and only if) the result
 *  differs from what's already on disk. Skipping no-op writes keeps the
 *  watcher from feeding itself a loop. */
function renderTasksMd(stateDir: string): void {
  const tasksJsonPath = join(stateDir, 'tasks', 'tasks.json');
  const tasksMdPath = join(stateDir, 'tasks.md');
  const configPath = join(stateDir, 'config.json');

  if (!existsSync(tasksJsonPath)) return;

  let tasks: MinimalTask[] = [];
  try {
    tasks = JSON.parse(readFileSync(tasksJsonPath, 'utf-8'));
  } catch {
    // The TaskList writes are atomic via rename, but a watcher firing
    // mid-write is theoretically possible on some filesystems. Skip this
    // tick — we'll catch up on the next event.
    return;
  }

  let config: MinimalConfig | null = null;
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as MinimalConfig;
    } catch {
      // Same reasoning as above.
    }
  }

  const md = renderMarkdown(tasks, config);
  let existing = '';
  try {
    existing = readFileSync(tasksMdPath, 'utf-8');
  } catch {
    // First write — fall through.
  }
  if (existing === md) return;
  writeFileSync(tasksMdPath, md, 'utf-8');
}

function renderMarkdown(tasks: MinimalTask[], config: MinimalConfig | null): string {
  const counts = {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === 'pending').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  };

  const memberById = new Map<string, { agentType: string; isLead: boolean }>();
  for (const m of config?.members ?? []) {
    memberById.set(m.memberId, { agentType: m.agentType, isLead: m.isLead });
  }

  const formatMember = (memberId: string | null): string => {
    if (!memberId) return '_unassigned_';
    const m = memberById.get(memberId);
    if (!m) return memberId;
    return `${m.agentType}${m.isLead ? ' (lead)' : ''} \`${memberId}\``;
  };

  const out: string[] = [];
  const teamLabel = config ? `${config.teamName} (${config.teamId})` : '(unknown team)';
  out.push(`# Team Tasks — ${teamLabel}`);
  out.push('');
  out.push('> Auto-generated from `tasks/tasks.json` — do NOT edit manually; changes will be overwritten.');
  out.push(`> Last sync: ${new Date().toISOString()}`);
  out.push('');
  out.push('## Stats');
  out.push(`- Total: **${counts.total}** | ☐ Pending: ${counts.pending} | ▶ In progress: ${counts.in_progress} | ☑ Completed: ${counts.completed} | ✗ Failed: ${counts.failed}`);
  out.push('');

  if (tasks.length === 0) {
    out.push('## Tasks');
    out.push('');
    out.push('_No tasks yet._');
    return out.join('\n') + '\n';
  }

  // Group by status for human readability; in-progress on top so the
  // "what's happening right now" answer is the first thing on screen.
  const order: Array<MinimalTask['status']> = ['in_progress', 'pending', 'completed', 'failed'];
  const glyph = (s: MinimalTask['status']) =>
    s === 'in_progress' ? '▶' : s === 'pending' ? '☐' : s === 'completed' ? '☑' : '✗';

  for (const status of order) {
    const group = tasks.filter((t) => t.status === status);
    if (group.length === 0) continue;
    out.push(`## ${capitalize(status.replace('_', ' '))} (${group.length})`);
    out.push('');
    for (const t of group) {
      out.push(`### ${glyph(t.status)} ${t.title}`);
      out.push(`- ID: \`${t.id}\``);
      out.push(`- Assignee: ${formatMember(t.assignee)}`);
      if (t.deps.length > 0) {
        out.push(`- Depends on: ${t.deps.map((d) => `\`${d}\``).join(', ')}`);
      }
      if (t.description) {
        out.push(`- Description: ${oneLine(t.description)}`);
      }
      if (t.result) {
        out.push(`- Result: ${oneLine(t.result)}`);
      }
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function oneLine(s: string): string {
  // Collapse newlines so each task stays a single bullet line. Long
  // descriptions belong in linked files, not embedded in tasks.md.
  return s.replace(/\s+/g, ' ').trim();
}

/** Start watching a single team's `tasks/tasks.json` and re-render on
 *  every change. Re-entrant: if a watcher already exists for the dir
 *  it's a no-op. Returns immediately after performing one initial render. */
export function watchTeam(stateDir: string): void {
  if (watchers.has(stateDir)) return;

  // Initial render — covers both "freshly created team" and "main
  // process restart found existing teams" paths.
  renderTasksMd(stateDir);

  const tasksDir = join(stateDir, 'tasks');
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }

  // Watch the `tasks/` directory rather than tasks.json directly: the
  // TaskList writes go through `writeFileSync` (truncate-then-write),
  // and watching the file handle on macOS sometimes loses the watch
  // when the inode is replaced. Watching the parent dir is bulletproof.
  const watcher = watch(tasksDir, { persistent: false }, (_event, filename) => {
    if (filename !== 'tasks.json' && filename !== null) return;
    const existing = debounceTimers.get(stateDir);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      stateDir,
      setTimeout(() => {
        debounceTimers.delete(stateDir);
        try {
          renderTasksMd(stateDir);
        } catch (err) {
          // Swallow — the next change event will retry. Logging would
          // be noisy because the same write often fires twice.
          void err;
        }
      }, 50),
    );
  });
  watchers.set(stateDir, watcher);
}

/** Bootstrap: scan TEAMS_ROOT and start a watcher for every team
 *  directory. Called once from the main process startup. */
export function watchAllExistingTeams(): void {
  if (!existsSync(TEAMS_ROOT)) return;
  for (const entry of readdirSync(TEAMS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    watchTeam(join(TEAMS_ROOT, entry.name));
  }
}

/** Stop all watchers (Electron app quit hook). */
export function stopAllTeamWatchers(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
}
