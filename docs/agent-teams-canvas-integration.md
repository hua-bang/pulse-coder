# Agent Teams × Canvas Workspace Integration Design

## Vision

用户给出一个任务目标，AI（Planner）自动生成 Agent Team 或用户在 Canvas 上手动编排，审查确认后一键执行。执行过程中，多个 agent（pulse-agent / claude-code / codex）通过 MCP 共享 TaskList + Mailbox 进行协调，Canvas 实时展示状态并支持交互。

## End-to-End Flow

```
用户输入目标 / 手动编排
        ↓
Planner 生成 TeamPlan（teammates + tasks + deps）
        ↓
Canvas 渲染 agent 节点 ← 用户可审查、调整
        ↓
点击 "Run Team"
        ↓
编排层：
  1. 启动 team-mcp-server（暴露 TaskList + Mailbox 工具）
  2. 为每个 agent spawn 交互式 CLI 会话（带 MCP 配置）
  3. 创建 tasks 到 TaskList
        ↓
每个 agent 通过 MCP 工具自主协调：
  - team_claim_task → 认领任务
  - team_complete_task → 标记完成（触发依赖解锁）
  - team_send_message → agent 间通信
  - team_read_messages → 读取消息
  - team_notify_lead → 汇报进展
        ↓
Canvas 实时更新（PTY 输出 + TaskList 状态变更事件）
        ↓
所有 task 完成 → 结束
```

## Architecture

### Layer Diagram

```
┌─────────────────────────────────────┐
│  apps/canvas-workspace (Electron)   │  UI Layer
│  - AgentNodeBody component          │
│  - AgentTeamManager (IPC bridge)    │
│  - PTY manager (reused)             │
├─────────────────────────────────────┤
│  team-mcp-server                    │  Communication Layer
│  - Exposes TaskList + Mailbox       │
│  - Per-team instance                │
├─────────────────────────────────────┤
│  packages/agent-teams               │  Orchestration Layer
│  - Team / TeamLead / Planner        │
│  - TaskList / Mailbox               │
├─────────────────────────────────────┤
│  Agent Runtimes (via PTY)           │  Execution Layer
│  - pulse-agent (interactive CLI)    │
│  - claude-code (interactive CLI)    │
│  - codex (interactive CLI)          │
└─────────────────────────────────────┘
```

### Agent Node = Terminal Node + Orchestration UI

每个 agent 节点是一个复合组件：

```
┌─ AgentNodeBody ─────────────────────┐
│ ┌─ Header Bar ────────────────────┐ │
│ │ 🟢 researcher · claude-code     │ │
│ │ [Pause] [Stop]                  │ │
│ └─────────────────────────────────┘ │
│ ┌─ Task Panel (collapsible) ─────┐ │
│ │ ✓ Analyze API structure         │ │
│ │ ▶ Write interface docs ← curr  │ │
│ │ ○ Integration test              │ │
│ └─────────────────────────────────┘ │
│ ┌─ Terminal (xterm) ─────────────┐ │
│ │ > Reading src/api/...           │ │
│ │ > Found 12 endpoints            │ │
│ │ > _                             │ │ ← bidirectional
│ └─────────────────────────────────┘ │
│ ┌─ Plan Review (conditional) ────┐ │
│ │ Plan: 1.xxx  2.xxx  3.xxx      │ │
│ │ [Approve] [Reject + feedback]   │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### Multi-Runtime Support

All runtimes use the same execution model: interactive CLI session via real PTY.

```typescript
type AgentNodeData = {
  teammateId: string;
  role: string;
  runtime: 'pulse-agent' | 'claude-code' | 'codex';
  model?: string;
  spawnPrompt?: string;
  sessionId: string;       // PTY session ID (reuse pty-manager)
  status: 'idle' | 'running' | 'stopping' | 'stopped';
  currentTask?: { id: string; title: string };
};
```

| Runtime | Spawn Command | MCP Support |
|---------|---------------|-------------|
| pulse-agent | `pulse-agent` | ✅ via config |
| claude-code | `claude` | ✅ via `--mcp-config` |
| codex | `codex` | ✅ via config |

### Team MCP Server

Wraps existing `buildTeamTools()` logic as an MCP server. Each team run spawns one MCP server instance, all agents in that team connect to it.

Exposed tools:

| Tool | Description |
|------|-------------|
| `team_claim_task` | Claim next available task |
| `team_complete_task` | Mark task as completed with result |
| `team_create_task` | Create a new task |
| `team_list_tasks` | List all tasks with status |
| `team_send_message` | Send message to another teammate |
| `team_read_messages` | Read unread messages |
| `team_notify_lead` | Send message to lead |
| `team_submit_plan` | Submit plan for approval (plan mode) |

Backend: direct calls to `TaskList` and `Mailbox` instances (same file-based state as current agent-teams).

MCP config generated per agent:

```json
{
  "mcpServers": {
    "agent-team": {
      "command": "node",
      "args": ["team-mcp-server.js", "--state-dir", "/path/to/team-state", "--teammate-id", "researcher"]
    }
  }
}
```

### Creation Modes

#### Mode A: AI-Driven (Planner)

1. User describes goal in natural language
2. `Planner.planTeam()` generates `TeamPlan` (teammates + tasks + deps)
3. `teamPlanToCanvas(plan)` renders agent nodes on canvas
4. User reviews and adjusts on canvas
5. Click "Run Team"

#### Mode B: Manual (Canvas GUI)

1. Right-click canvas → "New Agent" to create agent nodes
2. Configure each node: name, role, runtime, model, spawnPrompt
3. Add tasks via node UI
4. Use Frame node to group agents as a team
5. Click "Run Team"

Both modes converge to the same execution path:

```typescript
// Canvas nodes → TeamConfig
function canvasToTeamConfig(nodes: CanvasNode[]): { teammates, tasks }

