# Coder 三包重构 - 主计划

## 目标
将 coder-demo 重构为 **插件化三包架构**，支持第三方 skill/mcp 扩展。

## 最终架构
```
@coder/engine          # 插件化AI引擎
@coder/skills          # skill协议实现  
@coder/cli             # CLI应用入口
```

## 迁移路线图

### 阶段1：项目骨架 (Day 1)
```bash
packages/
├── engine/            # 引擎层
├── skills/            # 技能层  
└── cli/               # CLI层
```

### 阶段2：引擎迁移 (Day 2-4)
- 迁移优先级：
  1. `src/loop.ts` → `engine/src/core/loop.ts`
  2. `src/ai.ts` → `engine/src/extensions/ai-protocol.ts`
  3. `src/tools/` → `engine/src/extensions/tool-protocol.ts/`
  4. `src/compaction.ts` → `engine/src/extensions/context-protocol.ts`

### 阶段3：技能系统 (Day 5-6)
- 创建 `@coder/skills` 包
- 实现 skill 扩展协议
- 迁移现有技能实现

### 阶段4：CLI整合 (Day 7)
- 创建 `@coder/cli` 包
- 迁移 `src/core.ts`
- 实现插件配置系统

### 阶段5：验证完成 (Day 8)
- 端到端测试
- 性能对比验证
- 文档更新

## 文件映射表

| 原文件 | 新位置 | 状态 |
|--------|--------|------|
| `src/loop.ts` | `engine/src/core/loop.ts` | ⏳ |
| `src/ai.ts` | `engine/src/extensions/ai.ts` | ⏳ |
| `src/tools/` | `engine/src/extensions/tools/` | ⏳ |
| `src/compaction.ts` | `engine/src/extensions/context.ts` | ⏳ |
| `src/skill/` | `skills/src/registry/` | ⏳ |
| `src/core.ts` | `cli/src/cli.ts` | ⏳ |

## 每日检查清单

### Day 1：项目初始化
- [ ] 创建三包目录结构
- [ ] 配置 pnpm workspace
- [ ] 设置基础构建配置
- [ ] 确保能 `pnpm build`

### Day 2-4：引擎迁移
- [ ] 迁移 loop 逻辑
- [ ] 迁移 AI 客户端
- [ ] 迁移工具系统
- [ ] 迁移上下文管理

### Day 5-6：技能系统
- [ ] 实现 skill 协议
- [ ] 迁移技能注册表
- [ ] 技能发现机制

### Day 7：CLI整合
- [ ] 迁移 CLI 入口
- [ ] 插件配置系统
- [ ] 集成测试

### Day 8：验证完成
- [ ] 所有测试通过
- [ ] 性能不降级
- [ ] 文档更新

## 技术规范

### 包配置模板
```json
{
  "name": "@coder/engine",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./types": "./dist/types.js"
  }
}
```

### 命名规范
- 文件：kebab-case
- 类型：PascalCase
- 函数：camelCase

## 风险与回滚

### 回滚策略
1. 保留 `coder-demo` 原项目
2. 使用 git 分支管理
3. 每阶段完成后打 tag

### 验证检查
- ✅ 功能完整性
- ✅ 性能不降级
- ✅ 插件接口稳定

## 下一步行动
直接执行 Day 1 的项目初始化，然后开始逐日迁移。