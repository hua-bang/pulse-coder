export interface AgentDef {
  id: string;
  label: string;
  command: string;
  description: string;
  /**
   * CLI flag string that puts the agent into "no permission prompts"
   * mode — used by team workflows where pausing for every shell action
   * would block the coordination loop. Empty string for agents that have
   * no equivalent (and don't need one).
   *
   * Note these bypass guardrails the agent vendors put in for a reason:
   * only inject them when the user explicitly asked for unattended team
   * execution (e.g. via `canvas_create_team`).
   */
  unattendedFlags: string;
}

export const AGENT_REGISTRY: AgentDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    description: 'Anthropic',
    // `--permission-mode bypassPermissions` is the modern, single-flag
    // way to silence per-tool prompts. Newer Claude Code versions
    // require `--allow-dangerously-skip-permissions` BEFORE the legacy
    // `--dangerously-skip-permissions` would take effect, so the legacy
    // flag alone no longer works.
    unattendedFlags: '--permission-mode bypassPermissions',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    description: 'OpenAI',
    // --full-auto = "-a on-request --sandbox workspace-write" per
    // `codex --help`. Lets the agent execute shell + edit files in
    // its cwd without asking, while keeping it sandboxed away from
    // the rest of the disk.
    unattendedFlags: '--full-auto',
  },
  {
    id: 'pulse-coder',
    label: 'Pulse Coder',
    command: 'pulse-coder',
    description: 'Pulse',
    // pulse-coder doesn't gate tool use behind an interactive prompt,
    // so no flag is needed.
    unattendedFlags: '',
  },
];

export const getAgentCommand = (agentType: string): string | undefined =>
  AGENT_REGISTRY.find(a => a.id === agentType)?.command;

export const getUnattendedFlags = (agentType: string): string =>
  AGENT_REGISTRY.find(a => a.id === agentType)?.unattendedFlags ?? '';
