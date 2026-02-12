# 迁移指南：将 MCP 和 Skills 插件收敛到 Engine 内置

## 概述

本指南描述了如何将 `@coder/mcp-plugin` 和 `@coder/skills` 从独立的包迁移到 `@coder/engine` 的内置插件系统。

## 变更摘要

### 1. 架构变化
- **之前**: CLI 需要显式引入 `@coder/mcp-plugin` 和 `@coder/skills`
- **之后**: 这些功能作为 `@coder/engine` 的内置插件自动可用

### 2. 文件结构变化
```
packages/
├── engine/
│   └── src/
│       └── built-in/
│           ├── mcp-plugin/      # 内置 MCP 插件
│           ├── skills-plugin/   # 内置 Skills 插件
│           └── index.ts         # 插件导出
├── mcp-plugin/      # [保留] 仍可独立使用
├── skills/          # [保留] 仍可独立使用
└── cli/
    └── package.json # 移除对两个插件的依赖
```

## 使用方式变更

### 对于 CLI 开发者

**之前**:
```typescript
import { Engine } from '@coder/engine';
import { skillRegistryPlugin } from '@coder/skills';
import { mcpPlugin } from '@coder/mcp-plugin';

const engine = new Engine({
  enginePlugins: {
    plugins: [skillRegistryPlugin, mcpPlugin],  // 需要显式引入
    dirs: ['.coder/engine-plugins', '~/.coder/engine-plugins'],
    scan: true
  }
});
```

**之后**:
```typescript
import { Engine, builtInPlugins } from '@coder/engine';

const engine = new Engine({
  enginePlugins: {
    plugins: [...builtInPlugins],  // 自动包含内置插件
    dirs: ['.coder/engine-plugins', '~/.coder/engine-plugins'],
    scan: true
  }
});

// 或者更简洁：内置插件会自动加载，不需要显式配置
const engine = new Engine();
```

### 对于 Engine 用户

**直接使用内置插件**:
```typescript
import { Engine, builtInMCPPlugin, builtInSkillsPlugin } from '@coder/engine';

// 选择性地使用内置插件
const engine = new Engine({
  enginePlugins: {
    plugins: [builtInMCPPlugin], // 只使用 MCP 插件
    scan: false
  }
});
```

## 功能保持不变

### MCP 功能
- 配置文件位置: `.coder/mcp.json`
- 支持的传输方式: HTTP
- 工具命名空间: `mcp_{serverName}_{toolName}`

### Skills 功能
- 技能文件位置: `.coder/skills/**/SKILL.md`
- 用户级技能: `~/.coder/skills/**/SKILL.md`
- 技能工具: `skill` 工具保持不变

## 向后兼容性

### 独立包仍然可用
- `@coder/mcp-plugin` 和 `@coder/skills` 包继续存在
- 现有项目可以继续使用独立包
- 不会破坏现有集成

### 迁移建议
1. **新项目**: 直接使用内置插件
2. **现有项目**: 可以保持现有依赖，或逐步迁移到内置插件
3. **自定义需求**: 仍可使用独立包进行扩展

## 构建和开发

### 构建内置插件
```bash
# 在 engine 目录下
npm run build
```

### 测试内置功能
```bash
# 运行 CLI（会自动使用内置插件）
cd packages/cli
npm run dev
```

## 配置示例

### 使用内置插件的完整配置
```typescript
import { Engine, builtInPlugins } from '@coder/engine';

const engine = new Engine({
  enginePlugins: {
    plugins: [
      ...builtInPlugins,  // MCP + Skills 内置插件
      // 可以添加其他自定义插件
    ],
    dirs: ['.coder/engine-plugins'],
    scan: true
  },
  userConfigPlugins: {
    dirs: ['.coder/config'],
    scan: true
  }
});
```

## 优势

1. **简化依赖管理** - 减少外部依赖
2. **统一版本控制** - 插件与引擎同步版本
3. **零配置体验** - 开箱即用的功能
4. **更好的性能** - 内置优化
5. **向后兼容** - 不影响现有项目

## 注意事项

1. **依赖更新**: 需要确保 `@coder/engine` 包含新的依赖（glob, gray-matter, @ai-sdk/mcp）
2. **类型导出**: 内置插件的类型定义已更新
3. **配置路径**: 配置文件路径保持不变