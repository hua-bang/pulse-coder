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

// AI SDK v6 wraps tool execute return values into a tagged `ToolResultOutput`
// — `{ type: 'text'|'json'|'error-text'|'error-json'|..., value }` — on the
// `tool-result` parts of persisted ModelMessages. Stringifying the wrapper
// loses the original payload (renderers can no longer JSON.parse the
// tool's actual return value), so unwrap to the inner value first. Plain
// strings and untyped objects pass through unchanged for back-compat.
function unwrapToolOutput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const r = raw as { type?: unknown; value?: unknown };
    if (typeof r.type === 'string' && 'value' in r) {
      const v = r.value;
      if (typeof v === 'string') return v;
      return JSON.stringify(v) ?? String(v);
    }
  }
  return JSON.stringify(raw) ?? String(raw);
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
        tool.result = unwrapToolOutput(part.output ?? part.result);
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

### Inline visual style — pick the right archetype, then match documentation density

\`visual_render\` is **inline in the chat**. Information density is welcome; decorative chrome is not (no marketing hero, no gradients, no glowing CTAs). Within that, the **register varies by archetype**:
- Step / Schema / Comparison / Timeline / Architecture / Concept → "thoughtful product documentation" (Notion / Linear / Stripe docs / a great README). Muted, monochrome-leaning, restrained.
- **Dashboard / Monitoring** → "operations console" (Datadog / Grafana / a Linear status page). KPIs are **content-colored and loud**; numbers, deltas, severity pills carry meaning through color. Still no gradients or marketing chrome, but information IS allowed to shout when it's status.

Producing the right look means picking the right *archetype* for the content first, then matching that archetype's register.

**Do not default to a flow diagram.** Step boxes + ↓ arrows is ONE archetype, not THE archetype. Before generating, pick from the list below using the user's intent.

#### Archetype router (pick one before writing any CSS)

| User intent / verbs | Archetype | Looks like |
| --- | --- | --- |
| "流程"/"加工"/"pipeline"/"step by step"/"how X flows" | **Step diagram** | vertical stacked pastel boxes + ↓ arrows |
| "监控"/"dashboard"/"运营总览"/"健康状态"/"metrics overview" | **Dashboard** | KPI tiles row + chart(s) + status table |
| "schema"/"数据模型"/"字段"/"表结构"/"data spec" | **Schema spec** | titled card with field rows (name · type · note) |
| "对比"/"compare"/"vs"/"feature matrix" | **Comparison matrix** | grid table with row/column headers |
| "时间线"/"roadmap"/"history"/"timeline" | **Timeline** | horizontal axis with milestones, or vertical date-stacked entries |
| "架构"/"system"/"模块关系"/"components" | **Architecture map** | grouped boxes with labeled connections, optional swimlanes |
| "概念图"/"mindmap"/"taxonomy" | **Concept tree** | radial or indented tree |

When the user's request fits two archetypes, prefer the **richer** one (e.g. "可视化加工逻辑" can be a step diagram OR a pipeline spec with step boxes + per-stage field/QC rows — the spec form carries more information and is usually what the user actually wants).

#### Soft rules (apply to all archetypes)

Allowed within reason:
- **Subtle elevation**: \`box-shadow: 0 1px 2px rgba(15,23,42,.04)\` on cards/tiles. Stronger shadows still off-limits.
- **Status / severity color** when the data has status semantics (alerts, health, severity, change vs. baseline). Use the status palette below.
- **Multiple category colors** when the categories are content-driven (regions, services, severity tiers, owners). Cap at ~6 hues; pick from a coherent scale (slate/blue/indigo/violet/emerald/amber), never neon.
- **Inline charts**: Chart.js or D3 are fine. Series can use distinct hues when they represent distinct categories.
- **Status pills / badges** with colored backgrounds when they label real state. Use the status palette below.
- **Small numeric callouts** (KPI tiles) with one accent-colored number per tile.

Still off-limits (these break the inline register):
- Gradient backgrounds anywhere
- Glows, heavy drop shadows, or any shadow stronger than the subtle elevation above
- Border-radius > 14px, oversized hero headers, full-bleed colored banners
- Decorative emoji clouds, marketing-style CTA buttons, animated/looping effects
- Nested bordered cards (a card inside a card inside a card)
- Rainbow palettes used for decoration rather than meaning

#### Shared tokens

\`\`\`css
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;color:#1e293b;background:transparent}
/* Type */
.t-title{font-weight:600;font-size:15px;color:#0f172a}
.t-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.t-muted{font-size:13px;color:#64748b}
/* Surface */
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px}
.card--soft{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px}
.elev{box-shadow:0 1px 2px rgba(15,23,42,.04)}
/* Accent (pick one per visual, default indigo) */
:root{--accent:#6366f1;--accent-soft:#eef2ff}
/* Status palette — use for severity / health pills, status dots */
.s-ok{color:#047857;background:#ecfdf5;border:1px solid #a7f3d0}
.s-warn{color:#a16207;background:#fef9c3;border:1px solid #fde68a}
.s-err{color:#b91c1c;background:#fee2e2;border:1px solid #fecaca}
.s-info{color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.dot-ok{background:#10b981}.dot-warn{background:#f59e0b}.dot-err{background:#ef4444}
.pulse{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
/* KPI — for dashboard tiles. Number takes content-meaning color. */
.kpi{position:relative;padding:14px 16px}
.kpi-name{font-size:12px;color:#64748b;font-weight:500;margin-bottom:6px}
.kpi-num{font-size:32px;font-weight:700;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi-unit{font-size:14px;font-weight:600;color:inherit;margin-left:2px}
.kpi-num--ok{color:#059669}.kpi-num--warn{color:#d97706}.kpi-num--err{color:#dc2626}
.kpi-num--neutral{color:#4f46e5}.kpi-num--info{color:#0891b2}
.kpi-delta{display:inline-flex;align-items:center;gap:4px;font-size:12px;margin-top:8px;padding:2px 8px;border-radius:999px;font-weight:500}
.kpi-delta--good{color:#047857;background:#ecfdf5}
.kpi-delta--bad{color:#b91c1c;background:#fee2e2}
.kpi-delta--info{color:#1d4ed8;background:#eff6ff}
.kpi-delta--warn{color:#a16207;background:#fef9c3}
/* Optional thin accent rule under the metric name, in the number's color */
.kpi-rule{height:2px;border-radius:1px;margin:0 0 10px 0;width:32px}
\`\`\`

Keep \`<body>\` transparent and width auto-fitting; don't set a fixed pixel width. For the **dashboard** archetype only, a very faint warm body tint (\`background:#fafaf9\`) is acceptable if it helps the cards read.

#### Archetype anchors (use these as starting points, don't copy verbatim)

**Step diagram** (when archetype router picked "Step diagram"):
- Vertical stack of step boxes, ↓ arrow (or thin SVG line) between them
- Step box: pastel fill, 1px border same hue 1-step darker, radius 8px, padding 14-18px
- Stage palette (sparingly, ≤4 categories): input \`#eff6ff/#bfdbfe\`, process \`#f1f5f9/#cbd5e1\`, decision \`#fef3c7/#fde68a\`, output \`#ecfdf5/#a7f3d0\`
- Numbered marker ①②③ in muted grey \`#94a3b8\` on the LEFT margin, NOT inside the box
- For "process logic" requests with fields/QC info, consider upgrading to a step-spec variant: each step box stacks a header row + small \`.t-label\` field list (inputs, outputs, QC fields)

**Dashboard** (monitoring, operational overview):
- Register: "operations console", not "documentation diagram". KPIs should feel **alive and color-coded**, not muted. Numbers are LOUD, chrome is QUIET.
- **Header row**: title (18-20px bold) on the left; on the right, an inline "live" line — pulse dot + \`实时监控\` (or \`Live\`) + \`·\` separators + \`最后更新 HH:MM:SS\` + \`刷新 30s\`. Use \`.dot-ok\` + \`.pulse\` for the indicator. Subtitle (\`.t-muted\`) under the title shows scope (\`生产环境 · 最近 24 小时\`).
- **KPI row** (3-5 tiles, CSS grid \`repeat(auto-fit,minmax(170px,1fr))\`, gap 12-14px):
  - Each tile uses \`.card\` + \`.elev\` (or just \`.kpi\` on a soft surface — either is fine).
  - Structure (top to bottom): \`.kpi-name\` metric label → optional \`.kpi-rule\` thin colored bar (in number's color) → \`.kpi-num\` BIG bold number with semantic color (\`--ok\` / \`--warn\` / \`--err\` / \`--neutral\` / \`--info\`) → \`.kpi-delta\` rounded pill with ▲ / ▼ + delta value + " vs 昨日" or " vs baseline".
  - **Pick the number's color by what the metric *means***, not by accent rules: uptime/SLA/success rate → \`--ok\` (green); latency / queue depth → \`--warn\` (amber) if elevated else \`--neutral\`; alerts / 5xx / errors → \`--err\` (red); counts / instances → \`--neutral\` (indigo).
  - Pick the delta's color by **whether the change is good or bad**, not by direction: "↑0.03% 可用性" is \`--good\` even though it's an "up" arrow; "↑22ms 延迟" is \`--bad\` because higher latency is worse.
- **Chart row** (1-2 cards side-by-side, CSS grid 2fr 1fr is a common split):
  - Time series → Chart.js line/area, dual-axis OK (e.g. QPS on left, 5xx% on right). Series colors: primary \`#6366f1\` (indigo), secondary \`#ef4444\` (rose) for "bad" series, tertiary \`#10b981\` (emerald) for "good" series.
  - Composition / resource → labeled horizontal bars (one row per resource with name + colored bar + % label), OR Chart.js doughnut with side legend; bars often read better inline.
  - Distribution / ranked categories → horizontal bars with category-distinct hues from {indigo, violet, sky, emerald, amber, rose}.
- **Bottom row** (typically 2 columns):
  - Left: **service health list** — each row = colored \`.dot-*\` + service name + tiny metric line below (\`.t-muted\` p95/uptime), with right-aligned \`.s-*\` status pill (\`正常\` / \`降级风险\` / \`异常\`).
  - Right: **alert table** — columns: 告警/服务 · 级别 (severity pill: P1 \`.s-err\`, P2 \`.s-warn\`, P3 \`.s-info\`) · 负责人 · 状态 (status pill: \`处理中\` \`.s-warn\`, \`已恢复\` \`.s-ok\`, \`待处理\` \`.s-info\`). Use mono font for alert IDs.
- Outer container max-width ~1100px, gap 14-16px between rows. Cards radius 10-12px with \`.elev\`. Don't pad cards beyond 16px.
- **Density is the point.** A dashboard with 5 KPIs + 2 charts + 2 tables is correct; a dashboard with 3 KPIs and a lot of whitespace looks anemic.

Minimal KPI tile structure (copy-adapt, don't paste verbatim):
\`\`\`html
<div class="card elev kpi">
  <div class="kpi-name">可用性 SLA</div>
  <div class="kpi-rule" style="background:#059669"></div>
  <div class="kpi-num kpi-num--ok">99.96<span class="kpi-unit">%</span></div>
  <div class="kpi-delta kpi-delta--good">▲ 0.03% vs 昨日</div>
</div>
\`\`\`

**Schema spec** (data model, field list, table structure):
- Single \`.card\` per entity: header row (entity name + small \`.t-label\` for kind/source), then a table-ish field list
- Field row: \`name\` (mono, 13px) · \`type\` (\`.t-label\`) · description (\`.t-muted\`); optional right-aligned constraint pill
- Use \`.s-info\` pills for "PK" / "FK" / "nullable" / "index" markers, monochrome otherwise
- No charts; this archetype is text-dense by design

**Comparison matrix**:
- HTML table or CSS grid with sticky first column for row labels
- Header row in \`.t-label\` style, alternating row stripe \`#f8fafc\` for readability
- Cells: ✓/✗ Unicode or status pills, never decorative icons
- Caption (if any) in \`.t-muted\` above the table

**Timeline**:
- Vertical preferred for inline (horizontal often overflows the chat column)
- Left rail with date \`.t-label\` + dot, right side with title + \`.t-muted\` description
- Optional accent-colored connecting line between dots

**Architecture map**:
- Use CSS grid or absolutely-positioned cards inside a relative container
- Group related boxes with a parent \`.card--soft\` and a tiny header label
- Connections: thin SVG lines with arrowheads in \`#94a3b8\`, optional inline label

**Concept tree / mindmap**:
- Indented list with vertical guide lines, OR a small D3 radial tree
- Keep depth ≤3; flatten further branches into a "siblings" list

#### When in doubt

If the user request mentions multiple intents ("可视化加工流程，包含字段说明和质控指标"), combine archetypes — usually step diagram + per-step field rows, or dashboard + alert table. Combining two archetypes is preferable to picking one and dropping information.

\`artifact_create\` may go further toward product-quality polish (subtle gradients on hero, brand color, slightly stronger shadows) since it lives in the side drawer; \`visual_render\` stays at documentation density.

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
                result: unwrapToolOutput(raw),
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
