# 文档五：OpenViking Memory 插件设计方案

## 1. 背景与目标

当前 `pulse-coder-engine` 已具备完整插件能力（生命周期 + Runtime Hooks），CLI 也具备 session 持久化基础（`~/.pulse-coder/sessions/*.json`）。

本设计目标是通过 **Engine Plugin** 的方式，为引擎增加长期记忆（Long-term Memory）能力，并与 OpenViking 的上下文数据库能力结合，实现：

1. **记忆召回**：在每次任务开始时自动检索相关记忆并注入推理上下文。
2. **记忆沉淀**：在任务结束后自动提取并写回结构化记忆。
3. **可观测可干预**：提供 `memory_search / memory_save / memory_forget` 工具以便调试和手动控制。
4. **低侵入集成**：尽量不改动 core loop，优先使用现有插件 hook 注入。

---

## 2. 范围定义

### 2.1 In Scope

- 新增 OpenViking Memory 插件（Engine Plugin）。
- 在 `beforeRun / afterRun` 注入自动记忆读写闭环。
- 可选在 `beforeLLMCall / afterLLMCall` 做轻量增强。
- 增加 Memory 工具供显式调用。
- 与 CLI session 标识打通（建议复用 `PULSE_CODER_TASK_LIST_ID`）。

### 2.2 Out of Scope（首版不做）

- 复杂多租户权限系统。
- 复杂记忆图谱冲突合并策略（先走简单去重）。
- UI 可视化管理页面。
- 完整 MCP server 开发（若 OpenViking 无 MCP，再单独评估）。

---

## 3. 现状与可复用能力

### 3.1 引擎可复用点

- 插件生命周期：`beforeInitialize` / `initialize` / `afterInitialize` / `destroy`
- Runtime Hooks：
  - `beforeRun` / `afterRun`
  - `beforeLLMCall` / `afterLLMCall`
  - `beforeToolCall` / `afterToolCall`
- 服务注册：`registerService` / `getService`
- 工具注册：`registerTool` / `registerTools`

### 3.2 CLI 可复用点

- 已有 session 管理和落盘。
- 已有 task list 绑定：`PULSE_CODER_TASK_LIST_ID` 可作为 memory session key 候选。

### 3.3 现有 MCP 能力

内置 MCP 插件已支持从 `.pulse-coder/mcp.json` 加载 HTTP MCP 服务。
若 OpenViking 提供 MCP 端点，可直接挂入；若无，则走 HTTP 直连客户端（推荐首版）。

---

## 4. 总体架构

```text
User Input
   │
   ▼
Engine.run()
   │
   ├─ beforeRun (Memory Recall)
   │     └─ OpenViking.search(...) -> 注入系统提示词/上下文
   │
   ├─ loop (LLM + Tools)
   │
   └─ afterRun (Memory Commit)
         ├─ 提取候选记忆
         ├─ OpenViking.save(...)
         └─ OpenViking.commit(...)
```

### 4.1 插件内部模块划分

1. `OpenVikingClient`：HTTP/MCP 适配层。
2. `MemoryExtractor`：从对话结果提取候选记忆（规则优先，LLM可选）。
3. `MemoryFormatter`：将召回结果格式化为 prompt block。
4. `MemoryPolicy`：阈值、去重、可写类型控制。

---

## 5. 生命周期注入设计（逐项）

## 5.1 `beforeInitialize(context)`

**职责**
- 校验必要配置（`baseUrl`, `apiKey`, `enabled` 等）。
- 失败即抛错，阻止插件初始化。

**建议逻辑**
- `enabled=false` 时直接 no-op。
- 缺必需项时抛出可读错误信息。

---

## 5.2 `initialize(context)`（核心）

**职责**
1. 创建并健康检查 OpenViking client。
2. 注册服务：`memory:openviking`。
3. 注册工具：
   - `memory_search`
   - `memory_save`
   - `memory_forget`（可选）
4. 注册 Runtime Hooks：
   - `beforeRun`
   - `afterRun`
   - （可选）`beforeLLMCall` / `afterLLMCall`

**关键点**
- 插件内所有外部 IO 异常应做降级，避免拖垮主流程。
- hook 内错误默认记录日志并继续，不应中断主回答（除非强一致场景）。

---

## 5.3 `afterInitialize(context)`

**职责**
- 预热（可选）：加载本地缓存、输出状态日志。
- 不做重型阻塞操作。

---

## 5.4 `destroy(context)`

**职责**
- flush 未提交 memory 队列（如有）。
- 关闭 OpenViking client 连接。

---

## 6. Runtime Hook 设计

## 6.1 `beforeRun`（推荐主召回入口）

**输入**：`context.messages`, `systemPrompt`, `tools`

**处理**：
1. 取最新 user message 作为查询。
2. 根据 `sessionId` + query 调用 OpenViking 检索。
3. 过滤低分结果，截断 topK。
4. 组装 `Relevant Memories` block，append 到 `systemPrompt`。

**输出**：返回新的 `systemPrompt`。

> 说明：`beforeRun` 每次 run 仅触发一次，最适合做“稳定注入”。

---

## 6.2 `beforeLLMCall`（可选）

**用途**
- 添加轻量约束，例如：
  - “记忆仅作为参考，不得编造事实”
  - “优先使用高置信记忆”

**注意**
- 该 hook 在 loop 内会多次触发，避免重复拼接大块记忆。

