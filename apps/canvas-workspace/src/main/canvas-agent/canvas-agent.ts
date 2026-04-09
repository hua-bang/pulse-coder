/**
 * Canvas Agent — the workspace-scoped AI Copilot.
 *
 * Uses pulse-coder-engine's Engine class to run an agentic loop with
 * canvas-specific tools + built-in filesystem tools (read, write, edit,
 * grep, ls, bash). Runs in the Electron main process.
 */

import { Engine } from 'pulse-coder-engine';
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage } from 'ai';
import { buildWorkspaceSummary, formatSummaryForPrompt } from './context-builder';
import { createCanvasTools } from './tools';
import { SessionStore } from './session-store';
import type { CanvasAgentConfig, CanvasAgentMessage, WorkspaceSummary } from './types';

// ─── System prompt ─────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are the Canvas Agent — the AI Copilot for this workspace.

## Your Role
You are the single AI entry point for this workspace. You can:
- Understand and explain everything on the canvas (files, terminals, agents, frames)
- Create, update, delete, and organize canvas nodes
- Read and write project files directly
- Run shell commands
- Generate documents, PRDs, and technical specs

## Context Strategy
Your system prompt contains a summary of all canvas nodes. For detailed content:
- Use \`canvas_read_node\` to read a specific node's full content
- Use \`canvas_read_context\` with detail="full" for everything at once

## Canvas Tools
- \`canvas_read_context\`: Read workspace overview or full context
- \`canvas_read_node\`: Read a single node's content in detail
- \`canvas_create_node\`: Create new file/terminal/frame/agent nodes
- \`canvas_update_node\`: Update existing nodes (content, title, data)
- \`canvas_delete_node\`: Remove a node from the canvas
- \`canvas_move_node\`: Reposition a node

## Filesystem Tools (built-in)
- \`read\`: Read file contents (with offset/limit support)
- \`write\`: Write or create files
- \`edit\`: Edit files with find & replace
- \`grep\`: Search file contents by regex
- \`ls\`: List directory contents
- \`bash\`: Execute shell commands

Use these alongside canvas_* tools for full workspace control.

## Guidelines
- Be concise and direct
- When creating file nodes, give them meaningful titles
- When the user references a node by title, look it up in the summary below
- For canvas-related tasks, use the canvas_* tools
- For code-related tasks, use the filesystem tools (read, write, edit, grep, bash)

`;

function buildSystemPrompt(summary: WorkspaceSummary | null): string {
  if (!summary) {
    return BASE_SYSTEM_PROMPT + '\n## Current Canvas\n(empty workspace — no nodes yet)\n';
  }
  return BASE_SYSTEM_PROMPT + '\n## Current Canvas\n' + formatSummaryForPrompt(summary);
}

// ─── Canvas Agent ──────────────────────────────────────────────────

export class CanvasAgent {
  private engine: any; // Engine type from pulse-coder-engine (no .d.ts yet)
  private messages: ModelMessage[] = [];
  private sessionStore: SessionStore;
  private config: CanvasAgentConfig;

