# Harness Engineering Roadmap

> Canvas as Agent Workbench — 人与 AI 共享的工作台

## 核心理念

Canvas Harness 的本质：**Canvas 节点是 Agent 的标准 I/O 接口**。

- `read` — 给 Agent 信息（感知）
- `write` — 让 Agent 修改内容型节点
- `exec` — 让 Agent 操控交互型节点（执行）

人和 Agent 拥有对等能力，区别只是交互方式（人拖拽 UI vs Agent 调 MCP API）。Canvas 既是编排环境，也是运行时视图，Agent 的每次操作天然可观测。

```
人（拖拽/编辑）  ──┐
                   ├──→  Canvas Nodes  ──→  文件系统 / shell / API
AI（read/write/exec）─┘
```

## 节点能力模型

### 两类节点

| 类型 | 节点 | 能力 | 说明 |
|------|------|------|------|
| **内容型** | file, frame | `read` + `write` | 数据容器，写操作是幂等的 |
| **交互型** | terminal | `read` + `exec` | 执行器，exec 是指令式的 |

### 统一接口

```typescript
// 所有节点都实现 read
interface NodeReadable {
  read(): Promise<NodeContent>;
}

// 内容型节点额外实现 write
interface NodeWritable {
  write(content: string): Promise<{ ok: boolean; error?: string }>;
}

// 交互型节点额外实现 exec
interface NodeExecutable {
  exec(command: string): Promise<{ ok: boolean; output?: string; error?: string }>;
}
```

### read() 返回值带 type 标识

```typescript
// file node
{ type: 'file', path: '/path/to/file.ts', content: '...', language: 'typescript' }

// terminal node
{ type: 'terminal', cwd: '/home/user/project', scrollback: '...' }

// frame node
{ type: 'frame', label: 'Group A', color: '#9065b0' }
```

Agent 根据 type 决定如何使用内容，无需提前知道节点类型。

## MCP 工具设计

### 最终 MCP 工具集（5 个）

| 工具 | 说明 | 现状 |
|------|------|------|
| `canvas_list` | 列出节点，返回 id/type/title + 能力标记 | ✅ 已有，需增强 |
| `canvas_read` | 读取节点内容 | ✅ 已有，需统一返回格式 |
| `canvas_write` | 写入内容型节点 | ✅ 已有，基本可用 |
| `canvas_exec` | 向交互型节点发送命令 | ❌ 新增 |
| `canvas_create` | 创建新节点 | ❌ 新增 |

### canvas_list 增强

返回每个节点的能力标记，Agent 可据此决定使用 write 还是 exec：

```json
{
  "nodeId": "node-123",
  "type": "terminal",
  "title": "Terminal",
  "capabilities": ["read", "exec"]
}
```

### canvas_exec 设计

```typescript
{
  name: 'canvas_exec',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      nodeId: { type: 'string' },
      command: { type: 'string', description: 'Command to execute' },
      waitForOutput: { type: 'boolean', description: 'Wait for command output (default: true)' },
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' }
    },
    required: ['workspaceId', 'nodeId', 'command']
  }
}
```

**执行流程：**

1. 找到 terminal node 对应的 PTY session
2. 向 PTY 写入 command + `\n`
3. 若 `waitForOutput=true`，收集输出直到 shell prompt 返回或超时
4. 返回 `{ ok: true, output: '...' }`

**关键挑战：MCP server 运行在 main process，可直接访问 PTY sessions map。** 不需要通过 renderer IPC 中转。

### canvas_create 设计

```typescript
{
  name: 'canvas_create',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      type: { type: 'string', enum: ['file', 'terminal', 'frame'] },
      title: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      data: {
        type: 'object',
        description: 'Initial data. File: { content }. Frame: { color, label }. Terminal: {}.'
      }
    },
    required: ['workspaceId', 'type']
  }
}
```

**注意：** canvas_create 写入 canvas.json 后，需要通知 renderer 刷新。方案：
- 短期：renderer 轮询或 file watcher 检测 canvas.json 变更
- 中期：MCP server 通过 BrowserWindow.webContents.send() 推送 IPC 事件

## 实施计划

### Phase 1: 节点 IO 抽象层

**目标：** 在 MCP server 中建立统一的节点读写执行抽象。

**改动文件：**
- `apps/canvas-workspace/src/main/mcp-server.ts` — 重构 readNode/writeNode，新增 execNode
- `apps/canvas-workspace/src/renderer/src/types.ts` — 扩展类型定义

**具体任务：**

1. 定义 `NodeCapability` 类型和能力映射表：
   ```typescript
   type NodeCapability = 'read' | 'write' | 'exec';
   const NODE_CAPABILITIES: Record<string, NodeCapability[]> = {
     file: ['read', 'write'],
     terminal: ['read', 'exec'],
     frame: ['read', 'write'],
   };
   ```

2. 统一 `readNode()` 返回格式，带 type 标识

