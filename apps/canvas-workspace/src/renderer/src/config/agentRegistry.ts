export interface AgentResumeSpec {
  /** Build a fresh-start command that pre-allocates a resumable session id.
   *  The id will be persisted on the node so a later `resume(id)` call can
   *  reattach to the same logical conversation after an app restart. */
  startWithId: (id: string) => string;
  /** Build the command that resumes a previously started session by id. */
  resume: (id: string) => string;
}

export interface AgentDef {
  id: string;
  label: string;
  command: string;
  description: string;
  /** When set, the agent supports id-based session resume — the canvas
   *  will pre-allocate a UUID on first launch and reuse it after restarts
   *  instead of starting a brand-new conversation. */
  resume?: AgentResumeSpec;
}

export const AGENT_REGISTRY: AgentDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    description: 'Anthropic',
    resume: {
      startWithId: (id) => `claude --session-id ${id}`,
      resume: (id) => `claude --resume ${id}`,
    },
  },
  { id: 'codex', label: 'Codex', command: 'codex', description: 'OpenAI' },
  { id: 'pulse-coder', label: 'Pulse Coder', command: 'pulse-coder', description: 'Pulse' },
];

export const getAgentDef = (agentType: string): AgentDef | undefined =>
  AGENT_REGISTRY.find((a) => a.id === agentType);

export const getAgentCommand = (agentType: string): string | undefined =>
  AGENT_REGISTRY.find(a => a.id === agentType)?.command;
