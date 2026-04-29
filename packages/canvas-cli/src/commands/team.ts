/**
 * `pulse-canvas team` — coordinate agent teams via the file-backed
 * TaskList / Mailbox protocol from `pulse-coder-agent-teams`.
 *
 * All state lives under `~/.pulse-coder/teams/{teamId}/`. Agents (lead
 * and teammates) call these subcommands via their bash tool to claim
 * tasks, exchange messages, and report progress; nothing in the loop
 * needs an HTTP server or IPC channel.
 *
 * Every team-scoped subcommand requires a `teamId` positional and (where
 * relevant) a `--member-id`. The `--member-id` is verified against the
 * team's persisted members so one team's lead cannot accidentally write
 * into another team's mailbox or claim its tasks.
 */
import { Command } from 'commander';
import {
  addMember,
  createTeam,
  destroyTeam,
  getTeam,
  hasMember,
  listTeams,
} from '../core/team';
import { errorOutput, output, type OutputFormat } from '../output';

interface RootOpts {
  format: OutputFormat;
  storeDir?: string;
  workspace?: string;
}

/** Walk up to the root program to read global flags (`--format`,
 *  `--workspace`, `--store-dir`). Subcommands nested two levels deep
 *  (`team task create`) need to skip TWO parents to reach root, so we
 *  loop instead of hardcoding `parent.parent`. */
function getRootOpts(cmd: Command): RootOpts {
  let cur: Command | null = cmd;
  while (cur && cur.parent) cur = cur.parent;
  const opts = cur?.opts() ?? {};
  return {
    format: (opts.format as OutputFormat) ?? 'text',
    storeDir: opts.storeDir as string | undefined,
    workspace: opts.workspace as string | undefined,
  };
}

function requireWorkspace(rootOpts: RootOpts): string {
  if (!rootOpts.workspace) {
    errorOutput('Workspace ID required. Use --workspace <id> or set $PULSE_CANVAS_WORKSPACE_ID');
  }
  return rootOpts.workspace!;
}

/** Parse a comma-separated list option (e.g. `--deps a,b,c`). Returns an
 *  empty array for undefined or empty inputs so callers can spread it
 *  unconditionally. */
