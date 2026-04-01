import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const GLOBAL_SKILL_DIRS = [
  join(homedir(), '.pulse-coder', 'skills', 'canvas'),
  join(homedir(), '.claude', 'skills', 'canvas'),
  join(homedir(), '.codex', 'skills', 'canvas'),
];

const SKILL_CONTENT = `---
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

### List workspaces
\`\`\`bash
pulse-canvas workspace list --format json
\`\`\`

## Usage Principles
- Before starting a task, run \`context\` to understand the user's canvas layout and intent
- Files on the canvas = files the user considers important — prioritize them
- Frame groups = file associations — understand files in the same group together
- After completing work, write results back to the canvas for the user to review
`;

async function installSkillFile(): Promise<{ ok: boolean; paths: string[]; error?: string }> {
  const installed: string[] = [];
  try {
    for (const dir of GLOBAL_SKILL_DIRS) {
      await fs.mkdir(dir, { recursive: true });
      const targetPath = join(dir, 'SKILL.md');
      await fs.writeFile(targetPath, SKILL_CONTENT, 'utf-8');
      installed.push(targetPath);
    }
    return { ok: true, paths: installed };
  } catch (err) {
    return { ok: false, paths: installed, error: String(err) };
  }
}

export function setupSkillInstallerIpc(): void {
  ipcMain.handle('skills:install', async () => {
    const skillResult = await installSkillFile();
    if (!skillResult.ok) {
      return {
        ok: false,
        skillsInstalled: false,
        cliInstalled: false,
        error: skillResult.error,
        manualCommand: null,
      };
    }

    // CLI is not published yet — provide local build instructions
    return {
      ok: true,
      skillsInstalled: true,
      skillsPaths: skillResult.paths,
      cliInstalled: false,
      manualCommand: 'cd <project-root> && pnpm --filter @pulse-coder/canvas-cli build && pnpm link --global --filter @pulse-coder/canvas-cli',
      cliError: null,
    };
  });
}
