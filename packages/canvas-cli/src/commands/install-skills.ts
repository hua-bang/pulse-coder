import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Command } from 'commander';
import { output, type OutputFormat } from '../output';

const SKILLS_DIR = join(homedir(), '.pulse-coder', 'skills', 'canvas');

export async function installSkills(targetDir?: string): Promise<{ ok: boolean; path: string; error?: string }> {
  const dir = targetDir ?? SKILLS_DIR;
  try {
    await fs.mkdir(dir, { recursive: true });

    // Read the bundled SKILL.md from the package
    const skillSource = join(__dirname, '..', 'skills', 'canvas', 'SKILL.md');
    let skillContent: string;
    try {
      skillContent = await fs.readFile(skillSource, 'utf-8');
    } catch {
      // Fallback: inline skill content if the file isn't found (e.g. during development)
      skillContent = getInlineSkillContent();
    }

    const targetPath = join(dir, 'SKILL.md');
    await fs.writeFile(targetPath, skillContent, 'utf-8');
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, path: dir, error: String(err) };
  }
}

function getInlineSkillContent(): string {
  return `---
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
}

export function registerInstallSkillsCommand(program: Command): void {
  program
    .command('install-skills')
    .option('--dir <path>', 'Custom target directory for skills')
    .description('Install canvas skills for agent discovery')
    .action(async function (this: Command, cmdOpts: { dir?: string }) {
      const root = this.parent;
      const format: OutputFormat = root?.opts()?.format ?? 'text';

      const result = await installSkills(cmdOpts.dir);
      if (!result.ok) {
        console.error(`Failed to install skills: ${result.error}`);
        console.error(`You can manually create the file at: ${result.path}/SKILL.md`);
        process.exit(1);
      }

      output({ installed: result.path }, format, () => `Skills installed to: ${result.path}`);
    });
}