function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function registerTeamCommands(program: Command): void {
  const team = program
    .command('team')
    .description('Manage agent teams (lead/teammate coordination on the canvas)');

  // ─── team create ──────────────────────────────────────────────────
  team.command('create')
    .argument('<name>', 'Human-readable team name')
    .description('Create a new team. Generates a UUID and bootstraps the state directory.')
    .action(async function (this: Command, name: string) {
      const rootOpts = getRootOpts(this);
      const workspace = requireWorkspace(rootOpts);

      const runtime = createTeam({ workspaceId: workspace, teamName: name });

      output(
        { teamId: runtime.config.teamId, teamName: name, stateDir: runtime.stateDir },
        rootOpts.format,
        (d) => {
          const r = d as { teamId: string; teamName: string; stateDir: string };
          return `Created team "${r.teamName}"\n  teamId: ${r.teamId}\n  state:  ${r.stateDir}`;
        },
      );
    });

  // ─── team list ────────────────────────────────────────────────────
  team.command('list')
    .description('List teams scoped to the current workspace')
    .action(async function (this: Command) {
      const rootOpts = getRootOpts(this);
      const workspace = requireWorkspace(rootOpts);

      const teams = await listTeams(workspace);
      output(teams, rootOpts.format, (d) => {
        const items = d as typeof teams;
        if (items.length === 0) return 'No teams in this workspace.';
        const lines = items.map((t) => {
          const lead = t.leadMemberId ? ` lead=${t.leadMemberId}` : '';
          return `  ${t.teamId}  "${t.teamName}"  members=${t.members.length}${lead}`;
        });
        return `Teams:\n${lines.join('\n')}`;
      });
    });

  // ─── team status ──────────────────────────────────────────────────
  team.command('status')
    .argument('<teamId>', 'Team ID')
    .description('Aggregate snapshot: members + task statistics')
    .action(async function (this: Command, teamId: string) {
      const rootOpts = getRootOpts(this);
      const runtime = getTeam(teamId);
      if (!runtime) errorOutput(`Team not found: ${teamId}`);

      const stats = runtime!.taskList.stats();
      const status = {
        teamId,
        teamName: runtime!.config.teamName,
        leadMemberId: runtime!.config.leadMemberId ?? null,
        members: runtime!.config.members,
        tasks: stats,
      };
      output(status, rootOpts.format, (d) => {
        const s = d as typeof status;
        const memberLines = s.members.map(
          (m) => `  ${m.memberId}  ${m.agentType}${m.isLead ? ' [LEAD]' : ''}  node=${m.nodeId}`,
        );
        return [
          `Team: ${s.teamName} (${s.teamId})`,
          `Lead: ${s.leadMemberId ?? '(none)'}`,
          `Members (${s.members.length}):`,
          memberLines.length > 0 ? memberLines.join('\n') : '  (none)',
          `Tasks: ${s.tasks.total} total | ${s.tasks.pending} pending | ${s.tasks.in_progress} in_progress | ${s.tasks.completed} completed | ${s.tasks.failed} failed`,
        ].join('\n');
      });
    });

  // ─── team add-member ──────────────────────────────────────────────
  team.command('add-member')
    .argument('<teamId>', 'Team ID')
    .requiredOption('--node-id <id>', 'Canvas agent node id this member is backed by')
    .requiredOption('--agent-type <type>', 'Agent type: claude-code | codex | pulse-coder')
    .option('--lead', 'Mark this member as the team lead')
    .description('Register a member in a team. Caller is responsible for the canvas node itself.')
    .action(async function (
      this: Command,
      teamId: string,
      cmdOpts: { nodeId: string; agentType: string; lead?: boolean },
    ) {
      const rootOpts = getRootOpts(this);
      const valid = ['claude-code', 'codex', 'pulse-coder'];
      if (!valid.includes(cmdOpts.agentType)) {
        errorOutput(`Invalid --agent-type "${cmdOpts.agentType}". Must be: ${valid.join(', ')}`);
      }

      const member = addMember(teamId, {
        nodeId: cmdOpts.nodeId,
        agentType: cmdOpts.agentType,
        isLead: cmdOpts.lead === true,
      });
      if (!member) errorOutput(`Team not found: ${teamId}`);

      output(member!, rootOpts.format, (d) => {
        const m = d as typeof member;
        return `Added member ${m!.memberId}${m!.isLead ? ' [LEAD]' : ''}  type=${m!.agentType}  node=${m!.nodeId}`;
      });
    });

  // ─── team destroy ─────────────────────────────────────────────────
  team.command('destroy')
    .argument('<teamId>', 'Team ID')
    .description('Archive the team state directory. Does NOT close PTYs or remove canvas nodes.')
    .action(async function (this: Command, teamId: string) {
      const rootOpts = getRootOpts(this);
      const result = await destroyTeam(teamId);
      if (!result) errorOutput(`Team not found: ${teamId}`);

      output(result!, rootOpts.format, (d) => {
        const r = d as { archivedTo: string };
        return `Team ${teamId} archived to:\n  ${r.archivedTo}`;
      });
    });

  // ─── team task <subcommand> ───────────────────────────────────────
  const task = team.command('task').description('Shared task list (file-locked, dependency-aware)');

  task.command('create')
    .argument('<teamId>', 'Team ID')
    .requiredOption('--member-id <id>', 'Member id of the creator (recorded as createdBy)')
    .requiredOption('--title <title>', 'Short task title')
    .requiredOption('--description <desc>', 'Detailed description')
    .option('--deps <ids>', 'Comma-separated task ids this task depends on')
    .option('--assignee <memberId>', 'Pre-assign to a specific member')
    .description('Create a task in the shared list')
    .action(async function (
      this: Command,
      teamId: string,
      cmdOpts: { memberId: string; title: string; description: string; deps?: string; assignee?: string },
    ) {
      const rootOpts = getRootOpts(this);
      if (!hasMember(teamId, cmdOpts.memberId)) {
        errorOutput(`Member ${cmdOpts.memberId} does not belong to team ${teamId}`);
      }
      const runtime = getTeam(teamId)!;

      const created = await runtime.taskList.create(
        {
          title: cmdOpts.title,
          description: cmdOpts.description,
          deps: parseList(cmdOpts.deps),
          assignee: cmdOpts.assignee,
        },
        cmdOpts.memberId,
      );

      output(created, rootOpts.format, (d) => {
        const t = d as typeof created;
        const deps = t.deps.length > 0 ? ` deps=[${t.deps.join(',')}]` : '';
        const assn = t.assignee ? ` assignee=${t.assignee}` : '';
        return `Created task ${t.id}\n  title: ${t.title}${deps}${assn}`;
      });
    });

  task.command('claim')
    .argument('<teamId>', 'Team ID')
    .requiredOption('--member-id <id>', 'Member claiming the task')
    .option('--task-id <id>', 'Specific task to claim. Omit for auto-claim.')
    .description('Claim a pending, unblocked task. Auto-claim picks: pre-assigned-to-me → unassigned → work-stealing.')
    .action(async function (
      this: Command,
      teamId: string,
      cmdOpts: { memberId: string; taskId?: string },
    ) {
      const rootOpts = getRootOpts(this);
      if (!hasMember(teamId, cmdOpts.memberId)) {
        errorOutput(`Member ${cmdOpts.memberId} does not belong to team ${teamId}`);
      }
      const runtime = getTeam(teamId)!;

      const task = await runtime.taskList.claim(cmdOpts.memberId, cmdOpts.taskId);
      if (!task) {
        output({ ok: true, claimed: null }, rootOpts.format, () => 'No claimable task right now.');
        return;
      }
      output(task, rootOpts.format, (d) => {
        const t = d as typeof task;
        return `Claimed task ${t!.id}\n  title: ${t!.title}\n  description: ${t!.description}`;
      });
    });

  task.command('complete')
    .argument('<teamId>', 'Team ID')
    .requiredOption('--task-id <id>', 'Task ID')
    .option('--result <text>', 'Optional output / summary string')
    .description('Mark a task as completed. Dependent tasks become unblocked on next claim.')
    .action(async function (
      this: Command,
      teamId: string,
      cmdOpts: { taskId: string; result?: string },
    ) {
      const rootOpts = getRootOpts(this);
      const runtime = getTeam(teamId);
      if (!runtime) errorOutput(`Team not found: ${teamId}`);

      const task = await runtime!.taskList.complete(cmdOpts.taskId, cmdOpts.result);
      if (!task) {
        errorOutput(`Task ${cmdOpts.taskId} could not be completed (not in_progress, or not found)`);
      }
      output(task!, rootOpts.format, (d) => {
        const t = d as typeof task;
        return `Completed task ${t!.id}: ${t!.title}`;
      });
    });

  task.command('list')
    .argument('<teamId>', 'Team ID')
    .option('--status <status>', 'Filter: pending | in_progress | completed | failed')
    .description('List tasks in the team')
    .action(async function (
      this: Command,
      teamId: string,
      cmdOpts: { status?: 'pending' | 'in_progress' | 'completed' | 'failed' },
    ) {
      const rootOpts = getRootOpts(this);
      const runtime = getTeam(teamId);
      if (!runtime) errorOutput(`Team not found: ${teamId}`);

      const tasks = cmdOpts.status
        ? runtime!.taskList.getByStatus(cmdOpts.status)
        : runtime!.taskList.getAll();

      output(tasks, rootOpts.format, (d) => {
        const items = d as typeof tasks;
        if (items.length === 0) return 'No tasks.';
        const lines = items.map((t) => {
          const assn = t.assignee ?? '-';
          const deps = t.deps.length > 0 ? ` deps=[${t.deps.join(',')}]` : '';
          return `  ${statusGlyph(t.status)} ${t.id}  ${t.status}  assignee=${assn}  ${t.title}${deps}`;
        });
        return `Tasks (${items.length}):\n${lines.join('\n')}`;
      });
    });

  // ─── team msg <subcommand> ────────────────────────────────────────
  const msg = team.command('msg').description('Inter-member mailbox (persists across PTY restarts)');

  msg.command('send')
    .argument('<teamId>', 'Team ID')
    .requiredOption('--from <memberId>', 'Sender member id')
    .requiredOption('--to <memberId>', 'Recipient member id, or "*" to broadcast')
    .requiredOption('--content <text>', 'Message body')
    .option('--type <type>', 'Message type: message | broadcast | shutdown_request', 'message')
    .description('Append a message to a member\'s inbox (or broadcast to the team).')
    .action(async function (
      this: Command,
      teamId: string,
      cmdOpts: { from: string; to: string; content: string; type: string },
    ) {
      const rootOpts = getRootOpts(this);
      if (!hasMember(teamId, cmdOpts.from)) {
        errorOutput(`Sender ${cmdOpts.from} does not belong to team ${teamId}`);
      }
      if (cmdOpts.to !== '*' && !hasMember(teamId, cmdOpts.to)) {
        errorOutput(`Recipient ${cmdOpts.to} does not belong to team ${teamId}`);
      }
      const validTypes = ['message', 'broadcast', 'shutdown_request'];
      if (!validTypes.includes(cmdOpts.type)) {
        errorOutput(`Invalid --type "${cmdOpts.type}". Must be: ${validTypes.join(', ')}`);
      }
      const runtime = getTeam(teamId)!;

      const sent = runtime.mailbox.send(
        cmdOpts.from,
        cmdOpts.to,
        cmdOpts.type as 'message' | 'broadcast' | 'shutdown_request',
        cmdOpts.content,
      );
      output({ ok: true, messageId: sent.id }, rootOpts.format, (d) => {
        const r = d as { messageId: string };
        return `Sent message ${r.messageId}`;
      });
    });

  msg.command('read')
    .argument('<teamId>', 'Team ID')
    .requiredOption('--member-id <id>', 'Member whose inbox to drain')
    .description('Read and mark-as-read all unread messages for a member.')
    .action(async function (this: Command, teamId: string, cmdOpts: { memberId: string }) {
      const rootOpts = getRootOpts(this);
      if (!hasMember(teamId, cmdOpts.memberId)) {
        errorOutput(`Member ${cmdOpts.memberId} does not belong to team ${teamId}`);
      }
      const runtime = getTeam(teamId)!;

      const messages = runtime.mailbox.readUnread(cmdOpts.memberId);
      output({ count: messages.length, messages }, rootOpts.format, (d) => {
        const r = d as { count: number; messages: typeof messages };
        if (r.count === 0) return 'No unread messages.';
        const lines = r.messages.map(
          (m) => `  [${new Date(m.timestamp).toISOString()}] ${m.from} → ${m.to} (${m.type}): ${m.content}`,
        );
        return `Unread messages (${r.count}):\n${lines.join('\n')}`;
      });
    });
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'pending':
      return '☐';
    case 'in_progress':
      return '▶';
    case 'completed':
      return '☑';
    case 'failed':
      return '✗';
    default:
      return '·';
  }
}
