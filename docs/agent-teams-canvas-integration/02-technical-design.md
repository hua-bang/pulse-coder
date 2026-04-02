# Agent Teams × Canvas Integration - Technical Design

## 1. Architecture Overview

### 1.1 Layer Diagram

```
┌──────────────────────────────────────────────────────────┐
│  apps/canvas-workspace (Electron)                        │
│                                                          │
│  Renderer (React)                Main (Node.js)          │
│  ┌──────────────────┐           ┌──────────────────────┐ │
│  │ AgentNodeBody     │  ← IPC → │ AgentTeamManager     │ │
│  │ LeadAgentNodeBody │           │ pty-manager (reused) │ │
│  │ WorkspaceAgent UI │           │ TeamMCPServerManager │ │
│  └──────────────────┘           └──────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│  packages/agent-teams                                    │
│  ┌──────────────────────────────────────────────────────┐│
│  │ Team / TeamLead / Teammate   (orchestration)         ││
│  │ TaskList / Mailbox           (coordination state)    ││
│  │ Planner                      (LLM planning)          ││
│  │ TeamMCPServer                (MCP tool exposure) NEW ││
│  └──────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────┤
│  Agent Runtimes                                          │
│  ┌────────────────┐ ┌────────────┐ ┌──────────────────┐ │
│  │ pulse-agent    │ │ claude-code│ │ codex            │ │
│  │ in-process     │ │ PTY + MCP  │ │ PTY + MCP        │ │
│  │ OR PTY + MCP   │ │            │ │                  │ │
│  └────────────────┘ └────────────┘ └──────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 1.2 Process Model

```
Electron Main Process
├── AgentTeamManager (per workspace)
│   ├── Team A
│   │   ├── TeamMCPServer instance (local stdio)
│   │   ├── PTY session: lead
│   │   ├── PTY session: agent-1
│   │   └── PTY session: agent-2
│   └── Team B
│       ├── TeamMCPServer instance (local stdio)
│       ├── PTY session: lead
│       └── PTY session: agent-3
├── pty-manager (shared, manages all PTY sessions)
└── canvas-store (persistence)

Electron Renderer Process
├── Canvas
│   ├── Frame (Team A)
│   │   ├── LeadAgentNodeBody → bound to lead PTY
│   │   ├── AgentNodeBody → bound to agent-1 PTY
│   │   └── AgentNodeBody → bound to agent-2 PTY
│   └── Frame (Team B)
│       ├── LeadAgentNodeBody → bound to lead PTY
│       └── AgentNodeBody → bound to agent-3 PTY
└── WorkspaceAgentPanel (sidebar)
```

## 2. Data Model

### 2.1 Canvas Node Types

```typescript
// Extend existing node types
type CanvasNodeType = 'file' | 'terminal' | 'frame' | 'agent';

// Agent node data
interface AgentNodeData {
  teammateId: string;
  teamId: string;              // which team (frame) this agent belongs to
  name: string;
  role: string;
  runtime: AgentRuntime;
  mode: AgentMode;
  isLead: boolean;
  model?: string;
  spawnPrompt?: string;
  sessionId?: string;          // PTY session ID (pty mode)
  status: AgentStatus;
  currentTask?: {
    id: string;
    title: string;
  };
  tasks?: AgentTaskSummary[];  // for lead: all team tasks
}

type AgentRuntime = 'pulse-agent' | 'claude-code' | 'codex';
type AgentMode = 'in-process' | 'pty';
type AgentStatus = 'idle' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'completed' | 'failed';