3. 为 terminal 节点实现 `execNode()` — 需要从 MCP server 访问 PTY sessions

### Phase 2: canvas_exec 实现

**目标：** Agent 能向 terminal 节点发送命令并获取输出。

**改动文件：**
- `apps/canvas-workspace/src/main/mcp-server.ts` — 新增 canvas_exec 工具
- `apps/canvas-workspace/src/main/pty-manager.ts` — 导出 sessions map 或提供 exec API

**具体任务：**

1. 从 pty-manager 导出执行能力：
   ```typescript
   export function execInSession(
     sessionId: string,
     command: string,
     opts?: { timeout?: number }
   ): Promise<{ ok: boolean; output?: string; error?: string }>
   ```

2. 实现输出收集：
   - 向 PTY 写入命令
   - 监听 onData 收集输出
   - 检测 shell prompt 或超时后返回
   - 使用 marker 技术（写入前后各插入唯一标记）精确截取命令输出

3. 在 MCP server 注册 `canvas_exec` 工具

### Phase 3: canvas_create 实现

**目标：** Agent 能动态创建画布节点。

**改动文件：**
- `apps/canvas-workspace/src/main/mcp-server.ts` — 新增 canvas_create 工具
- `apps/canvas-workspace/src/main/canvas-store.ts` — 可能需要节点创建辅助函数

**具体任务：**

1. 实现 `createNode()`：
   - 生成节点 ID
   - 使用默认尺寸（复用 nodeFactory 的默认值逻辑）
   - 自动计算位置（若未指定，找画布空白区域放置）
   - 写入 canvas.json

2. terminal 节点创建后自动 spawn PTY session

3. file 节点创建后自动创建 workspace note 文件

4. 通知 renderer 刷新（短期用 file watcher，中期用 IPC push）

### Phase 4: canvas_list 增强 + 闭环验证

**目标：** 完善发现能力，验证 Agent 能跑通完整闭环。

**具体任务：**

1. `canvas_list` 返回增加 `capabilities` 字段

2. `canvas_read` 返回增加 `type` 字段

3. 端到端验证场景：
   ```
   Agent: canvas_list() → 发现节点
   Agent: canvas_create(terminal) → 创建 terminal
   Agent: canvas_exec(terminal, "npm test") → 跑测试
   Agent: canvas_read(terminal) → 看结果
   Agent: canvas_read(file) → 看代码
   Agent: canvas_write(file, newContent) → 改代码
   Agent: canvas_exec(terminal, "npm test") → 重跑测试
   → 闭环完成
   ```

4. 错误处理完善：
   - exec 不存在的 session → 自动 spawn 或报错
   - write 到只读节点 → 清晰错误提示
   - create 到不存在的 workspace → 自动创建或报错

## Renderer 同步策略

MCP server 直接操作 canvas.json 和 PTY，但 renderer 需要感知这些变更：

| 操作 | 同步方式 |
|------|---------|
| `canvas_write` (file) | file-watcher 已有，自动同步 ✅ |
| `canvas_write` (frame) | 需要 canvas.json watcher 或 IPC push |
| `canvas_create` | 需要 canvas.json watcher 或 IPC push |
| `canvas_exec` | terminal 输出自动通过 PTY onData 到 renderer ✅ |

**短期方案：** 添加 canvas.json 的 file watcher，检测到变更后 renderer 重新 load。
**中期方案：** MCP server 持有 BrowserWindow 引用，直接 `webContents.send('canvas:mcp-updated', data)`。

## 不在本次范围

- 新节点类型（agent node、log node、cli node）— 后续基于 harness 接口接入
- Agent-teams / 多 agent 编排 — 单 agent 闭环跑通后再考虑
- 权限控制 — 后续按需加 exec 确认机制
- Remote canvas — 当前仅本地 Electron 环境

## 文件变更清单

```
apps/canvas-workspace/src/main/
  ├── mcp-server.ts        # 核心改动：重构 + 新增 exec/create
  ├── pty-manager.ts        # 导出 exec 能力
  └── canvas-store.ts       # 可能需要节点创建辅助

apps/canvas-workspace/src/renderer/src/
  ├── types.ts              # 扩展 NodeCapability 类型
  └── hooks/useNodes.ts     # 添加 canvas.json 外部变更监听
```

## 验收标准

- [ ] Agent 通过 `canvas_list` 能发现所有节点及其能力
- [ ] Agent 通过 `canvas_read` 能读取所有节点类型，返回带 type 的结构化内容
- [ ] Agent 通过 `canvas_write` 能写入 file/frame 节点，renderer 实时同步
- [ ] Agent 通过 `canvas_exec` 能在 terminal 节点执行命令并获取输出
- [ ] Agent 通过 `canvas_create` 能创建新节点，renderer 实时展示
- [ ] 完整闭环：Agent 自主创建 terminal → 执行命令 → 读结果 → 改代码 → 重新执行
