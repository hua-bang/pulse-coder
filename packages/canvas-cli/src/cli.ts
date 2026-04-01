import { Command } from 'commander';
import { registerWorkspaceCommands } from './commands/workspace';
import { registerNodeCommands } from './commands/node';
import { registerContextCommand } from './commands/context';
import { registerInstallSkillsCommand } from './commands/install-skills';

export const ENV_WORKSPACE_ID = 'PULSE_CANVAS_WORKSPACE_ID';

export function createCli(): Command {
  const program = new Command();

  program
    .name('pulse-canvas')
    .description('CLI for Pulse Canvas — agent communication channel for canvas workspaces')
    .version('0.0.1-alpha.1')
    .option('--format <format>', 'Output format: json or text', 'text')
    .option('--store-dir <path>', 'Canvas store directory (default: ~/.pulse-coder/canvas/)')
    .option('-w, --workspace <id>', `Workspace ID (default: $${ENV_WORKSPACE_ID})`, process.env[ENV_WORKSPACE_ID]);

  registerWorkspaceCommands(program);
  registerNodeCommands(program);
  registerContextCommand(program);
  registerInstallSkillsCommand(program);

  return program;
}