interface AgentTaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  assignee?: string;
}
```

### 2.2 Frame Node Extension

```typescript
// Extend existing FrameNodeData for team context
interface FrameNodeData {
  color: string;
  label?: string;
  // New fields for team integration
  isTeam?: boolean;
  teamId?: string;
  teamName?: string;
  teamStatus?: TeamStatus;
  goal?: string;              // team goal description
}
```

### 2.3 Persistence

Canvas state (canvas.json) stores agent nodes as part of the existing node array. No separate persistence needed — agent node data is serialized/deserialized with all other nodes.

Team execution state (TaskList, Mailbox) persists in `~/.pulse-coder/teams/<team-name>/` as before.

## 3. Team MCP Server

### 3.1 Overview

A local MCP server that wraps `TaskList` and `Mailbox` APIs. Each running team spawns one MCP server process. All agents in that team connect to the same server via MCP config.

### 3.2 Location

```
packages/agent-teams/src/mcp-server.ts
```

### 3.3 Exposed Tools

```typescript
const TEAM_MCP_TOOLS = {
  team_claim_task: {
    description: 'Claim the next available task, or a specific task by ID.',
    input: { taskId?: string },
    // Calls: taskList.claim(teammateId, taskId)
  },
  team_complete_task: {
    description: 'Mark a task as completed with a result summary.',
    input: { taskId: string, result?: string },
    // Calls: taskList.complete(taskId, result)
  },
  team_fail_task: {
    description: 'Mark a task as failed with an error description.',
    input: { taskId: string, error?: string },
    // Calls: taskList.fail(taskId, error)
  },
  team_create_task: {
    description: 'Create a new task in the shared task list.',
    input: { title: string, description: string, deps?: string[], assignee?: string },
    // Calls: taskList.create(input, teammateId)
  },
  team_list_tasks: {
    description: 'List all tasks with their status, assignee, and dependencies.',
    input: {},
    // Calls: taskList.getAll()
  },
  team_send_message: {
    description: 'Send a message to another teammate.',
    input: { to: string, content: string },
    // Calls: mailbox.send(teammateId, to, 'message', content)
  },
  team_read_messages: {
    description: 'Read unread messages from the team mailbox.',
    input: {},
    // Calls: mailbox.readUnread(teammateId)
  },
  team_notify_lead: {
    description: 'Send a message to the team lead.',
    input: { content: string },
    // Calls: mailbox.send(teammateId, 'lead', 'message', content)
  },
  team_submit_plan: {
    description: 'Submit an implementation plan to the lead for approval.',
    input: { plan: string },
    // Calls: mailbox.send(teammateId, 'lead', 'plan_approval_request', plan)
  },
};
```

### 3.4 Teammate Identity

Each agent connects with a teammate-specific MCP config. The `teammate-id` is passed as a CLI argument to the MCP server:

```json
{
  "mcpServers": {
    "agent-team": {
      "command": "node",
      "args": [
        "dist/mcp-server.js",
        "--state-dir", "/home/user/.pulse-coder/teams/my-team",
        "--teammate-id", "researcher"
      ]
    }
  }
}
```

### 3.5 Event Notification

When TaskList or Mailbox state changes via MCP tool calls, the MCP server emits events that the `AgentTeamManager` listens to (via file watcher or IPC). This drives canvas node updates.

## 4. Agent Runtime Abstraction

### 4.1 Interface

```typescript
interface IAgentRuntime {
  readonly id: string;
  readonly type: AgentRuntime;
  readonly mode: AgentMode;

  start(config: AgentRuntimeConfig): Promise<void>;
  stop(): Promise<void>;

  // Output stream (agent → display)
  onOutput(cb: (data: string) => void): () => void;

  // Input (user/orchestrator → agent)
  sendInput(data: string): void;

  // Status
  onStatusChange(cb: (status: AgentStatus) => void): () => void;
}

interface AgentRuntimeConfig {
  teammateId: string;
  teamStateDir: string;
  cwd: string;
  spawnPrompt?: string;
  model?: string;
  mcpConfigPath?: string;     // path to generated MCP config
  engineOptions?: EngineOptions; // for in-process mode only
}
```

### 4.2 In-Process Runtime (pulse-agent only)

```typescript
class InProcessAgentRuntime implements IAgentRuntime {
  readonly mode = 'in-process';
  private teammate: Teammate;

  // Wraps existing Teammate + Engine
  // Team tools injected directly as native Engine tools
  // Output via teammate onOutput callback → this.onOutput
  // Completion via Engine.run() return
}
```

### 4.3 PTY Runtime (all runtimes)

```typescript
class PtyAgentRuntime implements IAgentRuntime {
  readonly mode = 'pty';
  private sessionId: string;

  async start(config: AgentRuntimeConfig) {
    // 1. Generate MCP config file
    const mcpConfig = generateMCPConfig(config.teamStateDir, config.teammateId);
    writeMCPConfig(config.mcpConfigPath, mcpConfig);

    // 2. Spawn interactive CLI via pty-manager
    const command = this.getCommand();  // 'claude' | 'codex' | 'pulse-agent'
    const args = this.getMCPArgs(config.mcpConfigPath); // e.g. ['--mcp-config', path]
    this.sessionId = await ptyManager.spawn(command, { args, cwd: config.cwd });

    // 3. Bind output
    ptyManager.onData(this.sessionId, (data) => this.outputCallbacks.forEach(cb => cb(data)));
  }

