import { join } from 'path';
import { homedir } from 'os';
import type { NodeType, NodeCapability } from './types';

export const DEFAULT_STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

export const NODE_CAPABILITIES: Record<NodeType, NodeCapability[]> = {
  file: ['read', 'write'],
  terminal: ['read', 'exec'],
  frame: ['read', 'write'],
  agent: ['read', 'exec'],
};

export const DEFAULT_NODE_DIMENSIONS: Record<NodeType, { title: string; width: number; height: number }> = {
  file: { title: 'Untitled', width: 420, height: 360 },
  terminal: { title: 'Terminal', width: 480, height: 300 },
  frame: { title: 'Frame', width: 600, height: 400 },
  agent: { title: 'Agent', width: 520, height: 380 },
};

export const AGENTS_MD_TEMPLATE = `# Canvas Agent Config

## Purpose
<!-- Describe what this workspace is for -->

## Instructions
<!-- Conventions, style, or constraints for agents working in this workspace -->

---

<!-- canvas:auto-start -->
<!-- canvas:auto-end -->
`;
