import { Command } from 'commander';
import { generateContext, formatContextAsText } from '../core/context';
import { output, errorOutput, type OutputFormat } from '../output';

export function registerContextCommand(program: Command): void {
  program
    .command('context')
    .description('Generate canvas context for agent consumption')
    .action(async function (this: Command) {
      const root = this.parent;
      const opts = root?.opts() ?? {};
      const format: OutputFormat = opts.format ?? 'text';
      const storeDir: string | undefined = opts.storeDir;
      const workspace: string | undefined = opts.workspace;

      if (!workspace) {
        errorOutput('Workspace ID required. Use --workspace <id> or set $PULSE_CANVAS_WORKSPACE_ID');
      }

      const ctx = await generateContext(workspace, storeDir);
      if (!ctx) errorOutput(`Workspace not found: ${workspace}`);

      output(ctx, format, (data) => formatContextAsText(data as NonNullable<typeof ctx>));
    });
}
