# 06 | Tool System Design

## 1. Tool Layer Positioning

The tool system is the engine’s action execution layer. It is responsible for:
- Standardized tool protocol (`schema + execute`)
- Built-in tool set exposure
- Accepting plugin tools and business custom tools
- Unified output truncation and execution context injection

## 2. Tool Sources and Merge Priority

Final tool pool is merged from:
1. Built-in tools (`BuiltinToolsMap`)
2. Plugin-registered tools (`PluginManager.getTools()`)
3. `EngineOptions.tools` (caller-provided, highest priority)

## 3. Built-in Tool List

| Tool | Type | Description |
|---|---|---|
| `read` | read | Read files with optional offset/limit |
| `write` | write | Write file (overwrite), auto create directories |
| `edit` | write | Exact string replacement, supports `replaceAll` |
| `grep` | search | Content search based on ripgrep |
| `ls` | read | List directory contents |
| `bash` | execute | Execute shell command |
| `tavily` | search | External web search |
| `clarify` | other | Ask user and wait for answer |

## 4. Tool Invocation Chain

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

## 5. Input Validation

All built-in tools define input via Zod schema.
Benefits:
- LLM gets clear parameter structure for tool calls
- Invalid input failures are easier to diagnose

Typical constraints:
- `write.filePath` expects absolute path
- `bash.timeout` bounded in `0~600000ms`
- `edit` requires old/new strings to differ

## 6. Output Control

`tools/utils.ts` provides `truncateOutput`:
- If output exceeds `MAX_TOOL_OUTPUT_LENGTH` (default 30000), middle section is truncated
- Keep head/tail with a marker of truncated char count

Purpose:
- Prevent large outputs from blowing up context
- Improve stability for subsequent model reasoning

## 7. `ToolExecutionContext`

Injected through `loop -> streamTextAI -> wrapToolsWithContext`, including:
- `onClarificationRequest`
- `abortSignal`

`clarify` tool depends on this context:
- Throws if callback is missing
- Supports timeout/defaultAnswer behavior

## 8. Representative Tool Behavior

### 8.1 `read`

- Throws on directory path and suggests using `ls`
- Supports line-range reading with line numbers
- Can return `totalLines`

### 8.2 `edit`

- By default requires `oldString` to be unique in file
- If multiple matches found, prompts for broader context or `replaceAll`
- Returns replacement count and change preview

### 8.3 `grep`

- Dynamically builds `rg` command
- Supports output mode, glob, type, context, offset/headLimit
- `status=1` is treated as no-match, not an error

### 8.4 `bash`

- Executes via `execSync`
- Returns stdout/stderr/exitCode
- Timeout returns timeout-specific message

## 9. Security and Stability Observations

- Most file/command tools currently use sync APIs (`*Sync`), which may block event loop.
- No built-in workspace sandbox isolation yet (path/command policy is left to upper layer).
- `grep` / `bash` rely on shell command composition; basic quoting exists, but long-term should move toward argument-based no-shell execution.

## 10. Suggested Evolution

1. Move tool execution to async (`fs/promises`, `spawn`) with cancellation.
2. Introduce tool-level permission model (`read-only/write/execute/network`).
3. Add audit fields for high-risk tools (who/when/args/result hash).
4. Add tool budget controls (max calls / total tool time per run).

---

Conclusion: The tool system already has a unified protocol and baseline safety controls. Next phase should focus on async execution, permission controls, and auditability.
