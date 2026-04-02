# Agent Teams × Canvas Integration - Roadmap

## Overview

```
Phase 1          Phase 2          Phase 3          Phase 4          Phase 5          Phase 6
Canvas Agent     Team MCP         Single Agent     Multi-Agent      AI Planning      Workspace
Node UI          Server           Execution        Team Execution   + Review         Agent
──────────       ──────────       ──────────       ──────────       ──────────       ──────────
types +          MCP tools        PTY spawn +      Frame as team    Planner UI       Global
components +     wrapping         xterm binding    + Run Team +     + auto-layout    assistant
node factory     TaskList +       + IPC bridge     event-driven     + plan review    + multi-team
                 Mailbox          + interaction     updates          + follow-up      coordination
```

### Dependency Graph

```
Phase 1 (Canvas UI) ──┐
                       ├── Phase 3 (Single Agent) ── Phase 4 (Multi-Agent) ── Phase 5 (AI Planning) ── Phase 6 (Workspace Agent)
Phase 2 (MCP Server) ─┘
```

Phase 1 and Phase 2 can be developed in parallel.

---

## Phase 1: Canvas Agent Node UI

### Goal
Canvas 上能创建、展示、配置 agent 节点，不涉及执行。

### Tasks

#### 1.1 Type System Extension
- **File**: `apps/canvas-workspace/src/renderer/src/types.ts`
- Add `'agent'` to `CanvasNodeType`
- Define `AgentNodeData` interface
  - `teammateId`, `teamId`, `name`, `role`
  - `runtime: 'pulse-agent' | 'claude-code' | 'codex'`
  - `mode: 'in-process' | 'pty'`
  - `isLead: boolean`
  - `model?`, `spawnPrompt?`, `sessionId?`
  - `status: AgentStatus`
  - `currentTask?`, `tasks?`
- Define `AgentRuntime`, `AgentMode`, `AgentStatus` types
- Extend `FrameNodeData` with `isTeam?`, `teamId?`, `teamName?`, `teamStatus?`, `goal?`

#### 1.2 Node Factory
- **File**: `apps/canvas-workspace/src/renderer/src/utils/nodeFactory.ts`
- Add `'agent'` case to `createNodeData()`
- Add `'agent'` case to `createDefaultNode()` with default dimensions (500×450)
- Default `AgentNodeData`: runtime='pulse-agent', mode='pty', isLead=false, status='idle'

#### 1.3 AgentNodeBody Component
- **Dir**: `apps/canvas-workspace/src/renderer/src/components/AgentNodeBody/`
- `index.tsx`: Composite component routing to sub-components
- `AgentHeader.tsx`:
  - Agent name (editable)
  - Runtime badge (pulse-agent / claude-code / codex)
  - Runtime selector dropdown
  - Status indicator (color dot: green=running, yellow=waiting, grey=idle, red=failed)
  - Action buttons: [Pause] [Stop] (disabled when idle)
- `AgentTaskPanel.tsx`:
  - Collapsible task list
  - Per-task status icon (✓ completed, ▶ in_progress, ○ pending, ✗ failed)
  - Current task highlighted
  - Static display for now (no live updates)
- `AgentTerminal.tsx`:
  - Xterm.js instance placeholder (no PTY binding yet)
  - Reuse terminal theme from `config/terminalTheme.ts`
  - Show "Agent not running" message when idle
- `AgentPlanReview.tsx`:
  - Conditional panel (hidden by default)
  - Plan text display
  - [Approve] [Reject] buttons with feedback input
  - Hidden until connected to real plan events

#### 1.4 LeadAgentNodeBody Component
- **Dir**: `apps/canvas-workspace/src/renderer/src/components/LeadAgentNodeBody/`
- `index.tsx`: Lead-specific composite
- `GoalInput.tsx`: Text input for team goal
- `TeamProgress.tsx`:
  - Overall progress bar (completed / total tasks)
  - Per-teammate mini status (name + task count)
  - Static display for now
- `ResultSummary.tsx`: Post-completion text area (hidden until team completes)

#### 1.5 CanvasNodeView Integration
- **File**: `apps/canvas-workspace/src/renderer/src/components/CanvasNodeView/index.tsx`
- Add `case 'agent'` to render `AgentNodeBody` or `LeadAgentNodeBody` based on `data.isLead`

