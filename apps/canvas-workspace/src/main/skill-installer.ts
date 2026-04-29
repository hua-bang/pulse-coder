import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SKILL_ROOTS = [
  join(homedir(), '.pulse-coder', 'skills'),
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.codex', 'skills'),
];

const CANVAS_SKILL_CONTENT = `---
name: canvas
description: Operate Pulse Canvas workspaces — read user-curated context, write results, create nodes
version: 1.0.0
---

# Pulse Canvas

Interact with canvas workspaces via the \`pulse-canvas\` CLI. The canvas is a shared workspace between humans and agents.

The current workspace ID is available via \`$PULSE_CANVAS_WORKSPACE_ID\` environment variable (auto-set by canvas). All \`node\` and \`context\` commands use it automatically — no need to pass workspace ID explicitly.

## Core Commands

### Read workspace context (start here)
\`\`\`bash
pulse-canvas context --format json
\`\`\`
Returns all nodes with structured info: file paths, frame groups, labels.

### List nodes
\`\`\`bash
pulse-canvas node list --format json
\`\`\`

### Read a node
\`\`\`bash
pulse-canvas node read <nodeId> --format json
\`\`\`

### Write to a node
\`\`\`bash
pulse-canvas node write <nodeId> --content "..."
\`\`\`

### Create a node
\`\`\`bash
pulse-canvas node create --type file --title "Report" --data '{"content":"..."}'
\`\`\`

### Create an edge (connection between nodes)
\`\`\`bash
pulse-canvas edge create --from <nodeId> --to <nodeId> --label "depends on" --kind dependency --format json
\`\`\`

### List edges
\`\`\`bash
pulse-canvas edge list --format json
\`\`\`

### Delete an edge
\`\`\`bash
pulse-canvas edge delete <edgeId> --format json
\`\`\`

### List workspaces
\`\`\`bash
pulse-canvas workspace list --format json
\`\`\`

## Usage Principles
- Before starting a task, run \`context\` to understand the user's canvas layout and intent
- Files on the canvas = files the user considers important — prioritize them
- Frame groups = file associations — understand files in the same group together
- Edges = relationships — understand how frames and nodes connect to each other
- After completing work, write results back to the canvas for the user to review
`;