---

## 6.3 `afterLLMCall`（可选）

**用途**
- 对本次 LLM 输出做候选记忆抽取（轻量规则或异步任务）。
- 可累计到插件内临时缓冲区，最终在 `afterRun` 统一提交。

---

## 6.4 `afterRun`（推荐主写回入口）

**处理**
1. 汇总本轮用户输入 + assistant 结果。
2. 提取候选记忆（偏好、约束、长期事实、待办结论等）。
3. 去重与阈值过滤。
4. 调用 OpenViking 保存并提交 session。

**写回策略建议**
- 首版只写高价值信息：
  - 用户长期偏好（语言、风格、禁用项）
  - 项目稳定约束（架构、命名、工具链）
  - 已确认决策（不是临时推测）

---

## 6.5 `beforeToolCall / afterToolCall`（可选）

**用途**
- 记录工具使用轨迹（便于后续推断有效工作模式）。
- 对高价值工具结果（如测试失败根因）生成候选记忆。

---

## 7. 配置设计

建议新增配置命名空间：`memory.openviking`

```json
{
  "memory": {
    "enabled": true,
    "provider": "openviking",
    "openviking": {
      "baseUrl": "http://127.0.0.1:8080",
      "apiKey": "${OPENVIKING_API_KEY}",
      "timeoutMs": 5000,
      "topK": 5,
      "minScore": 0.35,
      "writeback": true,
      "autoCommit": true
    }
  }
}
```

### 7.1 Session ID 约定

优先级建议：
1. `process.env.PULSE_CODER_TASK_LIST_ID`
2. 当前 CLI session id
3. `default`

---

## 8. 插件对外工具定义（建议）

1. `memory_search(query, topK?)`
2. `memory_save(content, tags?)`
3. `memory_forget(uri | filter)`（可选）
4. `memory_debug_status()`（可选，返回缓存/队列状态）

工具目标是 **可观测 + 可人工兜底**，而不是替代自动流程。

---

## 9. 错误处理与降级策略

### 9.1 读路径（召回）
- 检索失败：记录 warning，跳过注入，主流程继续。
- 返回空：正常继续。

### 9.2 写路径（回写）
- 回写失败：记录 error，不中断答复。
- 可选：写入本地重试队列（后续版本）。

### 9.3 可靠性建议
- 统一超时控制（例如 3~5s）。
- 指数退避重试（仅幂等接口）。
- 打点监控：召回耗时、命中率、写回成功率。

---

## 10. 与其他插件的协同

1. **Plan Mode 插件**
   - 可把“计划阶段禁止执行偏好”写入 memory，供后续 run 提前约束。
2. **Task Tracking 插件**
   - 可将 task list id 作为 memory session key，增强上下文连续性。
3. **MCP 插件**
   - 若 OpenViking 有 MCP server，可复用 MCP 工具，memory 插件只做编排层。

---

## 11. 安全与隐私

- 不把密钥写入 session 文件或日志。
- 对写回内容做脱敏（token、凭据、URL query 参数）。
- 提供 `memory.writeback=false` 开关用于受限场景。
- 支持按项目/会话隔离命名空间。

---

## 12. 测试方案

### 12.1 单元测试（engine）

- `beforeRun`：可正确注入记忆块。
- `afterRun`：在结果满足条件时触发写回。
- OpenViking 异常时不影响主流程。
- sessionId 解析优先级正确。

### 12.2 集成测试（apps/pulse-agent-test）

- 模拟两轮对话：第一轮写入偏好，第二轮成功召回。
- 验证 topK/minScore 对召回结果的影响。

### 12.3 回归测试

- 启用/禁用 memory 插件对原有 loop 行为无破坏。
- 与内置插件并存无冲突。

---

## 13. 实施计划（建议）

### Phase 1（P0）：可用性打底
- 增加 `OpenVikingClient`（HTTP）。
- 注册 `memory_search`/`memory_save` 工具。

### Phase 2（P1）：自动召回
- 实现 `beforeRun` 注入。
- 增加召回过滤（topK/minScore）。

### Phase 3（P2）：自动写回
- 实现 `afterRun` 记忆提取 + commit。
- 加入基础去重规则。

### Phase 4（P3）：工程化增强
- 指标打点、重试队列、调试命令。
- 可选接入 MCP 版本客户端。

---

## 14. 目录与命名建议

建议新增：

```text
packages/engine/src/plugins/openviking-memory/
├── index.ts              # 插件入口
├── client.ts             # OpenViking HTTP/MCP 适配
├── extractor.ts          # 记忆提取策略
├── formatter.ts          # prompt 注入格式化
├── types.ts              # 配置与数据类型
└── openviking-memory.test.ts
```

---

## 15. 待确认事项（Open Questions）

1. OpenViking 当前优先接入方式：HTTP 直连还是 MCP？
2. 写回是否要求强一致（失败即失败）还是弱一致（失败降级）？
3. 是否允许跨项目共享用户偏好记忆？
4. 是否需要提供 `memory clear` 的 CLI 命令？

---

## 16. 结论

该方案可在不改 core loop 的前提下，通过现有插件机制完成 memory 能力闭环。
首版建议走 **HTTP 直连 + beforeRun/afterRun 主路径**，先拿到稳定收益；后续再补 `afterLLMCall` 深度提取与 MCP 化统一接入。
