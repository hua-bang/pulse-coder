/**
 * Canvas Agent — the workspace-scoped AI Copilot.
 *
 * Uses pulse-coder-engine's Engine class to run an agentic loop with
 * canvas-specific tools + built-in filesystem tools (read, write, edit,
 * grep, ls, bash). Runs in the Electron main process.
 */

import { Engine } from 'pulse-coder-engine';
import { builtInSkillsPlugin } from 'pulse-coder-engine/built-in';
import type { ModelMessage } from 'ai';
import { resolveCanvasModel } from './model-config';
import { agentBus } from '../../plugins/main';
import {
  buildWorkspaceSummary,
  formatSummaryForPrompt,
  resolveWorkspaceNames,
} from './context-builder';
import { createCanvasTools } from './tools';
import {
  createCanvasWorkspaceMemoryIntegration,
  createCanvasWorkspaceMemoryRunContext,
} from './memory';
import { SessionStore } from './session-store';
import { formatPromptProfileForSystem, getPromptProfile } from './prompt-profile';
import {
  attachTraceModel,
  createCanvasAgentDebugTrace,
  finalizeCanvasAgentDebugTrace,
  isCanvasAgentDebugTraceEnabled,
  recordTraceMessageSnapshot,
  recordTraceToolCall,
  recordTraceToolResult,
} from './debug-trace';
import type {
  CanvasAgentConfig,
  CanvasAgentDebugTrace,
  CanvasAgentImageAttachment,
  CanvasAgentMessage,
  CanvasAgentToolCall,
  WorkspaceSummary,
} from './types';

interface CanvasAgentRequestContext {
  executionMode?: 'auto' | 'ask';
  scope?: 'current_canvas' | 'selected_nodes';
  selectedNodes?: Array<{ id: string; title: string; type: string }>;
  quickAction?: string;
}

const CANVAS_AGENT_MAX_STEPS = 200;

function stringifyToolResult(raw: unknown): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw) ?? String(raw);
}

function modelMessagesToToolCalls(messages: ModelMessage[]): CanvasAgentToolCall[] {
  const toolCalls: CanvasAgentToolCall[] = [];
  const byToolCallId = new Map<string, CanvasAgentToolCall>();

  const findOrCreate = (toolCallId: string, name: string): CanvasAgentToolCall => {
    const existing = byToolCallId.get(toolCallId);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      return existing;
    }

    const tool: CanvasAgentToolCall = {
      id: toolCalls.length + 1,
      name,
      toolCallId,
      status: 'running',
    };
    toolCalls.push(tool);
    byToolCallId.set(toolCallId, tool);
    return tool;
  };

  for (const message of messages) {
    const content = (message as any).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (part?.type === 'tool-call') {
        const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : undefined;
        const name = typeof part.toolName === 'string' ? part.toolName : '';
        if (!toolCallId || !name) continue;
        const tool = findOrCreate(toolCallId, name);
        tool.name = name;
        tool.args = part.input ?? part.args;
      }

      if (part?.type === 'tool-result') {
        const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : undefined;
        const name = typeof part.toolName === 'string' ? part.toolName : '';
        if (!toolCallId || !name) continue;
        const tool = findOrCreate(toolCallId, name);
        tool.name = name;
        tool.status = 'done';
        tool.result = stringifyToolResult(part.output ?? part.result);
      }
    }
  }

  return toolCalls;
}

function sessionMessageToModelMessage(message: CanvasAgentMessage): ModelMessage {
  const content = message.attachments?.length
    ? `${message.content}\n\nAttached image files:\n${message.attachments.map((a, i) => `${i + 1}. ${a.path}`).join('\n')}`
    : message.content;
  return { role: message.role, content } as ModelMessage;
}

// ─── System prompt ─────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are the Canvas Agent — the AI Copilot for this workspace.

