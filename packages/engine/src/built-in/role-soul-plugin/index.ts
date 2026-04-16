import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { globSync } from 'glob';
import matter from 'gray-matter';
import { z } from 'zod';

import type { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin.js';
import type { SystemPromptOption } from '../../shared/types.js';
import type { Tool } from '../../shared/types.js';

export interface SoulDefinition {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  location: string;
  metadata?: Record<string, any>;
}

export interface SoulState {
  sessionId: string;
  activeSoulIds: string[];
  primarySoulId?: string;
  updatedAt: number;
}

export interface SoulActionResult {
  ok: boolean;
  reason?: string;
  state?: SoulState;
  soul?: SoulDefinition;
}

export interface SoulService {
  initialize(): Promise<void>;
  listSouls(): SoulDefinition[];
  getSoul(id: string): SoulDefinition | undefined;
  getState(sessionId: string): Promise<SoulState | undefined>;
  useSoul(sessionId: string, soulId: string): Promise<SoulActionResult>;
  addSoul(sessionId: string, soulId: string): Promise<SoulActionResult>;
  removeSoul(sessionId: string, soulId: string): Promise<SoulActionResult>;
  clearSession(sessionId: string): Promise<{ ok: boolean; reason?: string }>;
  cloneState(fromSessionId: string, toSessionId: string): Promise<{ ok: boolean; reason?: string }>;
  buildPromptAppend(sessionId: string): Promise<string | null>;
}

const DEFAULT_SOUL_BASE_DIR = path.join(homedir(), '.pulse-coder', 'souls');
const DEFAULT_STATE_DIR = path.join(DEFAULT_SOUL_BASE_DIR, 'state');
const DEFAULT_STATE_DEBOUNCE_MS = 250;


const SOUL_REGISTER_INPUT_SCHEMA = z.object({
  id: z.string().min(1).describe('Soul id (unique key).'),
  name: z.string().min(1).describe('Soul display name.'),
  description: z.string().optional().describe('Short description.'),
  prompt: z.string().min(1).describe('Soul system prompt.'),
});

const SOUL_LIST_INPUT_SCHEMA = z.object({
  format: z.enum(['summary', 'full']).optional().describe('Output format. Defaults to summary.'),
});

const SOUL_STATUS_INPUT_SCHEMA = z.object({
  sessionId: z.string().min(1).optional().describe('Session id. Defaults to tool runContext.sessionId.'),
});

const SOUL_USE_INPUT_SCHEMA = z.object({
  soulId: z.string().min(1).describe('Soul id to set as primary.'),
  sessionId: z.string().min(1).optional().describe('Session id. Defaults to tool runContext.sessionId.'),
});

const SOUL_ADD_INPUT_SCHEMA = z.object({
  soulId: z.string().min(1).describe('Soul id to append.'),
  sessionId: z.string().min(1).optional().describe('Session id. Defaults to tool runContext.sessionId.'),
});

const SOUL_REMOVE_INPUT_SCHEMA = z.object({
  soulId: z.string().min(1).describe('Soul id to remove.'),
  sessionId: z.string().min(1).optional().describe('Session id. Defaults to tool runContext.sessionId.'),
});

const SOUL_CLEAR_INPUT_SCHEMA = z.object({
  sessionId: z.string().min(1).optional().describe('Session id. Defaults to tool runContext.sessionId.'),
});

function normalizeSoulKey(value: string): string {
  return value.trim().toLowerCase();
}

function now(): number {
  return Date.now();
}

function soulDirNameFromId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`invalid soul id for persistence path: ${id}`);
  }
  return trimmed;
}

function buildPersistedSoulContent(soul: SoulDefinition): string {
  const frontMatterLines = [
    '---',
    `id: ${JSON.stringify(soul.id)}`,
    `name: ${JSON.stringify(soul.name)}`,
  ];

  if (soul.description) {
    frontMatterLines.push(`description: ${JSON.stringify(soul.description)}`);
  }

  frontMatterLines.push('---');

  return `${frontMatterLines.join('\n')}\n\n${soul.prompt.trim()}\n`;
}