#### 1.6 Context Menu
- **File**: `apps/canvas-workspace/src/renderer/src/components/NodeContextMenu/` (or Canvas)
- Add "New Agent" option to right-click context menu
- Add "New Team" option (creates Frame with isTeam=true + auto-creates Lead node inside)

#### 1.7 Node Persistence
- Ensure agent node data serializes/deserializes correctly in `canvas-store.ts`
- Verify save/load round-trip for all AgentNodeData fields

### Deliverables
- Agent nodes appear on canvas with full UI skeleton
- Can configure name, role, runtime, model, spawnPrompt
- Can create Team (Frame + Lead) from context menu
- All state persists across app restarts

---

## Phase 2: Team MCP Server

### Goal
将 agent-teams 的 TaskList + Mailbox 暴露为 MCP 协议，供外部 CLI agent 调用。

### Tasks

#### 2.1 MCP Server Implementation
- **File**: `packages/agent-teams/src/mcp-server.ts`
- Implement MCP server using `@modelcontextprotocol/sdk`
- Transport: stdio (local process)
- Accept CLI args: `--state-dir <path>` and `--teammate-id <id>`
- Instantiate `TaskList` and `Mailbox` from state-dir
- Register 9 tools:
  - `team_claim_task(taskId?)`
  - `team_complete_task(taskId, result?)`
  - `team_fail_task(taskId, error?)`
  - `team_create_task(title, description, deps?, assignee?)`
  - `team_list_tasks()`
  - `team_send_message(to, content)`
  - `team_read_messages()`
  - `team_notify_lead(content)`
  - `team_submit_plan(plan)`

#### 2.2 MCP Config Generator
- **File**: `packages/agent-teams/src/mcp-config.ts`
- `generateMCPConfig(stateDir, teammateId)`: Returns MCP config JSON
- `writeMCPConfigFile(path, config)`: Write config to temp file
- Per-runtime config format:
  - claude-code: `{ mcpServers: { "agent-team": { command, args } } }`
  - codex: same structure (confirm exact format)
  - pulse-agent: same structure

#### 2.3 Server Lifecycle Management
- **File**: `packages/agent-teams/src/mcp-server-manager.ts`
- `TeamMCPServerManager`:
  - `start(stateDir)`: Spawn MCP server process
  - `stop()`: Kill process
  - `isRunning()`: Health check
  - Auto-restart on crash

#### 2.4 Tests
- Unit test: MCP tools execute correctly against TaskList/Mailbox
- Integration test: spawn MCP server, connect client, call tools, verify state changes

### Deliverables
- Standalone MCP server binary in agent-teams package
- Config generator for all three runtimes
- Server lifecycle management with auto-restart

---

## Phase 3: Single Agent Execution

### Goal
Canvas 上单个 agent 节点能启动真实 CLI 会话并执行任务，支持双向交互。

### Tasks

#### 3.1 Agent Runtime Abstraction
- **File**: `apps/canvas-workspace/src/main/agent-runtime.ts`
- Define `IAgentRuntime` interface
- Implement `PtyAgentRuntime`:
  - `start()`: Generate MCP config, spawn CLI via pty-manager
  - `stop()`: Kill PTY session
  - `sendInput()`: Write to PTY
  - `onOutput()`: Forward PTY data
- Implement `InProcessAgentRuntime` (pulse-agent only):
  - Wrap existing `Teammate` + `Engine`
  - Pipe `onText` to output callback

#### 3.2 AgentTeamManager Foundation
- **File**: `apps/canvas-workspace/src/main/agent-team-manager.ts`
- Basic lifecycle: createTeam, addTeammate
- Single agent spawn and management
- Event forwarding to renderer

#### 3.3 IPC Registration
- **File**: `apps/canvas-workspace/src/main/agent-team-ipc.ts`
- Register IPC handlers for agent-team operations
- Wire up in `main/index.ts`

#### 3.4 Preload Extension
- **File**: `apps/canvas-workspace/src/preload/index.ts`
- Add `agentTeam` namespace to `canvasWorkspace` API
- Expose: createTeam, runTeam, stopTeam, sendInput, onEvent, onAgentOutput

#### 3.5 Xterm Binding
- **File**: `apps/canvas-workspace/src/renderer/src/components/AgentNodeBody/AgentTerminal.tsx`
- Bind xterm to agent runtime output (via IPC)
- Bind xterm input to agent runtime input (via IPC)
- Create `useAgentTerminal` hook