  constructor(config: CanvasAgentConfig) {
    this.config = config;
    this.sessionStore = new SessionStore(config.workspaceId);

    const canvasTools = createCanvasTools(config.workspaceId);

    this.engine = new Engine({
      disableBuiltInPlugins: true,
      llmProvider: createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_API_URL,
      }),
      model: config.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o',
      tools: canvasTools,
    });
  }

  async initialize(): Promise<void> {
    console.info(`[canvas-agent] Initializing for workspace: ${this.config.workspaceId}`);

    await this.engine.initialize();

    // Start a new session
    await this.sessionStore.startSession();

    console.info('[canvas-agent] Initialized');
  }

  /**
   * Send a user message and get the agent's response.
   * @param onText — optional callback receiving streaming text deltas
   * @param onToolCall — optional callback when a tool call starts
   * @param onToolResult — optional callback when a tool call completes
   */
  async chat(
    message: string,
    onText?: (delta: string) => void,
    onToolCall?: (data: { name: string; args: any }) => void,
    onToolResult?: (data: { name: string; result: string }) => void,
  ): Promise<string> {
    // Refresh workspace summary for system prompt
    const summary = await buildWorkspaceSummary(this.config.workspaceId);
    const systemPrompt = buildSystemPrompt(summary);

    // Add user message
    this.messages.push({ role: 'user', content: message } as ModelMessage);
    this.sessionStore.addMessage({ role: 'user', content: message, timestamp: Date.now() });

    // Build the context — pass a mutable reference so onResponse/onCompacted can update it
    const context = { messages: this.messages };

    const resultText = await this.engine.run(context, {
      systemPrompt,
      maxSteps: 10,
      onText,
      onToolCall: onToolCall
        ? (chunk: any) => {
            // AI SDK v6 uses `input`; older versions use `args`
            const args = chunk.input ?? chunk.args;
            console.info('[canvas-agent] tool-call chunk keys:', Object.keys(chunk), 'input:', chunk.input, 'args:', chunk.args);
            onToolCall({ name: chunk.toolName, args });
          }
        : undefined,
      onToolResult: onToolResult
        ? (chunk: any) => {
            // AI SDK v6 uses `output`; older versions use `result`
            const raw = chunk.output ?? chunk.result;
            console.info('[canvas-agent] tool-result chunk keys:', Object.keys(chunk), 'output:', typeof chunk.output, 'result:', typeof chunk.result);
            onToolResult({
              name: chunk.toolName,
              result: typeof raw === 'string' ? raw : JSON.stringify(raw),
            });
          }
        : undefined,
      onResponse: (msgs: ModelMessage[]) => {
        for (const msg of msgs) {
          this.messages.push(msg);
        }
      },
      onCompacted: (newMessages: ModelMessage[]) => {
        this.messages = newMessages;
        context.messages = newMessages;
      },
    });

    const responseText = resultText || '(no response)';

    // Persist assistant response
    this.sessionStore.addMessage({ role: 'assistant', content: responseText, timestamp: Date.now() });

    return responseText;
  }

  /**
   * Get conversation history for the current session.
   */
  getHistory(): CanvasAgentMessage[] {
    return this.sessionStore.getMessages();
  }

  /**
   * Get the current session ID.
   */
  getCurrentSessionId(): string | null {
    return this.sessionStore.getCurrentSession()?.sessionId ?? null;
  }

  /**
   * Get the message count for the current session.
   */
  getMessageCount(): number {
    return this.sessionStore.getMessages().length;
  }

  /**
   * List all sessions (current + archived).
   */
  async listSessions(): Promise<Array<{ sessionId: string; date: string; messageCount: number; isCurrent: boolean; preview: string }>> {
    const archived = await this.sessionStore.listArchivedSessions();
    const result: Array<{ sessionId: string; date: string; messageCount: number; isCurrent: boolean; preview: string }> = [];

    // Add current session first if it exists
    const current = this.sessionStore.getCurrentSession();
    if (current) {
      const firstUserMsg = current.messages.find(m => m.role === 'user');
      result.push({
        sessionId: current.sessionId,
        date: current.startedAt.slice(0, 10),
        messageCount: current.messages.length,
        isCurrent: true,
        preview: firstUserMsg ? firstUserMsg.content.slice(0, 50) : '',
      });
    }

    // Add archived sessions
    for (const s of archived) {
      result.push({ ...s, isCurrent: false });
    }

    return result;
  }

  /**
   * Start a new session (archives current if any).
   */
  async newSession(): Promise<void> {
    await this.sessionStore.startSession();
    this.messages = [];
  }

  /**
   * Load a specific archived session by sessionId.
   */
  async loadSession(sessionId: string): Promise<CanvasAgentMessage[]> {
    const session = await this.sessionStore.loadSession(sessionId);
    if (!session) return [];
    // Rebuild in-memory messages from loaded session
    this.messages = session.messages.map(m => ({ role: m.role, content: m.content } as any));
    return session.messages;
  }

  /**
   * Destroy the agent (called when workspace is closed).
   */
  async destroy(): Promise<void> {
    console.info(`[canvas-agent] Destroying for workspace: ${this.config.workspaceId}`);
    await this.sessionStore.archiveSession();
    this.messages = [];
  }
}