function appendSystemPrompt(base: SystemPromptOption | undefined, append: string): SystemPromptOption {
  const normalizedAppend = append.trim();
  if (!normalizedAppend) {
    return base ?? { append: '' };
  }

  if (!base) {
    return { append: normalizedAppend };
  }

  if (typeof base === 'string') {
    return `${base}\n\n${normalizedAppend}`;
  }

  if (typeof base === 'function') {
    return () => `${base()}\n\n${normalizedAppend}`;
  }

  const currentAppend = base.append.trim();
  return {
    append: currentAppend ? `${currentAppend}\n\n${normalizedAppend}` : normalizedAppend,
  };
}

function describeSoul(soul: SoulDefinition): Record<string, any> {
  return {
    id: soul.id,
    name: soul.name,
    description: soul.description,
    prompt: soul.prompt,
    location: soul.location,
  };
}

function summarizeSoul(soul: SoulDefinition): Record<string, any> {
  return {
    id: soul.id,
    name: soul.name,
    description: soul.description,
  };
}

function resolveSessionId(input: { sessionId?: string }, runContext?: Record<string, any>): string | null {
  const candidate = input.sessionId ?? runContext?.sessionId ?? runContext?.session_id;
  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmed = candidate.trim();
  return trimmed ? trimmed : null;
}

class SoulRegistry {
  private souls = new Map<string, SoulDefinition>();
  private initialized = false;

  async initialize(cwd: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    const soulList = await this.scanSouls(cwd);
    this.souls.clear();

    for (const soul of soulList) {
      this.registerSoul(soul);
    }

    this.initialized = true;
  }

  getAll(): SoulDefinition[] {
    return Array.from(this.souls.values());
  }

  get(id: string): SoulDefinition | undefined {
    return this.souls.get(normalizeSoulKey(id));
  }

  registerSoul(soul: SoulDefinition): { soulId: string; replaced: boolean; total: number } {
    const key = normalizeSoulKey(soul.id);
    const replaced = this.souls.has(key);
    this.souls.set(key, soul);

    return {
      soulId: soul.id,
      replaced,
      total: this.souls.size,
    };
  }

  private async scanSouls(cwd: string): Promise<SoulDefinition[]> {
    const souls: SoulDefinition[] = [];

    const scanPaths = [
      { base: cwd, pattern: '.pulse-coder/souls/**/SOUL.md' },
      { base: cwd, pattern: '.agents/souls/**/SOUL.md' },
      { base: cwd, pattern: '.coder/souls/**/SOUL.md' },
      { base: homedir(), pattern: '.pulse-coder/souls/**/SOUL.md' },
      { base: homedir(), pattern: '.agents/souls/**/SOUL.md' },
      { base: homedir(), pattern: '.coder/souls/**/SOUL.md' },
    ];

    for (const { base, pattern } of scanPaths) {
      try {
        const files = globSync(pattern, { cwd: base, absolute: true });
        for (const filePath of files) {
          const soul = this.parseSoulFile(filePath);
          if (soul) {
            souls.push(soul);
          }
        }
      } catch {
        continue;
      }
    }

    return souls;
  }

  private parseSoulFile(filePath: string): SoulDefinition | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = matter(content);
      const metadata = parsed.data as Record<string, any>;
      const prompt = parsed.content.trim();

      const id = String(metadata.id ?? metadata.name ?? path.basename(filePath, '.md')).trim();
      if (!id) {
        return null;
      }

      const name = String(metadata.name ?? id).trim();
      if (!prompt) {
        return null;
      }

      return {
        id,
        name,
        description: metadata.description ? String(metadata.description).trim() : undefined,
        prompt,
        location: filePath,
        metadata,
      };
    } catch {
      return null;
    }
  }
}

class SoulStateStore {
  private baseDir: string;
  private sessionsDir: string;
  private writeTimers = new Map<string, NodeJS.Timeout>();
  private pendingStates = new Map<string, SoulState>();
  private enabled: boolean;

  constructor(options?: { baseDir?: string; enabled?: boolean }) {
    this.baseDir = options?.baseDir ?? DEFAULT_STATE_DIR;
    this.sessionsDir = path.join(this.baseDir, 'sessions');
    this.enabled = options?.enabled ?? true;
  }