  sendInput(data: string) {
    ptyManager.write(this.sessionId, data);
  }

  async stop() {
    ptyManager.kill(this.sessionId);
  }

  private getCommand(): string {
    switch (this.type) {
      case 'pulse-agent': return 'pulse-agent';
      case 'claude-code': return 'claude';
      case 'codex': return 'codex';
    }
  }

  private getMCPArgs(mcpConfigPath: string): string[] {
    switch (this.type) {
      case 'claude-code': return ['--mcp-config', mcpConfigPath];
      case 'codex': return ['--mcp-config', mcpConfigPath];
      case 'pulse-agent': return ['--mcp-config', mcpConfigPath];
    }
  }
}
```

## 5. AgentTeamManager (Main Process)

### 5.1 Overview

Central coordinator in the Electron main process. Manages team lifecycle, PTY sessions, MCP servers, and IPC event forwarding.

### 5.2 Core API

```typescript
class AgentTeamManager {
  private teams: Map<string, ManagedTeam> = new Map();

  // Team lifecycle
  async createTeam(config: CreateTeamConfig): Promise<string>;
  async runTeam(teamId: string): Promise<void>;
  async stopTeam(teamId: string): Promise<void>;

  // Teammate management
  async addTeammate(teamId: string, options: AddTeammateOptions): Promise<string>;
  async removeTeammate(teamId: string, teammateId: string): Promise<void>;

  // Task management
  async addTask(teamId: string, task: CreateTaskInput): Promise<string>;

  // Interaction
  async sendInput(teammateId: string, data: string): void;
  async approvePlan(teammateId: string): void;
  async rejectPlan(teammateId: string, feedback: string): void;

  // Events → renderer
  onEvent(handler: (event: TeamEvent) => void): () => void;
}

interface ManagedTeam {
  id: string;
  team: Team;                           // agent-teams Team instance
  mcpServer: TeamMCPServer;
  runtimes: Map<string, IAgentRuntime>; // teammateId → runtime
}
```

### 5.3 Execution Flow

```
createTeam(config)
  1. Create Team instance (agent-teams)
  2. Start TeamMCPServer
  3. Store in this.teams map
  4. Emit 'team:created' event

runTeam(teamId)
  1. Create tasks in TaskList
  2. For each teammate:
     a. Create IAgentRuntime (in-process or PTY based on config)
     b. Start runtime with MCP config
     c. If PTY mode: bind PTY output to event emitter
  3. For in-process teammates:
     a. Run Team.run() loop (existing logic)
  4. For PTY teammates:
     a. Write initial prompt to PTY
     b. Agents self-coordinate via MCP tools
  5. Forward all Team events to renderer via IPC
