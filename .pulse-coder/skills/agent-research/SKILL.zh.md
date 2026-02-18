---
name: agent-research
description: Strict research and design workflow for general coding-agent loops with evidence-backed benchmarking, iterative user discussion, and explicit execution handoff.
description_zh: 强约束的通用 coding-agent loop 调研与设计流程：证据化对标、迭代讨论、明确执行确认。
version: 1.1.0
author: Pulse Coder Team
---

# Agent Research & Design Skill (Strict)

## Goal

用于系统性调研并设计通用 Agent Loop / Coding Agent 能力体系，确保：
1. 原子能力定义完整且可落地；
2. 对标主流实现（pi-mono / OpenCode / Claude Code）有证据支持；
3. 方案输出可讨论、可迭代、可决策；
4. 在用户明确确认前，不进入执行实现。

---

## Non-Negotiable Rules（硬约束）

1. **先调研后设计，先设计后执行**  
   未完成调研与讨论收敛前，不得进入代码实现。

2. **所有关键结论必须可追溯到来源**  
   关键结论必须标注 URL；无来源的内容只能标记为“假设/推测”。

3. **事实与判断必须分离**  
   输出中必须显式区分：
   - `Fact`（可验证事实）
   - `Inference`（基于事实的推断）
   - `Proposal`（建议方案）

4. **最少调研深度要求**  
   - 至少 **8 轮** 搜索，最多 **12 轮**；
   - 至少 **12 个唯一来源 URL**；
   - 至少覆盖 **3 个必选对象**：pi-mono、OpenCode、Claude Code。

5. **关键能力必须标准化描述**  
   每个原子能力必须包含：定义、输入、输出、触发条件、失败模式、恢复策略、成功指标。

6. **未获得明确确认，不得执行**  
   最终必须询问用户是否进入执行阶段；用户未明确 `Yes` 前，不进行实现类动作。

---

## Required Execution Flow

### Phase 0: Scope Alignment（范围对齐）

在开始调研前，先确认：
- 目标场景（CLI agent / IDE agent / server agent）
- 约束（时间、成本、模型、工具权限）
- 交付粒度（概念方案 / 技术设计 / 可执行任务清单）

若信息不足，先提问再继续。

---

### Phase 1: Atomic Capability Design（原子能力拆解）

先给出能力地图，建议至少覆盖：
- Task Understanding
- Planning
- Tool Use
- Context Management
- Code Execution Loop
- Reflection / Critique
- Safety & Guardrails
- Memory
- Human-in-the-loop
- Evaluation & Telemetry

每个能力必须用统一模板：
- 能力名
- 定义
- 输入
- 输出
- 触发条件
- 依赖工具/上下文
- 失败模式
- 恢复策略
- 成功指标（可量化优先）

---

### Phase 2: External Benchmarking（外部方案调研）

#### Mandatory Targets
- pi-mono
- OpenCode
- Claude Code

#### Optional Targets（建议）
- Cursor Agent
- Aider
- Copilot CLI

#### Research Constraints（强约束）
- 8-12 轮渐进式搜索（overview → architecture → loop mechanics → trade-offs → validation）
- 每轮说明：目标、查询词、新增发现、仍存疑问
- 至少 12 个唯一 URL
- 优先级：官方文档 > 源码/仓库 > 技术博客 > 二手解读
- 关键结论至少双来源交叉验证（若无法双证，标记“低置信度”）

---

### Phase 3: Synthesis & Proposal（综合与设计建议）

输出必须包含：

1. **原子能力清单（标准化定义）**
2. **对标矩阵（实现差异）**
3. **推荐架构（MVP / v1 / v2）**
4. **核心 trade-off（复杂度、成本、鲁棒性、扩展性）**
5. **风险清单与缓解策略**
6. **待决策问题清单（5-10项）**

并明确标记：
- 哪些结论是事实
- 哪些是推断
- 哪些是建议

---

### Phase 4: Discussion Loop（与用户迭代）

进入讨论模式后：
- 每轮给出“当前建议 + 3~5 个关键问题”
- 维护以下状态：
  - 已确认（Confirmed）
  - 待确认（Pending）
  - 被修改（Changed）
- 每轮结束更新一次决策快照

当待确认问题 ≤ 2，或用户表示“方案已收敛”，进入下一阶段。

---

### Phase 5: Execution Confirmation（执行确认）

必须使用明确问句：

> “方案已基本收敛。是否需要我进入执行阶段？可选：
> 1) 详细技术设计，
> 2) 任务拆解与排期，
> 3) 代码骨架，
> 4) 直接实现。”

- 若用户确认：再确认执行范围与边界后执行。
- 若用户拒绝：输出最终设计文档与后续建议，不执行代码改动。

---

## Required Output Artifacts

### A. Capability Spec Table
| Capability | Definition | Input | Output | Trigger | Failure Mode | Recovery | KPI |
|---|---|---|---|---|---|---|---|

### B. Benchmark Matrix
| System | Loop Pattern | Tool Strategy | Context Strategy | Safety Mechanism | Strengths | Limitations |
|---|---|---|---|---|---|---|

### C. Evidence Ledger
| Claim | Type (Fact/Inference) | Source URL | Confidence (High/Med/Low) | Notes |
|---|---|---|---|---|

### D. Roadmap
- MVP（2-4 周）
- v1（1-2 个月）
- v2（持续优化）

### E. Decision Log
- Confirmed
- Pending
- Changed

---

## Completion Criteria

仅当以下条件全部满足，才算完成本 skill：
- [ ] 完成 8+ 轮调研
- [ ] 提供 12+ 唯一来源
- [ ] 完成原子能力标准化定义
- [ ] 输出对标矩阵与证据台账
- [ ] 至少完成 1 轮与用户讨论迭代
- [ ] 明确询问并记录“是否执行”