// Mirror of packages/canvas-cli/skills/team/SKILL.md. Kept inline (rather
// than read from the package's skills/ dir at runtime) for the same
// reason CANVAS_SKILL_CONTENT is inline: packaged Electron builds don't
// give the main process direct fs access to bundled package resources,
// and shipping the file twice — once in the canvas-cli package, once
// here — is the simplest fix until we wire up an asset pipeline. If
// you edit one, edit the other.
const TEAM_SKILL_CONTENT = `---
name: team
description: Coordinate as part of an agent team — claim tasks, send messages, report completion
version: 1.0.0
---

# Pulse Canvas — Agent Team Coordination

You are working as part of an agent team on a shared canvas. Multiple agents (yourself included) coordinate through file-backed task lists and mailboxes managed by \`pulse-canvas team\` subcommands.

## Your team identity (always set before starting)

If you were spawned as a team member, your initial prompt told you your team identity. Confirm it:

\`\`\`
$PULSE_TEAM_ID      → the team UUID
$PULSE_TEAM_MEMBER  → your member id (e.g. "abc123-m2")
$PULSE_TEAM_ROLE    → "lead" or "teammate"
\`\`\`

If any are missing, you are NOT a team member yet — STOP and ask the user how you should fit into the team. Do not invent member ids.

## Core protocol

Every team has two persistent stores under \`~/.pulse-coder/teams/{teamId}/\`:

| Store | What | Who reads | Who writes |
|-------|------|-----------|-----------|
| \`tasks/tasks.json\` | Shared task list (with deps, status, assignee) | All members | All members (file-locked) |
| \`mailbox/{memberId}.json\` | Per-member inbox | The owning member | Anyone in the team |

**Always operate via the CLI, never edit these JSON files directly** — the CLI applies file locks and validates membership; raw edits will corrupt state and may be rejected by other members' next read.

## Commands

### See team state
\`\`\`bash
pulse-canvas team status $PULSE_TEAM_ID
\`\`\`

### Read your inbox (do this every loop iteration)
\`\`\`bash
pulse-canvas team msg read $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER --format json
\`\`\`

### Send a message to a teammate
\`\`\`bash
pulse-canvas team msg send $PULSE_TEAM_ID --from $PULSE_TEAM_MEMBER --to <other-member-id> --content "T2 done"
\`\`\`
Use \`--to "*"\` to broadcast.

### List / claim / complete tasks
\`\`\`bash
pulse-canvas team task list $PULSE_TEAM_ID --status pending --format json
pulse-canvas team task claim $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER --format json
pulse-canvas team task complete $PULSE_TEAM_ID --task-id <id> --result "..."
\`\`\`

### Lead-only: create tasks
\`\`\`bash
pulse-canvas team task create $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER \\
  --title "..." --description "..." --assignee <id> --deps a,b
\`\`\`

## Workflow — TEAMMATE

\`\`\`
loop:
  1. msg read           → handle messages first
  2. task claim         → grab next available task
     - null + all done → broadcast "I'm done", exit
     - null + others working → sleep 5s, retry
  3. do the work        → use file tools (read, edit, bash)
  4. task complete      → mark done with a short result
  5. msg send to lead   → "T<x> done"
  6. goto 1
\`\`\`

## Workflow — LEAD

\`\`\`
loop:
  1. team status        → dashboard
  2. msg read           → handle teammate updates
  3. decide:
     - new task? → task create
     - all done? → synthesize, broadcast shutdown_request, exit
  4. sleep 5s, goto 1
\`\`\`

DO NOT do teammates' work yourself. Coordinate.

## Anti-patterns

- ❌ Polling tighter than 5s (waste + lock contention)
- ❌ Editing ~/.pulse-coder/teams/ files directly (use CLI for locks)
- ❌ Sending broadcast status updates ("Starting T1!") — task list shows that
- ❌ Ignoring shutdown_request mailbox messages
`;

interface SkillSpec {
  /** Subdirectory name under each skill root (e.g. "canvas", "team"). */
  name: string;
  /** SKILL.md body to write. */
  content: string;
}

const SKILLS: SkillSpec[] = [
  { name: 'canvas', content: CANVAS_SKILL_CONTENT },
  { name: 'team', content: TEAM_SKILL_CONTENT },
];

/** Install one SKILL.md into every per-host skill root. Aggregates the
 *  written paths and reports the first error encountered. */
async function installSkill(spec: SkillSpec): Promise<{ ok: boolean; paths: string[]; error?: string }> {
  const installed: string[] = [];
  try {
    for (const root of SKILL_ROOTS) {
      const dir = join(root, spec.name);
      await fs.mkdir(dir, { recursive: true });
      const targetPath = join(dir, 'SKILL.md');
      await fs.writeFile(targetPath, spec.content, 'utf-8');
      installed.push(targetPath);
    }
    return { ok: true, paths: installed };
  } catch (err) {
    return { ok: false, paths: installed, error: String(err) };
  }
}

export function setupSkillInstallerIpc(): void {
  ipcMain.handle('skills:install', async () => {
    const results: Array<{ ok: boolean; paths: string[]; error?: string; name: string }> = [];
    for (const spec of SKILLS) {
      const r = await installSkill(spec);
      results.push({ ...r, name: spec.name });
      if (!r.ok) {
        // Bail on first failure — we don't want to half-install and
        // leave the user wondering which skills are real.
        return {
          ok: false,
          skillsInstalled: false,
          cliInstalled: false,
          error: `Failed installing skill "${spec.name}": ${r.error}`,
          manualCommand: null,
        };
      }
    }

    // CLI is not published yet — provide local build instructions.
    return {
      ok: true,
      skillsInstalled: true,
      skillsPaths: results.flatMap((r) => r.paths),
      installedSkills: results.map((r) => r.name),
      cliInstalled: false,
      manualCommand:
        'cd <project-root> && pnpm --filter @pulse-coder/canvas-cli build && pnpm link --global --filter @pulse-coder/canvas-cli',
      cliError: null,
    };
  });
}
