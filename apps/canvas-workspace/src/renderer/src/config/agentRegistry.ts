export interface AgentDef {
  id: string;
  label: string;
  command: string;
  description: string;
}

export const AGENT_REGISTRY: AgentDef[] = [
  { id: 'claude-code', label: 'Claude Code', command: 'claude', description: 'Anthropic Claude Code agent' },
  { id: 'codex', label: 'Codex', command: 'codex', description: 'OpenAI Codex CLI agent' },
  { id: 'pulse-coder', label: 'Pulse Coder', command: 'pulse-coder', description: 'Pulse Coder agent' },
];

export const getAgentCommand = (agentType: string): string | undefined =>
  AGENT_REGISTRY.find(a => a.id === agentType)?.command;
