# 06｜工具系统设计

## 1. 工具层定位

工具系统是引擎“行动能力”的执行面，负责：
- 提供标准化工具协议（schema + execute）
- 暴露内置工具集合
- 承接插件工具与业务自定义工具
- 提供统一输出截断与执行上下文注入

## 2. 工具来源与合并优先级

最终工具池由三类来源合并：
1. 内置工具（`BuiltinToolsMap`）
2. 插件注册工具（`PluginManager.getTools()`）
3. `EngineOptions.tools`（业务直接传入，优先级最高）

## 3. 内置工具清单

| 工具 | 类型 | 说明 |
|---|---|---|
| `read` | read | 读取文件，支持 offset/limit |
| `write` | write | 写文件（覆盖写），自动建目录 |
| `edit` | write | 精确字符串替换，支持 replaceAll |
| `grep` | search | 基于 ripgrep 的内容检索 |
| `ls` | read | 列目录 |
| `bash` | execute | 执行 shell 命令 |
| `tavily` | search | 外部 web 搜索 |
| `clarify` | other | 向用户提问并等待回答 |

## 4. 工具调用链路

```mermaid
sequenceDiagram
    participant Loop as loop
    participant Hook as tool hooks
    participant Tool as real tool

    Loop->>Hook: beforeToolCall(name,input) x N
    Hook-->>Loop: maybe modified input
    Loop->>Tool: execute(finalInput, toolContext)
    Tool-->>Loop: output
    Loop->>Hook: afterToolCall(name,input,output) x N
    Hook-->>Loop: maybe modified output
    Loop-->>Loop: emit tool-result
```

## 5. 输入校验机制

所有内置工具都使用 Zod schema 描述输入。
优点：
- 模型调用工具时有明确参数结构
- 失败可以快速定位参数问题

典型约束示例：
- `write.filePath` 强调绝对路径
- `bash.timeout` 限制在 0~600000ms
- `edit` 要求 old/new 不同

## 6. 输出控制

`tools/utils.ts` 提供 `truncateOutput`：
- 超过 `MAX_TOOL_OUTPUT_LENGTH`（默认 30000）时截断中间内容
- 保留前后片段并标注截断字符数

目的：
- 防止大输出撑爆上下文
- 提升模型后续处理稳定性

## 7. ToolExecutionContext

由 `loop -> streamTextAI -> wrapToolsWithContext` 注入，包含：
- `onClarificationRequest`
- `abortSignal`

`clarify` 工具依赖此上下文：
- 若缺失回调直接报错
- 支持 timeout/defaultAnswer 机制

## 8. 代表性工具行为说明

### 8.1 `read`

- 若是目录会报错并提示使用 `ls`
- 支持按行读取并带行号输出
- 可返回 `totalLines`

### 8.2 `edit`

- 默认要求 `oldString` 在文件中唯一
- 若重复出现会提示扩大上下文或使用 `replaceAll`
- 返回替换次数与变更预览

### 8.3 `grep`

- 动态拼接 `rg` 命令
- 支持 output mode、glob、type、context、offset/headLimit
- `status=1` 视为无匹配而非异常

### 8.4 `bash`

- 使用 `execSync` 执行
- 返回 stdout/stderr/exitCode
- 超时返回带 timeout 信息

## 9. 安全与稳定性观察

- 多数文件与命令工具使用同步 API（`*Sync`），可能阻塞事件循环。
- 目前没有工作区沙箱隔离（路径校验、命令 allowlist 由上层策略决定）。
- `grep` / `bash` 使用 shell 拼接字符串，虽有基础 quoting，但仍建议长期改为无 shell 参数传递。

## 10. 建议演进

1. 工具执行统一改为 async（`fs/promises`、`spawn`）并支持取消。
2. 引入工具级权限模型（read-only / write / execute / network）。
3. 为高风险工具增加审计字段（who/when/args/result hash）。
4. 实现“工具预算”机制（单次 run 最大调用次数/总耗时）。

---

本章结论：工具体系已形成统一协议和基础安全控制，下一阶段应重点补足“异步化、权限化、可审计化”。