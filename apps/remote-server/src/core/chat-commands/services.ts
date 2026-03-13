import { engine } from '../engine-singleton.js';
import type { SkillRegistryService, SoulService } from './types.js';

export function getSkillRegistry(): SkillRegistryService | undefined {
  return engine.getService<SkillRegistryService>('skillRegistry');
}

export function getSoulService(): SoulService | undefined {
  return engine.getService<SoulService>('soulService');
}