  async initialize(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  async load(sessionId: string): Promise<SoulState | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const raw = await fs.readFile(this.sessionPath(sessionId), 'utf-8');
      const parsed = JSON.parse(raw) as SoulState;
      if (!parsed || parsed.sessionId !== sessionId) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  scheduleSave(state: SoulState): void {
    if (!this.enabled) {
      return;
    }

    this.pendingStates.set(state.sessionId, state);
    if (this.writeTimers.has(state.sessionId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.writeTimers.delete(state.sessionId);
      const latest = this.pendingStates.get(state.sessionId);
      this.pendingStates.delete(state.sessionId);
      if (latest) {
        void this.persist(latest);
      }
    }, DEFAULT_STATE_DEBOUNCE_MS);

    this.writeTimers.set(state.sessionId, timer);
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const timer = this.writeTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.writeTimers.delete(sessionId);
    }
    this.pendingStates.delete(sessionId);

    try {
      await fs.unlink(this.sessionPath(sessionId));
    } catch {
      return;
    }
  }

  private async persist(state: SoulState): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.writeFile(this.sessionPath(state.sessionId), JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      return;
    }
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }
}

class BuiltInSoulService implements SoulService {
  private registry = new SoulRegistry();
  private stateStore: SoulStateStore;
  private persistEnabled: boolean;
  private states = new Map<string, SoulState>();
  private loadedSessions = new Set<string>();
  private logger: EnginePluginContext['logger'];

  constructor(logger: EnginePluginContext['logger']) {
    const stateDir = process.env.PULSE_CODER_SOUL_STATE_DIR?.trim();
    const enabled = process.env.PULSE_CODER_SOUL_PERSIST?.trim() !== '0';

    this.stateStore = new SoulStateStore({
      baseDir: stateDir || undefined,
      enabled,
    });
    this.persistEnabled = enabled;
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    await this.registry.initialize(process.cwd());
    await this.stateStore.initialize();
  }

  listSouls(): SoulDefinition[] {
    return this.registry.getAll();
  }

  getSoul(id: string): SoulDefinition | undefined {
    return this.registry.get(id);
  }

  async getState(sessionId: string): Promise<SoulState | undefined> {
    await this.ensureLoaded(sessionId);
    return this.states.get(sessionId);
  }

  async useSoul(sessionId: string, soulId: string): Promise<SoulActionResult> {
    return this.setSoulState(sessionId, soulId, 'replace');
  }

  async addSoul(sessionId: string, soulId: string): Promise<SoulActionResult> {
    return this.setSoulState(sessionId, soulId, 'append');
  }

  async removeSoul(sessionId: string, soulId: string): Promise<SoulActionResult> {
    await this.ensureLoaded(sessionId);
    const state = this.states.get(sessionId);
    if (!state || state.activeSoulIds.length === 0) {
      return { ok: false, reason: '当前会话没有启用任何 soul' };
    }

    const targetKey = normalizeSoulKey(soulId);
    const nextIds = state.activeSoulIds.filter((id) => normalizeSoulKey(id) !== targetKey);
    if (nextIds.length === state.activeSoulIds.length) {
      return { ok: false, reason: `未找到 soul: ${soulId}` };
    }

    const primary = state.primarySoulId && normalizeSoulKey(state.primarySoulId) === targetKey
      ? nextIds[0]
      : state.primarySoulId;

    const nextState: SoulState = {
      ...state,
      activeSoulIds: nextIds,
      primarySoulId: primary,
      updatedAt: now(),
    };

    this.states.set(sessionId, nextState);
    this.stateStore.scheduleSave(nextState);

    return { ok: true, state: nextState };
  }

  async clearSession(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    this.states.delete(sessionId);
    this.loadedSessions.add(sessionId);
    await this.stateStore.remove(sessionId);
    return { ok: true };
  }

  async cloneState(fromSessionId: string, toSessionId: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ensureLoaded(fromSessionId);
    const state = this.states.get(fromSessionId);
    if (!state || state.activeSoulIds.length === 0) {
      await this.clearSession(toSessionId);
      return { ok: true };
    }

    const nextState: SoulState = {
      sessionId: toSessionId,
      activeSoulIds: [...state.activeSoulIds],
      primarySoulId: state.primarySoulId,
      updatedAt: now(),
    };

    this.states.set(toSessionId, nextState);
    this.loadedSessions.add(toSessionId);
    this.stateStore.scheduleSave(nextState);
    return { ok: true };
  }