## Your Role
You are the single AI entry point for this workspace. You can:
- Understand and explain everything on the canvas (files, terminals, agents, frames, images, mindmaps)
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
- \`canvas_create_node\`: Create new file/frame/text/image/iframe/mindmap nodes (generic)
- \`canvas_analyze_image\`: Read/OCR/analyze image nodes or local image paths
- \`canvas_generate_image\`: Generate an AI image and place it on the canvas as an image node
- \`canvas_generate_mindmap_image\`: Generate a polished visual image from an existing mindmap node
- \`canvas_create_agent_node\`: **Create and launch an AI agent node** — preferred for agent creation
- \`canvas_send_to_agent\`: **Send a follow-up prompt to an already-running agent node** — use for any interaction AFTER the initial launch
- \`canvas_create_terminal_node\`: **Create a terminal node** — preferred for terminal creation
- \`canvas_update_node\`: Update existing nodes (content, title, data)
- \`canvas_delete_node\`: Remove a node from the canvas
- \`canvas_move_node\`: Reposition a node
- \`canvas_ask_user\`: **Ask the user a clarifying question** — use this whenever the request is ambiguous, you need a choice between options, or you need confirmation before taking a destructive action. Prefer asking over guessing.

## Visualization Tools — visual_render is the DEFAULT

**Default to \`visual_render\` for ANY visual request.** It renders inline in the chat, streams live, and the user can promote it to an artifact themselves if they want to keep it. Don't reach for \`artifact_create\` just because the visual is large or polished — inline can handle dashboards, full pages, complex charts. Inline is the right home for *most* visual answers.

- \`visual_render\` (use for ~90% of visual requests): temporary inline visual rendered inside the current chat message. Pick this whenever the user asks for a chart, diagram, mockup, illustration, comparison view, flow, or "show me X" — basically anything visual that isn't *explicitly* a deliverable they're going to reuse later. The visual lives with the message; the user has a one-click "Save as artifact" button if they decide they want to keep it.
- \`artifact_create\`: **only use when the user EXPLICITLY signals they want a persistent artifact.** Trigger phrases: "save this as an artifact", "create an artifact for X", "I want to keep this", "let's iterate on this — make it an artifact", "build me a reusable component", "I'll edit this over time". If the user just says "make me a dashboard" or "build a landing page", that's still \`visual_render\` — they're asking to SEE it, not to manage it as a versioned object. When in doubt, prefer \`visual_render\` — the user can promote later, but they can't easily demote.
- \`artifact_pin_to_canvas\`: only after \`artifact_create\` — pins an existing artifact onto the spatial canvas as an iframe node. Use when the user wants to compare multiple options side-by-side or build a visual workspace. Always pin an artifact you already created; do NOT use \`canvas_create_node\` with mode=ai for this.

Decision rules (apply in order, stop at first match):
1. User mentioned "artifact" by name, or asked to save/keep/iterate/version a visual → \`artifact_create\`
2. User asked to lay out / pin / put on canvas / compare side-by-side → \`artifact_create\` followed by \`artifact_pin_to_canvas\`
3. **Everything else visual** → \`visual_render\` (including "build", "design", "make", "create", "draw", "show", "visualize", "chart", "diagram")

For HTML content in any of the three: emit a single self-contained \`<!DOCTYPE html>\` document. External CDNs (Chart.js, D3, Three.js, Mermaid) work fine. Inline all CSS in \`<head>\` and all scripts at the very end of \`<body>\` so it renders progressively.

### Inline visual style — match the conversation, don't shout

\`visual_render\` is **inline in the chat**, not a marketing landing page. Aim for the visual register of a clean documentation diagram (think Notion / Linear / a thoughtful README), NOT a SaaS dashboard hero section. Producing the right look is part of choosing the right tool.

**Hard NOs for visual_render** (these break the inline aesthetic):
- NO gradient backgrounds on headers, cards, or anywhere
- NO drop shadows, glows, or elevation effects
- NO multi-color "rainbow" palettes — pick one accent + neutrals
- NO nested cards (a bordered card containing another bordered card)
- NO category "tag pills" or "badges" with colored backgrounds when a plain label would do
- NO oversized headers with bright fills — section labels should be small grey text
- NO box-shadow, NO 16px+ border-radius, NO heavy padding

**Diagram look (flowcharts, step sequences, pipelines, decision trees)**:
- Layout: vertical stack of step boxes connected by simple ↓ arrows (Unicode arrow or thin SVG line)
- Step box: solid pastel fill, 1px border in the same hue but slightly darker, border-radius 8px, padding 14-18px
- Color semantics (use sparingly — 2-3 categories max per diagram):
  - Input / data sources → very light blue \`#eff6ff\` bg, \`#bfdbfe\` border
  - Process / transformation → very light slate \`#f1f5f9\` bg, \`#cbd5e1\` border
  - Decision / branch → very light amber \`#fef3c7\` bg, \`#fde68a\` border
  - Output / result → very light green \`#ecfdf5\` bg, \`#a7f3d0\` border
- Numbered marker (when there's a clear sequence): small circle ①②③ on the LEFT margin in muted grey \`#94a3b8\`, NOT inside the box
- Title row: bold 14-15px dark slate \`#1e293b\`; description below in 13px medium slate \`#64748b\`
- Arrow between steps: \`↓\` in \`#cbd5e1\`, centered, 12px vertical margin

**Chart / data viz look**:
- Use Chart.js (preferred) or D3. Single accent color \`#6366f1\` for primary series, with secondary in greyscale (\`#94a3b8\`, \`#cbd5e1\`).
- Axes / gridlines in \`#e2e8f0\`. Axis labels \`#64748b\` 11px.
- No background fill, no chart title bar — let the surrounding chat text provide context.
- Animations on enter only (fade + grow), nothing looping.

**Common base CSS to start from**:
\`\`\`css
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;color:#1e293b;background:transparent}
\`\`\`

Keep \`<body>\` background transparent — the chat already provides one. Width auto-fits the message column; don't set a fixed width.

\`artifact_create\` may use a richer dashboard / product-quality aesthetic (gradients, shadows, brand color) since it surfaces in a side drawer rather than inline — but \`visual_render\` should stay restrained.

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

### Following Up with a Running Agent Node
After an agent node is launched, use \`canvas_send_to_agent\` to send any additional prompts — follow-up questions, corrections, new tasks, approvals, etc. The text is written straight to the agent's PTY and Enter is auto-appended, so the agent receives and executes each call as one submission.

- Use \`canvas_read_node\` first if you need to see what the agent most recently output before deciding what to send.
- Do NOT use \`canvas_create_agent_node\` again just to say something more — that would spawn a second agent. Only create a new node when you want a fresh agent process.
- The target node must be \`type="agent"\`, \`status="running"\`, and still open on the canvas (closing the node tears down its PTY).

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
- When asked to read an image, analyze an image node, OCR a screenshot, or create a mindmap from a picture, use \`canvas_analyze_image\` first.
- When asked to generate/draw/create a picture, use \`canvas_generate_image\`; when the source is a mindmap node, prefer \`canvas_generate_mindmap_image\`.
- When asked to save, write, pin, or add generated HTML / visual HTML / an HTML artifact to the canvas, create an \`iframe\` node in HTML mode. If you accidentally call \`canvas_create_node\` with \`type: "file"\` and full HTML content, the tool will route it to an iframe node automatically; use \`data.renderAs: "note"\` only when the user explicitly wants a markdown note.
- For code-related tasks, use the filesystem tools (read, write, edit, grep, bash)

`;

