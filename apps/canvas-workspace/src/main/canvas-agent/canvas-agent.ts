/**
 * Canvas Agent — the workspace-scoped AI Copilot.
 *
 * Uses pulse-coder-engine's Engine class to run an agentic loop with
 * canvas-specific tools + built-in filesystem tools (read, write, edit,
 * grep, ls, bash). Runs in the Electron main process.
 */

import { Engine } from 'pulse-coder-engine';
import { builtInSkillsPlugin } from 'pulse-coder-engine/built-in';
import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage } from 'ai';
import {
  buildWorkspaceSummary,
  formatSummaryForPrompt,
  resolveWorkspaceNames,
} from './context-builder';
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
- \`canvas_create_node\`: Create new file/frame nodes (generic)
- \`canvas_create_agent_node\`: **Create and launch an AI agent node** — preferred for agent creation
- \`canvas_create_terminal_node\`: **Create a terminal node** — preferred for terminal creation
- \`canvas_update_node\`: Update existing nodes (content, title, data)
- \`canvas_delete_node\`: Remove a node from the canvas
- \`canvas_move_node\`: Reposition a node
- \`canvas_ask_user\`: **Ask the user a clarifying question** — use this whenever the request is ambiguous, you need a choice between options, or you need confirmation before taking a destructive action. Prefer asking over guessing.

### Delegating Tasks to Agent Nodes
Use \`canvas_create_agent_node\` to spawn another agent (Claude Code, Codex, Pulse Coder) with context.

**Workflow:**
1. Read relevant canvas nodes with \`canvas_read_node\` to gather context.
2. Compose a detailed \`prompt\` that includes the task description AND the relevant canvas content.
3. Call \`canvas_create_agent_node\` — the prompt is piped directly to the agent as its initial prompt.

Example:
\`\`\`json
{
  "title": "Codex: Implement Feature",
  "agentType": "codex",
  "cwd": "/path/to/project",
  "prompt": "## Task\\nImplement the login feature.\\n\\n## Context from Canvas\\n(PRD content here...)"
}
\`\`\`

### Creating Terminal Nodes
Use \`canvas_create_terminal_node\` to spawn an interactive shell.
The shell starts automatically. Set \`cwd\` for the working directory.
Set \`command\` to auto-execute a command after the shell is ready (e.g. "npm run dev", "docker compose up").

## Filesystem Tools (built-in)
- \`read\`: Read file contents (with offset/limit support)
- \`write\`: Write or create files
- \`edit\`: Edit files with find & replace
- \`grep\`: Search file contents by regex
- \`ls\`: List directory contents
- \`bash\`: Execute shell commands

## Skills
- \`skill\`: Load a skill by name to get detailed step-by-step instructions for specialized tasks (e.g. canvas operations via pulse-canvas CLI, canvas-bootstrap for deep-research workspace creation)

Use these alongside canvas_* tools for full workspace control.

## Guidelines
- Be concise and direct
- When creating file nodes, give them meaningful titles
- When the user references a node by title, look it up in the summary below
- For canvas-related tasks, use the canvas_* tools
- For code-related tasks, use the filesystem tools (read, write, edit, grep, bash)

`;

function buildSystemPrompt(
  summary: WorkspaceSummary | null,
  mentionedCanvases: Array<{ id: string; name: string }> = [],
): string {
  const base = summary
    ? BASE_SYSTEM_PROMPT + '\n## Current Canvas\n' + formatSummaryForPrompt(summary)
    : BASE_SYSTEM_PROMPT + '\n## Current Canvas\n(empty workspace — no nodes yet)\n';

  if (mentionedCanvases.length === 0) return base;

  const lines: string[] = [
    '',
    '## Other Canvases Referenced by the User',
    'The user has `@`-mentioned the canvases listed below. This is a ' +
      '**reference table only** — it tells you which workspaceIds the user ' +
      'might be talking about. It is **not** an instruction to read them.',
    '',
    '**Strict rule — do NOT auto-read:** Do not call `canvas_read_context` ' +
      'or `canvas_read_node` for any canvas in this list unless the user\'s ' +
      'current message **explicitly asks** you to read, open, look at, ' +
      'summarize, compare, or otherwise use content from that specific ' +
      'canvas. A bare mention like "`@[canvas:Foo]` 怎么样？" where "怎么样" ' +
      'stands alone is **not** an explicit read request — ask the user what ' +
      'they want to know about it instead. Fetching without an explicit ' +
      'request wastes the user\'s tokens and is considered incorrect behavior.',
    '',
    'When the user **does** explicitly ask, use the matching `workspaceId` ' +
      'from the list with `canvas_read_context` (detail="summary" for the ' +
      'node list, detail="full" for file contents and terminal scrollback), ' +
      'or with `canvas_read_node` for a single node.',
    '',
    'Mentioned canvases:',
  ];
  for (const c of mentionedCanvases) {
    lines.push(`- **${c.name}** — workspaceId: \`${c.id}\``);
  }
  lines.push('');
  return base + lines.join('\n');
}