```

## 6. IPC Bridge

### 6.1 Preload API Extension

```typescript
// Add to existing canvasWorkspace API in preload/index.ts
agentTeam: {
  // Team lifecycle
  createTeam: (config: CreateTeamConfig) =>
    ipcRenderer.invoke('agent-team:create', config),
  runTeam: (teamId: string) =>
    ipcRenderer.invoke('agent-team:run', teamId),
  stopTeam: (teamId: string) =>
    ipcRenderer.invoke('agent-team:stop', teamId),
  stopAll: () =>
    ipcRenderer.invoke('agent-team:stop-all'),

  // Teammate
  addTeammate: (teamId: string, options: AddTeammateOptions) =>
    ipcRenderer.invoke('agent-team:add-teammate', teamId, options),
  removeTeammate: (teamId: string, teammateId: string) =>
    ipcRenderer.invoke('agent-team:remove-teammate', teamId, teammateId),

  // Task
  addTask: (teamId: string, task: CreateTaskInput) =>
    ipcRenderer.invoke('agent-team:add-task', teamId, task),

  // Interaction
  sendInput: (teammateId: string, data: string) =>
    ipcRenderer.invoke('agent-team:send-input', teammateId, data),
  approvePlan: (teammateId: string) =>
    ipcRenderer.invoke('agent-team:approve', teammateId),
  rejectPlan: (teammateId: string, feedback: string) =>
    ipcRenderer.invoke('agent-team:reject', teammateId, feedback),

  // AI Planning
  planTeam: (goal: string) =>
    ipcRenderer.invoke('agent-team:plan', goal),

  // Events (team → renderer)
  onEvent: (cb: (event: TeamEvent) => void) => {
    const handler = (_: any, event: TeamEvent) => cb(event);
    ipcRenderer.on('agent-team:event', handler);
    return () => ipcRenderer.removeListener('agent-team:event', handler);
  },

  // PTY output (per agent)
  onAgentOutput: (teammateId: string, cb: (data: string) => void) => {
    const channel = `agent-team:output:${teammateId}`;
    const handler = (_: any, data: string) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
}
```

### 6.2 IPC Handler Registration (Main Process)

```typescript
// In main/index.ts or dedicated main/agent-team-ipc.ts
function registerAgentTeamIPC(manager: AgentTeamManager) {
  ipcMain.handle('agent-team:create', (_, config) => manager.createTeam(config));
  ipcMain.handle('agent-team:run', (_, teamId) => manager.runTeam(teamId));
  ipcMain.handle('agent-team:stop', (_, teamId) => manager.stopTeam(teamId));
  // ... etc

  // Forward events to renderer
  manager.onEvent((event) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent-team:event', event);
    });
  });
}
```

## 7. Renderer Hooks

### 7.1 useAgentTeam

```typescript
function useAgentTeam() {
  const [teams, setTeams] = useState<Map<string, TeamState>>();

  useEffect(() => {
    return window.canvasWorkspace.agentTeam.onEvent((event) => {
      switch (event.type) {
        case 'task:claimed':
        case 'task:completed':
        case 'task:failed':
          updateTaskPanel(event);
          break;
        case 'teammate:status':
          updateNodeStatus(event);
          break;
        case 'teammate:spawned':
        case 'teammate:stopped':
          updateTeamMembers(event);
          break;
        case 'team:completed':
          updateTeamStatus(event);
          break;
      }
    });
  }, []);

  return {
    createTeam, runTeam, stopTeam,
    addTeammate, removeTeammate,
    addTask, approvePlan, rejectPlan,
    planTeam,
  };
}
```

### 7.2 useAgentTerminal

```typescript
function useAgentTerminal(teammateId: string, termRef: RefObject<Terminal>) {
  useEffect(() => {
    if (!teammateId || !termRef.current) return;

    // Agent output → xterm
    const unsub = window.canvasWorkspace.agentTeam.onAgentOutput(
      teammateId,
      (data) => termRef.current?.write(data)
    );

    // xterm input → agent
    const disposable = termRef.current.onData((data) => {
      window.canvasWorkspace.agentTeam.sendInput(teammateId, data);
    });

    return () => { unsub(); disposable.dispose(); };
  }, [teammateId]);
}
```

## 8. Component Structure

```
renderer/src/components/
├── AgentNodeBody/
│   ├── index.tsx              # Main composite component
│   ├── AgentHeader.tsx        # Name, runtime badge, status, action buttons
│   ├── AgentTaskPanel.tsx     # Collapsible task list with status indicators
│   ├── AgentTerminal.tsx      # Xterm wrapper bound to agent runtime
│   └── AgentPlanReview.tsx    # Conditional plan approval panel
├── LeadAgentNodeBody/
│   ├── index.tsx              # Lead-specific composite
│   ├── GoalInput.tsx          # Team goal input field
│   ├── TeamProgress.tsx       # Overall progress bar + per-agent mini status
│   └── ResultSummary.tsx      # Post-completion synthesis display
├── WorkspaceAgentPanel/
│   ├── index.tsx              # Sidebar panel
│   ├── GoalInput.tsx          # Natural language input
│   ├── TeamList.tsx           # Overview of all teams in workspace
│   └── ChatHistory.tsx        # Conversation with workspace agent
└── CanvasNodeView/
    └── index.tsx              # Updated to render AgentNodeBody for type='agent'
```

## 9. Coordination Model: In-Process vs PTY

### 9.1 In-Process Mode (pulse-agent)

Existing `Team.runTeammateLoop()` drives execution. Team tools are injected directly into Engine. No MCP needed. Output is piped to xterm via `onText` callback.

```
Team.run()
  → runTeammateLoop(teammate)
    → teammate.claimTask()
    → teammate.run(prompt)     // Engine.run()
      → onText(delta)          // → xterm
    → teammate.completeTask()