  async buildPromptAppend(sessionId: string): Promise<string | null> {
    await this.ensureLoaded(sessionId);
    const state = this.states.get(sessionId);
    if (!state || state.activeSoulIds.length === 0) {
      return null;
    }

    const souls: SoulDefinition[] = [];
    for (const id of state.activeSoulIds) {
      const soul = this.registry.get(id);
      if (soul) {
        souls.push(soul);
      }
    }

    if (souls.length === 0) {
      return null;
    }

    const lines: string[] = ['## Role Soul'];
    for (const soul of souls) {
      lines.push(`### ${soul.name}`);
      lines.push(soul.prompt.trim());
    }

    return lines.join('\n');
  }

  async registerSoul(input: { id: string; name: string; description?: string; prompt: string }): Promise<SoulDefinition> {
    const soul: SoulDefinition = {
      id: input.id.trim(),
      name: input.name.trim(),
      description: input.description?.trim(),
      prompt: input.prompt.trim(),
      location: 'runtime',
      metadata: { source: 'runtime' },
    };

    this.registry.registerSoul(soul);
    await this.persistRuntimeSoulAsFile(soul);
    return soul;
  }

  private async persistRuntimeSoulAsFile(soul: SoulDefinition): Promise<void> {
    if (!this.persistEnabled) {
      return;
    }

    const soulDirName = soulDirNameFromId(soul.id);
    const soulDir = path.join(DEFAULT_SOUL_BASE_DIR, soulDirName);
    const soulFile = path.join(soulDir, 'SOUL.md');
    const content = buildPersistedSoulContent(soul);

    await fs.mkdir(soulDir, { recursive: true });
    await fs.writeFile(soulFile, content, 'utf-8');

    this.logger.info('[RoleSoul] Persisted registered soul to SOUL.md', {
      soulId: soul.id,
      soulFile,
    });
  }

  private async setSoulState(
    sessionId: string,
    soulId: string,
    mode: 'replace' | 'append',
  ): Promise<SoulActionResult> {
    await this.ensureLoaded(sessionId);
    const soul = this.registry.get(soulId);
    if (!soul) {
      return { ok: false, reason: `未找到 soul: ${soulId}` };
    }

    const current = this.states.get(sessionId);
    const nextIds = current?.activeSoulIds ? [...current.activeSoulIds] : [];
    const targetKey = normalizeSoulKey(soul.id);

    if (mode === 'replace') {
      nextIds.length = 0;
      nextIds.push(soul.id);
    } else if (!nextIds.some((id) => normalizeSoulKey(id) === targetKey)) {
      nextIds.push(soul.id);
    }

    const nextState: SoulState = {
      sessionId,
      activeSoulIds: nextIds,
      primarySoulId: mode === 'replace' ? soul.id : (current?.primarySoulId ?? soul.id),
      updatedAt: now(),
    };

    this.states.set(sessionId, nextState);
    this.stateStore.scheduleSave(nextState);

    return { ok: true, state: nextState, soul };
  }

  private async ensureLoaded(sessionId: string): Promise<void> {
    if (this.loadedSessions.has(sessionId)) {
      return;
    }

    this.loadedSessions.add(sessionId);
    const stored = await this.stateStore.load(sessionId);
    if (stored) {
      this.states.set(sessionId, stored);
      return;
    }

    if (!this.states.has(sessionId)) {
      this.states.set(sessionId, {
        sessionId,
        activeSoulIds: [],
        updatedAt: now(),
      });
    }
  }
}

