export const COMMANDS_ALLOWED_WHILE_RUNNING = new Set([
  'help',
  'start',
  'status',
  'stop',
  'restart',
  'current',
  'ping',
  'memory',
  'mode',
  'fork',
  'merge',
  'wt',
  'insight',
  'model',
  'skill',
  'soul',
  'acp',
]);

export const COMMAND_ALIASES: Record<string, string> = {
  '?': 'help',
  h: 'help',
  reset: 'clear',
  cancel: 'stop',
  halt: 'stop',
  ls: 'sessions',
  session: 'current',
  mem: 'memory',
  clone: 'fork',
  link: 'merge',
  unlink: 'merge',
  role: 'soul',
};

export function normalizeCommand(command: string): string {
  return COMMAND_ALIASES[command] ?? command;
}
