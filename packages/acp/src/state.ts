import type { AcpChannelState } from './types.js';
import { FileAcpStateStore } from './state-store.js';

const defaultStateStore = new FileAcpStateStore();

export function getAcpState(platformKey: string) {
  return defaultStateStore.getState(platformKey);
}

export function setAcpState(platformKey: string, state: AcpChannelState) {
  return defaultStateStore.setState(platformKey, state);
}

export function clearAcpState(platformKey: string) {
  return defaultStateStore.clearState(platformKey);
}

export function updateAcpCwd(platformKey: string, cwd: string) {
  return defaultStateStore.updateCwd(platformKey, cwd);
}

export function saveAcpSessionId(platformKey: string, sessionId: string) {
  return defaultStateStore.saveSessionId(platformKey, sessionId);
}
