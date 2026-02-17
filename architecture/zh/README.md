# Pulse Coder Engine 架构文档（迭代版）

这套文档基于当前实现（`packages/engine/src`）整理，目标是：
- 给团队一个**能对齐代码**的架构视图；
- 支持后续功能迭代、重构、测试设计；
- 让新成员可以按顺序快速理解系统。

## 阅读顺序（推荐）

1. `01-engine-overview-and-goals.md`：先看边界和总体分层
2. `02-runtime-lifecycle-and-engine-run.md`：理解 `Engine` 生命周期
3. `03-agent-loop-core.md`：理解 Loop 执行内核
4. `04-llm-adapter-and-prompt.md`：理解模型接入和提示词装配
5. `05-context-compaction-strategy.md`：理解上下文压缩
6. `06-tool-system.md`：理解工具层与调用约束
7. `07-plugin-system.md`：理解插件机制与 hook 体系
8. `08-built-in-plugins.md`：理解内置插件能力
9. `09-config-and-operations.md`：理解配置、可运维、安全边界

## 文档范围

- ✅ 已覆盖：`Engine`、`loop`、`ai`、`context`、`tools`、`plugin`、`built-in`、`config`
- ⚠️ 部分实现仍是占位/轻实现（文中已标注）
  - 用户配置插件的“应用配置”阶段目前主要是日志与结构化预留
  - 部分工具使用同步 I/O（`fs.*Sync`、`execSync`）

## 代码基线

- 主目录：`packages/engine/src`
- 关键入口：`packages/engine/src/Engine.ts`
- 导出入口：`packages/engine/src/index.ts`

## 维护建议

每次架构相关改动后，至少同步更新：
- 主流程变化：`02`、`03`
- Hook/插件变化：`07`、`08`
- 模型与上下文策略变化：`04`、`05`
- 环境变量和默认策略变化：`09`

---

如果你准备继续做架构迭代，建议下一步直接补两件事：
1. 在每章追加“ADR 决策记录”小节；
2. 为 `03/07/08` 增加时序图（sequenceDiagram）版本，便于评审会上快速沟通。