function buildSystemPrompt(
  summary: WorkspaceSummary | null,
  mentionedCanvases: Array<{ id: string; name: string }> = [],
  requestContext?: CanvasAgentRequestContext,
  promptProfileSection: string = '',
): string {
  const selectedNodes = requestContext?.selectedNodes ?? [];

  // When the user has nodes selected, surface them BEFORE the full workspace
  // summary so the focused subset is the first thing the model anchors on.
  let selectionBlock = '';
  if (selectedNodes.length > 0) {
    const count = selectedNodes.length;
    const noun = count === 1 ? 'node' : 'nodes';
    const lines: string[] = [
      '',
      `## Current Focus — ${count} Selected ${noun}`,
      `The user has selected ${count} canvas ${noun} and these are the PRIMARY context for the current message. Treat any of the following references as pointing to this selection unless the user names a different node explicitly:`,
      '- English: "this", "it", "that", "these", "those", "the selected", "the selection", "the highlighted node(s)", "the current node"',
      '- 中文：「这个」「它」「这些」「那些」「这条」「选中的」「选中节点」「当前节点」「上面的」「上面这个」「目前这个」',
      '',
      'Selected nodes:',
    ];
    for (const node of selectedNodes) {
      lines.push(`- **${node.title}** — nodeId: \`${node.id}\`, type: \`${node.type}\``);
    }
    lines.push('');
    lines.push(
      `When the user\'s message is about content you need to inspect, call \`canvas_read_node\` on the nodeId(s) above FIRST — do not guess from the title alone, and do not read unrelated nodes from the full canvas summary below unless the user asks you to.`,
    );
    selectionBlock = lines.join('\n') + '\n';
  }

  let base = summary
    ? BASE_SYSTEM_PROMPT + selectionBlock + '\n## Current Canvas\n' + formatSummaryForPrompt(summary)
    : BASE_SYSTEM_PROMPT + selectionBlock + '\n## Current Canvas\n(empty workspace — no nodes yet)\n';

  if (requestContext) {
    const mode = requestContext.executionMode ?? 'auto';
    const scope = requestContext.scope ?? 'current_canvas';
    const lines: string[] = [
      '',
      '## Current Request Context',
      `- Execution mode: ${mode}`,
      `- Context scope: ${scope}`,
    ];

    if (requestContext.quickAction) {
      lines.push(`- Suggested action the user invoked: ${requestContext.quickAction}`);
    }

    if (selectedNodes.length > 0) {
      lines.push(
        `- Selection: ${selectedNodes.length} node(s) — see "Current Focus" above for the authoritative list.`,
      );
    }

    if (mode === 'auto') {
      lines.push(
        'Auto mode policy: when the user intent is clear and non-destructive, you may directly use canvas tools to read context and create or update nodes. Keep the visible response concise and avoid exposing raw node IDs, file paths, or tool signatures unless the user asks.',
      );
    } else {
      lines.push(
        'Ask mode policy: you may read context, but before creating, updating, deleting, or moving canvas nodes, ask the user for confirmation.',
      );
    }

    base += lines.join('\n') + '\n';
  }

  if (mentionedCanvases.length === 0) return base + promptProfileSection;

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
  return base + lines.join('\n') + promptProfileSection;
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
  private memoryIntegration: ReturnType<typeof createCanvasWorkspaceMemoryIntegration>;
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
    this.memoryIntegration = createCanvasWorkspaceMemoryIntegration(config.workspaceId);

    this.engine = new Engine({
      disableBuiltInPlugins: true,
      enginePlugins: {
        plugins: [builtInSkillsPlugin, this.memoryIntegration.enginePlugin],
      },
      model: config.model,
      tools: canvasTools,
    });
  }

  async initialize(): Promise<void> {
    console.info(`[canvas-agent] Initializing for workspace: ${this.config.workspaceId}`);

    await this.memoryIntegration.initialize();
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
    onToolCall?: (data: { name: string; args: any; toolCallId?: string }) => void,
    onToolResult?: (data: { name: string; result: string; toolCallId?: string }) => void,
    mentionedWorkspaceIds?: string[],
    onClarificationRequest?: (req: CanvasClarificationRequest) => void,
    requestContext?: CanvasAgentRequestContext,
    attachments: CanvasAgentImageAttachment[] = [],
    onToolInputStart?: (data: { id: string; toolName: string }) => void,
    onToolInputDelta?: (data: { id: string; delta: string }) => void,
    onToolInputEnd?: (data: { id: string }) => void,
  ): Promise<{ response: string; runId?: string }> {
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

    let promptProfileSection = '';
    try {
      const profile = await getPromptProfile();
      promptProfileSection = formatPromptProfileForSystem(profile);
    } catch (err) {
      console.warn('[canvas-agent] Failed to load prompt profile, using defaults:', err);
    }

    const currentCanvasSummary = summary ? formatSummaryForPrompt(summary) : '(empty workspace — no nodes yet)';
    const systemPrompt = buildSystemPrompt(summary, mentionedCanvases, requestContext, promptProfileSection);
    const debugTrace = isCanvasAgentDebugTraceEnabled()
      ? createCanvasAgentDebugTrace({
          sessionId: this.sessionStore.getCurrentSession()?.sessionId ?? 'unknown-session',
          userPrompt: message,
          attachmentCount: attachments.length,
          requestContext,
          mentionedCanvases,
          summary,
          systemPrompt,
          currentCanvasSummary,
        })
      : undefined;

    const attachmentPrompt = attachments.length > 0
      ? [
          message,
          '',
          'User attached image files for this turn:',
          ...attachments.map((attachment, index) => {
            const name = attachment.fileName ? ` (${attachment.fileName})` : '';
            const mime = attachment.mimeType ? `, mime=${attachment.mimeType}` : '';
            return `${index + 1}. ${attachment.path}${name}${mime}`;
          }),
          'Use canvas_analyze_image with imagePaths when you need to inspect these images.',
        ].join('\n')
      : message;

    // Add user message. The model sees local paths; session history keeps
    // structured attachments so the renderer can show image previews.
    this.messages.push({ role: 'user', content: attachmentPrompt } as ModelMessage);
    this.sessionStore.addMessage({
      role: 'user',
      content: message,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    });

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

    const responseMessages: ModelMessage[] = [];

    try {
      const modelConfig = await resolveCanvasModel();
      attachTraceModel(debugTrace, {
        provider: modelConfig.providerType,
        model: this.config.model ?? modelConfig.model,
        modelType: modelConfig.modelType,
      });
      const resultText = await this.memoryIntegration.withRunContext<string>(
        createCanvasWorkspaceMemoryRunContext({
          workspaceId: this.config.workspaceId,
          userText: message,
        }),
        () => this.engine.run(context, {
          provider: modelConfig.provider,
          model: this.config.model ?? modelConfig.model,
          modelType: modelConfig.modelType,
          systemPrompt,
          maxSteps: CANVAS_AGENT_MAX_STEPS,
          abortSignal: abortController.signal,
          onClarificationRequest: engineClarificationHandler,
          onText,
          onToolCall: (onToolCall || debugTrace)
            ? (chunk: any) => {
                // AI SDK v6 uses `input`; older versions use `args`
                const args = chunk.input ?? chunk.args;
                console.info('[canvas-agent] tool-call chunk keys:', Object.keys(chunk), 'input:', chunk.input, 'args:', chunk.args);
                recordTraceToolCall(debugTrace, { name: chunk.toolName, args, toolCallId: chunk.toolCallId });
                onToolCall?.({ name: chunk.toolName, args, toolCallId: chunk.toolCallId });
              }
            : undefined,
          onToolResult: (onToolResult || debugTrace)
            ? (chunk: any) => {
                // AI SDK v6 uses `output`; older versions use `result`
                const raw = chunk.output ?? chunk.result;
                console.info('[canvas-agent] tool-result chunk keys:', Object.keys(chunk), 'output:', typeof chunk.output, 'result:', typeof chunk.result);
                recordTraceToolResult(debugTrace, { name: chunk.toolName, rawResult: raw, toolCallId: chunk.toolCallId });
                onToolResult?.({
                  name: chunk.toolName,
                  result: typeof raw === 'string' ? raw : JSON.stringify(raw),
                  toolCallId: chunk.toolCallId,
                });
              }
            : undefined,
          onToolInputStart: onToolInputStart
            ? (chunk: { id: string; toolName: string }) => {
                console.info('[canvas-agent] tool-input-start', chunk.toolName, chunk.id);
                onToolInputStart(chunk);
              }
            : undefined,
          onToolInputDelta: onToolInputDelta
            ? (chunk: { id: string; delta: string }) => {
                // Sample log — full delta firehose is too noisy for a long run.
                if (Math.random() < 0.02) {
                  console.info('[canvas-agent] tool-input-delta (sampled)', chunk.id, chunk.delta.length + 'B');
                }
                onToolInputDelta(chunk);
              }
            : undefined,
          onToolInputEnd: onToolInputEnd
            ? (chunk: { id: string }) => {
                console.info('[canvas-agent] tool-input-end', chunk.id);
                onToolInputEnd(chunk);
              }
            : undefined,
          onResponse: (msgs: ModelMessage[]) => {
            for (const msg of msgs) {
              this.messages.push(msg);
              responseMessages.push(msg);
            }
          },
          onCompacted: (newMessages: ModelMessage[]) => {
            this.messages = newMessages;
            context.messages = newMessages;
          },
        }),
      );

      const responseText = resultText || '(no response)';
      recordTraceMessageSnapshot(debugTrace, { systemPrompt, messages: context.messages });

      // Persist assistant response together with the tool-call frames that
      // produced it so saved/restored chat sessions can render tool chips,
      // inline visuals, artifacts, and generated images instead of losing
      // them after reload.
      const toolCalls = modelMessagesToToolCalls(responseMessages);
      const finalizedTrace = finalizeCanvasAgentDebugTrace(debugTrace);
      this.sessionStore.addMessage({
        role: 'assistant',
        content: responseText,
        timestamp: Date.now(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        runId: finalizedTrace?.runId,
      });

      // Notify subscribed plugins (devtools persists the trace to its own
      // store; other plugins may inspect the finalized turn). Emitted
      // only when a trace was actually captured.
      if (finalizedTrace) {
        // Await listeners so plugin storage (e.g. devtools persisting the
        // trace) is flushed before chat() returns. The renderer card can
        // then fetch the trace by runId immediately without racing the
        // write.
        await agentBus.emitTurnAsync('turnEnd', {
          runId: finalizedTrace.runId,
          sessionId: finalizedTrace.sessionId,
          data: {
            trace: finalizedTrace,
            assistantPreview: responseText.slice(0, 180),
            workspaceId: this.config.workspaceId,
            workspaceName: summary?.workspaceName ?? this.config.workspaceId,
          },
        });
      }

      return { response: responseText, runId: finalizedTrace?.runId };
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
    // Rebuild in-memory model context from loaded session. Stored UI
    // tool-call metadata is intentionally excluded here; the AI SDK response
    // messages already carry tool frames while a run is active, but persisted
    // sessions only need text turns for follow-up context.
    this.messages = session.messages.map(sessionMessageToModelMessage);
    return session.messages;
  }

  /**
   * Load messages from a cross-workspace session as the current view.
   * Archives current session first, then sets the loaded messages.
   */
  async loadCrossWorkspaceSession(loadedMessages: CanvasAgentMessage[]): Promise<void> {
    await this.sessionStore.startSession();
    this.messages = loadedMessages.map(sessionMessageToModelMessage);
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