// ─── Canvas Agent ──────────────────────────────────────────────────

/** Request payload emitted when the agent wants to ask the user a question. */
export interface CanvasClarificationRequest {
  id: string;
  question: string;
  context?: string;
}

export class CanvasAgent {
  private engine: any; // Engine type from pulse-coder-engine (no .d.ts yet)
  private messages: ModelMessage[] = [];
  private sessionStore: SessionStore;
  private config: CanvasAgentConfig;

  /** AbortController for the currently-running chat turn, if any. */
  private currentAbortController: AbortController | null = null;
  /** Pending clarification resolvers keyed by request id. */
  private pendingClarifications = new Map<string, (answer: string) => void>();

  constructor(config: CanvasAgentConfig) {
    this.config = config;
    this.sessionStore = new SessionStore(config.workspaceId);

    const canvasTools = createCanvasTools(config.workspaceId);

    this.engine = new Engine({
      disableBuiltInPlugins: true,
      enginePlugins: {
        plugins: [builtInSkillsPlugin],
      },
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
   *
   * @param onText — optional callback receiving streaming text deltas
   * @param onToolCall — optional callback when a tool call starts
   * @param onToolResult — optional callback when a tool call completes
   * @param mentionedWorkspaceIds — workspaces the user @-mentioned
   * @param onClarificationRequest — optional callback invoked when the agent
   *   wants to ask the user a clarifying question. The caller is responsible
   *   for displaying it and eventually calling `answerClarification` with the
   *   user's reply (or `abort()` to cancel the run).
   */
  async chat(
    message: string,
    onText?: (delta: string) => void,
    onToolCall?: (data: { name: string; args: any }) => void,
    onToolResult?: (data: { name: string; result: string }) => void,
    mentionedWorkspaceIds?: string[],
    onClarificationRequest?: (req: CanvasClarificationRequest) => void,
  ): Promise<string> {
    // Refresh workspace summary for system prompt
    const summary = await buildWorkspaceSummary(this.config.workspaceId);

    // For any other canvases the user @-mentioned, we only inject the
    // `{ id, name }` pair into the system prompt — the agent is expected to
    // call `canvas_read_context({ workspaceId })` on demand if it actually
    // needs that canvas's content.
    let mentionedCanvases: Array<{ id: string; name: string }> = [];
    if (mentionedWorkspaceIds && mentionedWorkspaceIds.length > 0) {
      const unique = Array.from(new Set(mentionedWorkspaceIds)).filter(
        id => id && id !== this.config.workspaceId,
      );
      mentionedCanvases = await resolveWorkspaceNames(unique);
    }

    const systemPrompt = buildSystemPrompt(summary, mentionedCanvases);

    // Add user message
    this.messages.push({ role: 'user', content: message } as ModelMessage);
    this.sessionStore.addMessage({ role: 'user', content: message, timestamp: Date.now() });

    // Build the context — pass a mutable reference so onResponse/onCompacted can update it
    const context = { messages: this.messages };

    // One AbortController per chat turn. Exposed via this.abort() so callers
    // can interrupt a long-running generation.
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    // Wire the clarify tool through: each clarification request gets a
    // resolver stashed in `pendingClarifications` keyed by request id. The
    // caller (IPC handler) dispatches the request to the renderer and calls
    // `answerClarification(id, answer)` when the user replies.
    const engineClarificationHandler = onClarificationRequest
      ? async (req: { id: string; question: string; context?: string }) => {
          return await new Promise<string>((resolve) => {
            this.pendingClarifications.set(req.id, resolve);
            onClarificationRequest({
              id: req.id,
              question: req.question,
              context: req.context,
            });
          });
        }
      : undefined;

    try {
      const resultText = await this.engine.run(context, {
        systemPrompt,
        maxSteps: 10,
        abortSignal: abortController.signal,
        onClarificationRequest: engineClarificationHandler,
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
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
      this.pendingClarifications.clear();
    }
  }

  /**
   * Abort the current chat turn if one is running. Safe to call when no
   * turn is active — it becomes a no-op.
   */
  abort(): void {
    this.currentAbortController?.abort();
  }

  /**
   * Deliver a user's answer to a pending clarification request. Returns
   * true if the answer matched a pending request, false otherwise.
   */
  answerClarification(requestId: string, answer: string): boolean {
    const resolver = this.pendingClarifications.get(requestId);
    if (!resolver) return false;
    this.pendingClarifications.delete(requestId);
    resolver(answer);
    return true;
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
   * Load messages from a cross-workspace session as the current view.
   * Archives current session first, then sets the loaded messages.
   */
  async loadCrossWorkspaceSession(loadedMessages: CanvasAgentMessage[]): Promise<void> {
    await this.sessionStore.startSession();
    this.messages = loadedMessages.map(m => ({ role: m.role, content: m.content } as any));
    // Persist each message into the new current session
    for (const m of loadedMessages) {
      this.sessionStore.addMessage(m);
    }
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