#### 3.6 Agent Status Updates
- **File**: `apps/canvas-workspace/src/renderer/src/components/AgentNodeBody/AgentHeader.tsx`
- Status indicator reacts to real agent status events
- Action buttons (Stop) wired to real IPC calls

#### 3.7 Manual Agent Launch
- Add "Start" button to idle agent node
- User clicks Start → spawns CLI session → xterm shows output
- User can type in xterm → input forwarded to CLI

### Deliverables
- Single agent node can start any runtime (pulse-agent / claude-code / codex)
- Xterm shows real-time output from CLI session
- User can type in xterm to interact with agent
- Stop button terminates agent

---

## Phase 4: Multi-Agent Team Execution

### Goal
多个 agent 节点组成 team，通过 TaskList + Mailbox 协调工作，Canvas 实时展示全局进度。

### Tasks

#### 4.1 Team Execution Logic
- **File**: `apps/canvas-workspace/src/main/agent-team-manager.ts`
- `runTeam()`:
  1. Start TeamMCPServer for the team
  2. Create tasks in TaskList
  3. Spawn all agent runtimes
  4. Write initial system prompt to each agent PTY (role, context, MCP tool instructions)
  5. Monitor TaskList for completion

#### 4.2 System Prompt Generation
- **File**: `apps/canvas-workspace/src/main/agent-prompt-builder.ts`
- Generate per-agent system prompt including:
  - Role and spawnPrompt
  - Team context (other teammates, their roles)
  - Available MCP tools and how to use them
  - Task claiming workflow instructions
  - Working directory

#### 4.3 Canvas → Team Config
- **File**: `apps/canvas-workspace/src/renderer/src/utils/canvasTeamConfig.ts`
- `canvasToTeamConfig()`: Extract Frame + child agent nodes → TeamRunConfig
- Validate: at least one teammate, tasks well-formed

#### 4.4 Frame "Run Team" Button
- Extend Frame node UI with "Run Team" button (only when `isTeam=true`)
- Click → `canvasToTeamConfig()` → IPC `agent-team:run`
- "Stop All" button during execution

#### 4.5 Live Task Panel Updates
- `AgentTaskPanel.tsx` subscribes to `task:claimed`, `task:completed`, `task:failed` events
- Update task status in real-time
- Highlight current task per agent

#### 4.6 Lead Node: Team Progress
- `TeamProgress.tsx` subscribes to all task events
- Update progress bar and per-teammate mini status
- Show completion percentage

#### 4.7 Task Dependency Visualization
- In Task Panel, show dependency info (text-based, no edge lines)
- Blocked tasks show "(waiting for: task-X)" label
- Auto-scroll to newly claimed task

#### 4.8 Multi-Agent Coordination Tests
- E2E test: create team with 2+ agents, run tasks with dependencies
- Verify: task claiming, completion, dependency unlocking, result passing

### Deliverables
- Frame "Run Team" starts all agents in the team
- Agents self-coordinate via MCP (claim tasks, complete, message)
- Canvas updates in real-time (task status, agent status, progress)
- Task dependencies auto-unlock

---

## Phase 5: AI Planning + Review

### Goal
用户给一句话描述目标，AI 自动生成 team 布局并渲染到 canvas，用户审查调整后执行。

### Tasks

#### 5.1 Planner Integration in Canvas
- **File**: `apps/canvas-workspace/src/main/agent-team-manager.ts`
- `planTeam(goal)`: Call `Planner.planTeam()` from agent-teams
- Return TeamPlan to renderer

#### 5.2 Team Plan → Canvas Nodes
- **File**: `apps/canvas-workspace/src/renderer/src/utils/canvasTeamConfig.ts`
- `teamPlanToCanvas(plan, position)`:
  - Create Frame node
  - Create Lead agent node
  - Create Teammate agent nodes with auto-grid layout
  - Pre-populate tasks from plan
- Auto-fit canvas to show new nodes

#### 5.3 Goal Input UI
- In LeadAgentNodeBody `GoalInput.tsx`:
  - Text input + "Plan" button
  - Loading state while Planner runs
  - Plan result auto-renders as nodes

