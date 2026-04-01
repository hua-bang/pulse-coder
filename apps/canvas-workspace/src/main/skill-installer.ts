import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SKILLS_DIR = join(homedir(), '.pulse-coder', 'skills', 'canvas');

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

async function installSkillFile(): Promise<{ ok: boolean; path: string; error?: string }> {
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const targetPath = join(SKILLS_DIR, 'SKILL.md');
    await fs.writeFile(targetPath, SKILL_CONTENT, 'utf-8');
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, path: SKILLS_DIR, error: String(err) };
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
      skillsPath: skillResult.path,
      cliInstalled: false,
      manualCommand: 'cd <project-root> && pnpm --filter @pulse-coder/canvas-cli build && pnpm link --global --filter @pulse-coder/canvas-cli',
      cliError: null,
    };
  });
}
