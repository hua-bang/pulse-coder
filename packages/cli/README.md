# @coder/cli

Coder CLI 是一个智能命令行助手，基于 `@coder/engine` 构建，自动包含 MCP 和 Skills 功能。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 运行
npm start
```

## 功能特性

- ✅ **内置 MCP 支持** - 无需额外配置
- ✅ **内置 Skills 系统** - 智能技能识别
- ✅ **会话管理** - 保存和恢复对话
- ✅ **命令模式** - 丰富的交互命令

## 使用示例

### 基本使用
```bash
# 直接启动
./dist/index.js

# 或者全局安装后
coder
```

### 内置功能示例

**MCP 功能**（自动加载）：
```
> 使用 mcp_eido_mind_search 搜索一些信息
```

**Skills 功能**（自动加载）：
```
> 帮我生成一个分支名
# 会自动使用 branch-naming 技能
```

### 会话管理命令

```
/new [title]           - 创建新会话
/resume <id>          - 恢复会话
/sessions             - 列出所有会话
/search <query>       - 搜索会话
/rename <id> <title>  - 重命名会话
/delete <id>          - 删除会话
/save                 - 保存当前会话
/status               - 显示会话状态
/exit                 - 退出并保存
```

## 配置文件

### MCP 配置
创建 `.coder/mcp.json`：
```json
{
  "servers": {
    "eido_mind": {
      "transport": "http",
      "url": "http://localhost:3060/mcp/server"
    }
  }
}
```

### Skills 配置
创建 `.coder/skills/<skill-name>/SKILL.md`：
```markdown
---
name: my-custom-skill
description: 我的自定义技能
---

# 技能内容...
```

## 架构优势

### 零配置体验
```typescript
// 之前需要显式配置
const engine = new Engine({
  enginePlugins: {
    plugins: [skillRegistryPlugin, mcpPlugin]
  }
});

// 现在自动包含
const engine = new Engine(); // 内置插件已自动加载
```

### 可扩展性
```typescript
// 仍然支持自定义插件
const engine = new Engine({
  enginePlugins: {
    plugins: [myCustomPlugin], // 额外插件
    dirs: ['.coder/engine-plugins'],
    scan: true
  }
});
```

### 选择性禁用
```typescript
// 如果需要禁用内置插件
const engine = new Engine({
  disableBuiltInPlugins: true,
  enginePlugins: {
    plugins: [onlyMCPPlugin] // 只使用部分内置功能
  }
});
```

## 开发

### 环境要求
- Node.js 18+
- TypeScript 5.0+

### 项目结构
```
src/
├── index.ts          # 主入口
├── session-commands.ts  # 会话管理
└── input-manager.ts     # 输入处理
```

### 构建
```bash
npm run build    # 构建 TypeScript
npm run dev      # 开发模式（带热重载）
npm run test     # 运行测试
```

## 依赖

- `@coder/engine` - 核心引擎（包含内置 MCP 和 Skills 插件）

无需额外依赖，所有核心功能都已内置！