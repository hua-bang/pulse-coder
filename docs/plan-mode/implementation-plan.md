# Plan Mode 改动计划

## 目标
- 给 CLI 增加可控命令：`/plan`、`/execute`、`/mode`。
- Engine 提供统一 mode 门面（`getMode`/`setMode`），但不承载 plan 规则。
- `plan-mode-plugin` 继续作为状态与策略的唯一实现方。

## 设计边界
- Engine 只做“查找插件服务 + 转发调用”。
- 插件继续维护 mode 状态、提示词注入、策略事件。
- CLI 只负责命令解析与用户反馈，不直接碰插件内部细节。

## 具体改动文件
- `packages/engine/src/Engine.ts`
  - 新增（type-only）导入 `PlanMode` / `PlanModeService`。
  - 新增私有 helper：获取 plan 服务实例（通过 `getService(...)`）。
  - 新增 `getMode(): PlanMode | undefined`。
  - 新增 `setMode(mode: PlanMode, reason?: string): boolean`（服务缺失时返回 `false`）。
- `packages/cli/src/index.ts`
  - `help` 增加三条命令说明。
  - `handleCommand` 新增 case：`plan` / `execute` / `mode`。
  - 调用 agent 对应 mode API，并处理服务不可用时的提示。
- 可能需要（按现有导出情况决定）：`packages/engine/src/index.ts`
  - 确保 `PlanMode` 类型可被 CLI 侧引用（若 CLI 需要强类型）。

## 实现顺序
1. 确认 `plan-mode-plugin` 的服务注册名与类型导出。
2. 修改 `Engine.ts`，添加 mode 薄封装 API。
3. 如 `PulseAgent` 尚无转发方法，补充转发到 engine。
4. 修改 CLI 命令与 help 文案。
5. 运行类型检查/构建并修正。
6. 输出变更摘要与验证结果。

## 兼容与容错策略
- 插件未加载时：
  - `/mode` 输出 "plan mode plugin unavailable"。
  - `/plan`、`/execute` 输出切换失败提示，不中断会话。
- 默认行为不变：未使用命令时按插件当前默认 mode 运行。

## 验证清单
- `/mode` 可读当前模式。
- `/plan` 后再 `/mode` 为 planning。
- `/execute` 后再 `/mode` 为 executing。
- `/help` 出现三条新命令。
- 构建/类型检查通过。
