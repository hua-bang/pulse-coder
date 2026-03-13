export interface SkillSummary {
  name: string;
  description: string;
}

export interface SoulSummary {
  id: string;
  name: string;
  description?: string;
}

export interface SoulService {
  listSouls: () => SoulSummary[];
  getState: (sessionId: string) => Promise<{ activeSoulIds: string[] } | undefined>;
  useSoul: (sessionId: string, soulId: string) => Promise<{ ok: boolean; reason?: string }>;
  addSoul: (sessionId: string, soulId: string) => Promise<{ ok: boolean; reason?: string }>;
  removeSoul: (sessionId: string, soulId: string) => Promise<{ ok: boolean; reason?: string }>;
  clearSession: (sessionId: string) => Promise<{ ok: boolean; reason?: string }>;
  cloneState: (fromSessionId: string, toSessionId: string) => Promise<{ ok: boolean; reason?: string }>;
}

export interface SkillRegistryService {
  getAll: () => SkillSummary[];
  get: (name: string) => SkillSummary | undefined;
}

export type CommandResult =
  | { type: 'none' }
  | { type: 'handled'; message: string }
  | { type: 'handled_silent' }
  | { type: 'transformed'; text: string };