// TeamPlan → Canvas nodes
function teamPlanToCanvas(plan: TeamPlan): CanvasNode[]
```

### Execution Flow (Main Process)

```typescript
class AgentTeamManager {
  async run(config: TeamRunConfig, win: BrowserWindow) {
    // 1. Create team state
    const team = new Team({ name: config.name, cwd: config.cwd });

    // 2. Start MCP server
    const mcpServer = new TeamMCPServer(team.getTaskList(), team.getMailbox());
    await mcpServer.start();

    // 3. Forward team events to renderer
    team.on((event) => {
      win.webContents.send('agent-team:event', event);
    });

    // 4. Create tasks
    await team.createTasks(config.tasks);

    // 5. Spawn agent PTY sessions with MCP config
    for (const t of config.teammates) {
      const mcpConfig = mcpServer.generateConfig(t.id);
      const sessionId = ptyManager.spawn(t.runtime, {
        args: getMCPArgs(t.runtime, mcpConfig),
        cwd: config.cwd,
      });
      // Associate PTY session with agent node
      win.webContents.send('agent-team:pty-bound', { teammateId: t.id, sessionId });
    }
  }
}
```

### IPC Bridge (Preload)

Extends existing `canvasWorkspace` API:

```typescript
agentTeam: {
  run: (config) => ipcRenderer.invoke('agent-team:run', config),
  stop: (teammateId) => ipcRenderer.invoke('agent-team:stop', teammateId),
  stopAll: () => ipcRenderer.invoke('agent-team:stop-all'),
  approvePlan: (teammateId) => ipcRenderer.invoke('agent-team:approve', teammateId),
  rejectPlan: (teammateId, feedback) => ipcRenderer.invoke('agent-team:reject', teammateId, feedback),
  onEvent: (cb) => { /* IPC listener */ },
}
```

### Interaction Model

The xterm in each agent node is **bidirectional**:

| Direction | Mechanism |
|-----------|-----------|
| Agent → User | PTY stdout → xterm display |
| User → Agent | xterm input → PTY stdin (direct CLI interaction) |

User can interact with any agent at any time — typing in the xterm is equivalent to typing directly in the CLI session.

Structured interactions (approve, stop, reassign) go through GUI buttons, not the terminal.

## Implementation Plan

### PR 1: Agent Node Type + Static UI

- Add `agent` node type to `types.ts` with `AgentNodeData`
- `AgentNodeBody` composite component (header + task panel + xterm placeholder)
- `nodeFactory` support for creating agent nodes
- Right-click context menu: "New Agent"
- Runtime selector (pulse-agent / claude-code / codex)
- Node persistence (canvas.json)

### PR 2: Team MCP Server

- `packages/agent-teams/src/mcp-server.ts`
- Wrap `TaskList` + `Mailbox` operations as MCP tools
- Per-teammate identity via CLI args
- MCP config generation helper
- Unit tests

### PR 3: Execution Bridge

- `AgentTeamManager` in canvas main process
- PTY spawn with MCP config per runtime
- Team event → IPC → renderer forwarding
- Agent node xterm bound to PTY session
- Task panel live updates from TaskList events

### PR 4: AI Planning + Visual Orchestration

- `teamPlanToCanvas()`: Planner output → canvas nodes (auto-layout)
- `canvasToTeamConfig()`: canvas nodes → Team config
- "Run Team" button on Frame node
- Plan review panel (approve/reject)
- `TeamLead.followUp()` support for incremental work

## Future Extensions

- **Skill + Canvas CLI**: Alternative to MCP for tool exposure
- **Edge system**: Visual dependency lines between agent nodes
- **Agent marketplace**: Pre-configured agent templates
- **Result synthesis**: Auto-summary panel after team completion
- **Multi-team**: Nested teams / team-of-teams orchestration