#### 5.4 Review and Edit Workflow
- User can edit any generated agent node (change runtime, model, role, etc.)
- User can add/remove agents
- User can edit/add/remove tasks
- "Run Team" only enabled after review

#### 5.5 Plan Mode Integration
- When teammate has `requirePlanApproval=true`:
  - Agent submits plan via `team_submit_plan` MCP tool
  - `AgentPlanReview.tsx` panel appears with plan text
  - User clicks Approve → agent proceeds
  - User clicks Reject + feedback → agent revises

#### 5.6 Follow-Up Support
- After team completes, user can input new instructions
- `TeamLead.followUp()` generates additional tasks
- Reuse existing agents, spawn new ones if needed
- Canvas updates with new tasks

#### 5.7 Result Synthesis
- After all tasks complete, call `TeamLead.synthesizeResults()`
- Display synthesis in Lead node's `ResultSummary.tsx`

### Deliverables
- User types goal → AI generates team → Canvas renders nodes
- User reviews and adjusts → clicks Run
- Plan approval workflow with UI
- Follow-up instructions for incremental work
- Result synthesis display

---

## Phase 6: Workspace Agent

### Goal
Workspace 粒度的全局助手，能理解整个 workspace 上下文，创建和管理多个 Team。

### Tasks

#### 6.1 Workspace Agent Panel
- **Dir**: `apps/canvas-workspace/src/renderer/src/components/WorkspaceAgentPanel/`
- Sidebar / panel UI (not a canvas node)
- Natural language input
- Team overview list (all teams in workspace)
- Chat history with workspace agent

#### 6.2 Workspace Agent Runtime
- **File**: `apps/canvas-workspace/src/main/workspace-agent.ts`
- Persistent agent instance per workspace
- Has access to:
  - All canvas nodes metadata
  - File listing and project structure
  - All team states
- Can call:
  - `AgentTeamManager.createTeam()`
  - `AgentTeamManager.planTeam()`
  - `AgentTeamManager.runTeam()`

#### 6.3 Goal Decomposition
- Workspace Agent receives high-level goal
- Decides how many Teams to create
- Creates multiple Frames with appropriate team configurations
- Each team has its own Lead + Teammates

#### 6.4 Cross-Team Awareness
- Workspace Agent monitors all teams
- Can pass information between teams (via prompts, not mailbox)
- Reports overall progress to user

#### 6.5 Integration with Existing Canvas Context
- Leverage existing `canvasContextWriter.ts` for workspace context
- Workspace Agent reads `AGENTS.md` for project awareness
- Updates context as canvas nodes change

### Deliverables
- Workspace-level AI assistant in sidebar
- Can create and manage multiple teams
- Goal decomposition into multiple parallel teams
- Cross-team progress monitoring

---

## Phase 7: Enhancements (Future)

Ordered by expected value, can be re-prioritized:

### 7.1 Skill + Canvas CLI Channel
- Alternative to MCP for team tool exposure
- Agents use CLI commands instead of MCP tools
- Useful for runtimes that don't support MCP

### 7.2 Edge System
- Visual dependency lines between agent nodes
- Interactive: drag to create dependency
- Animate during execution (data flow visualization)

### 7.3 Agent Templates
- Pre-configured agent configurations (researcher, coder, reviewer, etc.)
- Template library in sidebar
- Drag-and-drop to canvas

### 7.4 Execution History + Replay
- Record full execution trace (events, outputs, state changes)
- Timeline view for post-mortem analysis
- Replay execution step-by-step

### 7.5 Remote Execution
- Connect to remote agent instances
- Distribute agents across machines
- Integrate with `apps/remote-server`

---

## Summary Table

| Phase | Focus | Key Deliverable | Dependencies |
|-------|-------|-----------------|--------------|
| 1 | Canvas Agent Node UI | Agent nodes on canvas, configurable | None |
| 2 | Team MCP Server | MCP tool exposure for TaskList + Mailbox | None |
| 3 | Single Agent Execution | One agent running + xterm interaction | Phase 1, 2 |
| 4 | Multi-Agent Team | Coordinated team execution + live canvas | Phase 3 |
| 5 | AI Planning + Review | Goal → AI plan → review → execute | Phase 4 |
| 6 | Workspace Agent | Global assistant + multi-team management | Phase 5 |
| 7 | Enhancements | Edges, templates, history, remote | Phase 6 |
