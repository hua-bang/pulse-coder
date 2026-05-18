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

### Inline visual style — escape the AI-slop default

⚠️ **Your reflex aesthetic IS the problem.** Reaching for *Inter + slate-50 background + indigo-600 accent + white bordered cards + lots of whitespace* produces what Anthropic's own frontend-aesthetics guidance literally names the "AI slop aesthetic" — generic, on-distribution, instantly recognizable as AI-generated, forgettable. Don't ship that. Make creative, distinctive frontends that feel **designed for the specific topic** and that surprise the reader.

The visual still lives inline in a chat message, so it stays sized for that frame — but within that frame, the bar is: *"would a real designer be proud to ship this?"*

**Step 1 — Pick an aesthetic register BEFORE writing any HTML**

Read the topic and choose a register that suits it. State it as an HTML comment at the top of the document so you commit to it. Examples (vary across calls — don't always pick the same one):

- **Editorial / explainer / "explain to me…" / 加工逻辑 / 原理** → Fraunces or Crimson Pro or Newsreader (serif display) + IBM Plex Sans body; cream/paper background, deep ink, one strong cultural accent (oxblood, cobalt, ochre, jade).
- **Data / engineering / technical pipeline** → IBM Plex Sans + JetBrains Mono (mono labels everywhere); blueprint feel — off-white or pale grid, navy/teal accents, refined SVG diagrams not pastel boxes.
- **Product / creative / startup** → Bricolage Grotesque or Cabinet Grotesk or Clash Display as display + Inter or Geist body; one dominant brand color, neutral base.
- **Brutalist / archival / serious / financial** → DM Serif Display or Newsreader + small Söhne-Mono labels; paper-white + true black + one alarm color.
- **Code / IDE / dev tool** → Space Grotesk or Geist + JetBrains Mono; dark mode (Tokyo Night, Catppuccin Mocha, OneDark) with syntax-highlight accent colors.
- **Magazine / cultural / lifestyle** → Playfair Display variable + a geometric sans; one strong cultural color, photo-led or texture-led.

Pick ONE and commit. Don't blend registers. Vary across calls — if the last visual was editorial-serif, lean technical-mono next time. Never default to the same look every time.

**Step 2 — Typography (highest-leverage decision)**

- **AVOID as the display font:** Inter, Roboto, Open Sans, Lato, Arial, the system font stack. These are flag-planters for AI slop. Inter is acceptable only as a *body* font when a distinctive display does the talking.
- **Pairing principle:** high contrast. Display + monospace, serif + geometric sans, OR one variable font swung between weights 100/200 ↔ 800/900.
- **Size jumps:** 3× or more between hierarchy levels (\`text-6xl\` hero → \`text-base\` body), not the timid 1.5×.
- **Letter-spacing:** \`tracking-tight\` (-0.02em) on display, \`tracking-[0.2em] uppercase\` on small labels.
- Load fonts from Google Fonts with \`display=swap\`. Use \`font-feature-settings: "ss01","ss02"\` if the chosen font has stylistic alternates.

**Step 3 — Color & theme**

- Define a cohesive palette via CSS custom properties (\`--bg\`, \`--surface\`, \`--ink\`, \`--mute\`, \`--accent\`, \`--accent-2\`) once at the top; use them everywhere.
- **Dominant base + sharp accent**, NOT timid evenly-distributed neutrals. A magazine page is ~80% one base + ~5% intense accent. Slate-50 + slate-700 + indigo-600 evenly spread = AI slop.
- **Forbidden palettes**: slate / indigo / white-card combo; purple-gradient-on-white; generic SaaS-pastel.
- **Draw from real references** — IDE themes (Solarized, Tokyo Night, Catppuccin, Nord, Rosé Pine), magazine palettes (oxblood + cream, cobalt + chartreuse, black + safety orange, jade + ivory), cultural aesthetics (Bauhaus primaries, Memphis, Swiss black/red, Japanese editorial cream + sumi).
- Vary between light and dark themes across calls.

**Step 4 — Backgrounds: atmosphere, not flat white**

The visual's outer wrapper needs *some* atmosphere — never just a flat white box.
- Subtle CSS gradient inside the wrapper (warm cream → off-white; deep ink → navy; pale ochre → ivory)
- Grain / noise via a tiny inline SVG \`<filter><feTurbulence>\` overlay at 4–8% opacity
- Geometric pattern or single oversized typographic mark as a corner accent
- Soft radial glow behind a hero element

But: **keep \`<body>\` itself transparent** so the chat column doesn't get a giant solid box around it. Put atmosphere on an inner \`<div>\` wrapper.

**Step 5 — Motion**

ONE well-orchestrated page-load: staggered reveal of major elements over ~0.6s using \`animation-delay\` (e.g. 0 / 100 / 220 / 360 / 520 ms) with \`opacity 0 → 1\` + \`translateY(8px → 0)\`. CSS-only, easing \`cubic-bezier(.2,.7,.2,1)\`. No looping animations, no scroll-triggered chains, no bouncing arrows, no spinning anything.

**Step 6 — Stack: Tailwind via CDN + Google Fonts**

Always scaffold with Tailwind (it's a tested design system — orders of magnitude better than ad-hoc CSS) and load distinctive fonts. Skeleton:

\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<!-- register: editorial-explainer / data-blueprint / brutalist-archival / ide-dark / magazine -->
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500;9..144,700&family=IBM+Plex+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script>
  tailwind.config = { theme: { extend: {
    fontFamily: {
      display: ['Fraunces','serif'],
      sans: ['"IBM Plex Sans"','sans-serif'],
      mono: ['"JetBrains Mono"','monospace'],
    },
    colors: { ink:'#1a1410', cream:'#f5efe3', mute:'#a89a82', accent:'#9c2a1a' },
  }}};
</script>
<style>
  body{background:transparent;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .rise{animation:rise .55s cubic-bezier(.2,.7,.2,1) both}
</style>
</head>
<body class="font-sans text-ink">
  <div class="relative bg-cream rounded-2xl overflow-hidden p-10 md:p-12 mx-auto max-w-3xl">
    <!-- atmosphere layer, hero, content -->
  </div>
</body>
</html>
\`\`\`

Use Tailwind utilities for all spacing/layout. Don't load Tailwind and then write 60 lines of inline \`<style>\` — that defeats the point.

**Step 7 — Pick the right form** (flowcharts are NOT the default)

Read what the user actually wants. Stacking pastel boxes with \`↓\` arrows is the laziest possible AI move — resist it.

- **Editorial / explanatory layout (DEFAULT for "explain X", "可视化 Z", "visualize the logic of …", "加工逻辑")**: huge display hero (title in the chosen display font, \`text-5xl\`/\`text-6xl\`, \`tracking-tight\`) + one-sentence subtitle in muted body, then sectioned content with strong subheads, refined body text, inline code chips for field names (\`<code class="font-mono text-[0.85em] px-1.5 py-0.5 rounded bg-ink/5">btm_show_id</code>\`), refined small tables for structured data. Pull out a hero number or one-line takeaway if it earns the space. NO numbered step boxes with arrows unless explicitly requested.
- **Metric views (only with real data)**: hero number in display font at \`text-6xl\`/\`text-7xl\` with \`tracking-tight\`; a tiny \`tracking-[0.2em] uppercase text-xs\` label above; an optional delta in body below. Multiple metrics separated by whitespace or thin vertical rules — never identical bordered cards.
- **Charts (only with real data)**: Chart.js or D3 via CDN. ONE accent for primary, a darker shade of the same hue or monochrome for secondary. No chart title bar, no legend with a single series. Enter animation only.
- **Comparison / decision tables**: uppercase tracked header in mute, body in the chosen body font, row dividers only, no outer border, no zebra unless dense.
- **Flow / pipeline / step diagram — ONLY when the user explicitly asks** for a flowchart / pipeline / process diagram / decision tree / step-by-step diagram (or 中文：流程图 / 管道 / 步骤图 / 决策树 / 加工链路). Even then: don't reach for pastel boxes. Use a refined SVG with hand-drawn-feeling lines, OR a vertical list of rows separated by \`border-t border-ink/10\` with a small tracked step number, display-font title, body description. Max 2 tint colors total.

**Inline-fit guards** (the visual lives in a chat message)

- \`<body>\` transparent — atmosphere goes on the inner wrapper.
- Outer wrapper: \`max-w-3xl\` (~768px) or \`max-w-4xl\` (~896px), centered, with its own atmospheric background. Never \`100vw\`, never \`100vh\`, never fixed pixel widths.
- Outer wrapper padding \`p-8\` to \`p-12\`. Body itself gets \`p-2\` to \`p-4\` so the wrapper isn't flush against the chat edge.
- One enter-animation only.

**Hard anti-patterns** (these instantly mark the output as AI-generated)

- Inter / Roboto / system stack as the *display* font
- Slate-50 + slate-700 + indigo-600 + white bordered cards — the universal AI default
- Purple gradient on white background
- KPI / dashboard / status-pill grids when the content has no real metrics
- Stack of pastel \`#eff6ff\`/\`#fef3c7\`/\`#ecfdf5\` boxes with \`↓\` arrows when the user did not ask for a flowchart
- Decorative emoji clusters
- Bordered card inside a bordered card; outer padding > 48px; outer width > 960px
- Subtle-everything: subtle shadow + subtle border + subtle gradient = subtle slop. Commit to bold typography and a real palette instead.

\`artifact_create\` may push into full-bleed product pages — \`visual_render\` stays inside a single thoughtfully designed module, but within that module: **distinctive type, dominant color, real atmosphere, no AI slop.**

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
      model: config.model,
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
      const resultText = await this.engine.run(context, {
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
      });

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