export const builtInRoleSoulPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-role-soul',
  version: '0.1.0',

  async initialize(context: EnginePluginContext): Promise<void> {
    const service = new BuiltInSoulService(context.logger);
    await service.initialize();

    context.registerService('soulService', service);

    context.registerTools({
      soul_list: buildSoulListTool(service),
      soul_status: buildSoulStatusTool(service),
      soul_use: buildSoulUseTool(service),
      soul_add: buildSoulAddTool(service),
      soul_remove: buildSoulRemoveTool(service),
      soul_clear: buildSoulClearTool(service),
      soul_register: buildSoulRegisterTool(service),
    });

    context.registerHook('beforeRun', async ({ systemPrompt, runContext }) => {
      const sessionId = typeof runContext?.sessionId === 'string'
        ? runContext.sessionId
        : (typeof runContext?.session_id === 'string' ? runContext.session_id : undefined);

      if (!sessionId) {
        return;
      }

      try {
        const append = await service.buildPromptAppend(sessionId);
        if (!append) {
          return;
        }
        return { systemPrompt: appendSystemPrompt(systemPrompt, append) };
      } catch (error) {
        context.logger.warn('[RoleSoul] Failed to build prompt append', error as Error);
        return;
      }
    });

    context.logger.info('[RoleSoul] Built-in role soul plugin initialized', {
      souls: service.listSouls().length,
    });
  },
};

function buildSoulListTool(service: BuiltInSoulService): Tool {
  return {
    name: 'soul_list',
    description: 'List available souls.',
    defer_loading: true,
    inputSchema: SOUL_LIST_INPUT_SCHEMA,
    execute: async (input) => {
      const format = input.format ?? 'summary';
      const list = service.listSouls();
      return format === 'full'
        ? list.map((soul) => describeSoul(soul))
        : list.map((soul) => summarizeSoul(soul));
    },
  };
}

function buildSoulStatusTool(service: BuiltInSoulService): Tool {
  return {
    name: 'soul_status',
    description: 'Get soul state for the current session.',
    defer_loading: true,
    inputSchema: SOUL_STATUS_INPUT_SCHEMA,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input, context?.runContext);
      if (!sessionId) {
        throw new Error('sessionId is required to read soul state');
      }

      const state = await service.getState(sessionId);
      return {
        sessionId,
        state: state ?? null,
      };
    },
  };
}

function buildSoulUseTool(service: BuiltInSoulService): Tool {
  return {
    name: 'soul_use',
    description: 'Replace active souls with the specified soul.',
    defer_loading: true,
    inputSchema: SOUL_USE_INPUT_SCHEMA,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input, context?.runContext);
      if (!sessionId) {
        throw new Error('sessionId is required to update soul state');
      }

      return await service.useSoul(sessionId, input.soulId);
    },
  };
}

function buildSoulAddTool(service: BuiltInSoulService): Tool {
  return {
    name: 'soul_add',
    description: 'Add a soul to the active list for the current session.',
    defer_loading: true,
    inputSchema: SOUL_ADD_INPUT_SCHEMA,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input, context?.runContext);
      if (!sessionId) {
        throw new Error('sessionId is required to update soul state');
      }

      return await service.addSoul(sessionId, input.soulId);
    },
  };
}

function buildSoulRemoveTool(service: BuiltInSoulService): Tool {
  return {
    name: 'soul_remove',
    description: 'Remove a soul from the active list for the current session.',
    defer_loading: true,
    inputSchema: SOUL_REMOVE_INPUT_SCHEMA,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input, context?.runContext);
      if (!sessionId) {
        throw new Error('sessionId is required to update soul state');
      }

      return await service.removeSoul(sessionId, input.soulId);
    },
  };
}

function buildSoulClearTool(service: BuiltInSoulService): Tool {
  return {
    name: 'soul_clear',
    description: 'Clear soul state for the current session.',
    defer_loading: true,
    inputSchema: SOUL_CLEAR_INPUT_SCHEMA,
    execute: async (input, context) => {
      const sessionId = resolveSessionId(input, context?.runContext);
      if (!sessionId) {
        throw new Error('sessionId is required to clear soul state');
      }

      return await service.clearSession(sessionId);
    },
  };
}

function buildSoulRegisterTool(service: BuiltInSoulService): Tool {
  return {
    name: 'soul_register',
    description: 'Register or replace a soul definition. Persists to ~/.pulse-coder/souls/<id>/SOUL.md when enabled.',
    defer_loading: true,
    inputSchema: SOUL_REGISTER_INPUT_SCHEMA,
    execute: async (input) => {
      const soul = await service.registerSoul({
        id: input.id,
        name: input.name,
        description: input.description,
        prompt: input.prompt,
      });

      return {
        ok: true,
        soul: summarizeSoul(soul),
      };
    },
  };
}

export default builtInRoleSoulPlugin;