```

### 9.2 PTY + MCP Mode (all runtimes)

Agents self-coordinate via MCP. The orchestration loop is different:

```
AgentTeamManager.runTeam()
  → start TeamMCPServer
  → for each teammate:
      spawn interactive CLI with MCP config
      write system prompt to PTY (role, team context, available MCP tools)
  → agents autonomously:
      call team_claim_task via MCP
      execute task
      call team_complete_task via MCP
      call team_claim_task for next task
      ... until no more tasks
  → AgentTeamManager monitors TaskList for completion
```

### 9.3 Hybrid Mode

A single team can mix modes — some teammates in-process, others via PTY:

```
Team "API Refactor"
├── analyst: claude-code (PTY + MCP)
├── coder: pulse-agent (in-process)     ← uses Engine directly
└── tester: codex (PTY + MCP)
```

The shared TaskList and Mailbox files are the same regardless of mode. In-process teammates call the API directly; PTY teammates call via MCP. Both operate on the same state.

## 10. Canvas ↔ Team Config Conversion

### 10.1 Canvas → Team Config

```typescript
function canvasToTeamConfig(
  frameNode: CanvasNode,
  agentNodes: CanvasNode[]
): TeamRunConfig {
  const lead = agentNodes.find(n => n.data.isLead);
  const teammates = agentNodes.filter(n => !n.data.isLead);

  return {
    name: frameNode.data.teamName || frameNode.data.label || frameNode.id,
    cwd: getCurrentWorkspaceCwd(),
    goal: frameNode.data.goal,
    lead: lead ? {
      id: lead.data.teammateId,
      runtime: lead.data.runtime,
      model: lead.data.model,
    } : undefined,
    teammates: teammates.map(n => ({
      id: n.data.teammateId,
      name: n.data.name,
      role: n.data.role,
      runtime: n.data.runtime,
      mode: n.data.mode,
      model: n.data.model,
      spawnPrompt: n.data.spawnPrompt,
    })),
    tasks: extractTasksFromNodes(agentNodes),
  };
}
```

### 10.2 Team Plan → Canvas Nodes

```typescript
function teamPlanToCanvas(
  plan: TeamPlan,
  framePosition: { x: number; y: number }
): CanvasNode[] {
  const nodes: CanvasNode[] = [];

  // Create frame node
  const frame = createDefaultNode('frame', framePosition.x, framePosition.y);
  frame.width = calculateFrameSize(plan.teammates.length);
  frame.data.isTeam = true;
  frame.data.teamName = plan.name || 'New Team';
  nodes.push(frame);

  // Create lead agent node
  const lead = createDefaultNode('agent', framePosition.x + 20, framePosition.y + 60);
  lead.data = { ...defaultAgentData(), isLead: true, name: 'Team Lead' };
  nodes.push(lead);

  // Create teammate agent nodes (auto-layout in grid)
  plan.teammates.forEach((t, i) => {
    const pos = calculateGridPosition(i, framePosition);
    const node = createDefaultNode('agent', pos.x, pos.y);
    node.data = {
      ...defaultAgentData(),
      teammateId: t.name,
      name: t.name,
      role: t.role,
      spawnPrompt: t.spawnPrompt,
      model: t.model,
    };
    nodes.push(node);
  });

  return nodes;
}
```

## 11. Error Handling

### 11.1 Agent Crash

- PTY process exits unexpectedly → detect via `pty:exit` event
- Update agent node status to 'failed'
- Mark in-progress task as failed
- Offer restart option in agent node UI

### 11.2 MCP Server Crash

- MCP server process exits → all agents in that team lose coordination
- AgentTeamManager detects and auto-restarts MCP server
- Agents retry MCP tool calls (built-in MCP retry in most clients)

### 11.3 Task Timeout

- AgentTeamManager monitors per-task duration
- If a task exceeds configurable timeout → notify user via agent node UI
- User decides: extend, reassign, or fail the task

## 12. Security Considerations

- MCP server runs locally (stdio transport), no network exposure
- Each teammate-id is scoped — agents can only operate as themselves in the MCP server
- PTY processes inherit workspace cwd, no access beyond project scope
- MCP config files stored in temp directory, cleaned up on team shutdown
