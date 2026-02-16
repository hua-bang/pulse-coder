# 🚀 Pulse Coder - AI 驱动的编程助手

**Pulse Coder** 是一个基于插件的 AI 编程助手，专为开发者设计，提供智能代码生成、重构、调试和项目开发支持。它结合现代 AI 技术与灵活的插件架构，能够适应各种开发场景。

## 📖 文档导航
- [English README](./README.md)
- [中文 README](./README-CN.md) ← 当前文档

## ✨ 核心特性

- **🧠 智能对话**: 基于 OpenAI 的 AI 引擎，支持自然语言交互
- **🔧 插件系统**: 模块化技能系统，可扩展的架构设计
- **💾 会话管理**: 支持会话保存、恢复、搜索和管理
- **⚡ 实时响应**: 流式输出，支持中断和实时工具调用
- **🎯 多语言支持**: TypeScript/JavaScript 优先，支持多种编程语言
- **📱 跨平台**: CLI 工具，可在任何终端环境中运行

## 📁 项目结构

```
pulse-coder/
├── 📦 packages/              # 核心包
│   ├── 🎯 cli/              # 命令行界面
│   ├── ⚙️ engine/           # AI 引擎核心
│   └── 🛠️ skills/           # 技能系统
├── 📱 apps/                 # 应用示例
│   ├── 🎮 coder-demo/       # 演示应用
│   ├── 🐍 snake-game/       # 贪吃蛇游戏
│   └── 🌐 personal-portfolio/# 个人作品集
├── 📋 docs/                 # 文档目录
├── 🚀 build.sh             # 构建脚本
├── 🔄 fix-imports.sh       # 导入修复脚本
└── ⚡ quick-start.sh       # 快速启动脚本
```

## 🏗️ 技术栈

| 技术 | 用途 | 版本 |
|---|---|---|
| **TypeScript** | 主要开发语言 | ^5.0.0 |
| **Node.js** | 运行时环境 | 18+ |
| **pnpm** | 包管理器 | 10.28.0 |
| **AI SDK** | AI 引擎 | ^6.0.57 |
| **OpenAI** | LLM 提供商 | ^3.0.21 |
| **Vitest** | 测试框架 | ^1.0.0 |
| **tsup** | 构建工具 | ^8.0.0 |

## 🚀 快速开始

### 1. 安装依赖

```bash
# 安装 pnpm (如果尚未安装)
npm install -g pnpm

# 安装项目依赖
pnpm install
```

### 2. 环境配置

创建 `.env` 文件：
```bash
cp .env.example .env
```

编辑 `.env` 文件，添加你的 OpenAI API 密钥：
```env
OPENAI_API_KEY=your_openai_api_key_here
```

### 3. 构建项目

```bash
# 构建所有包
pnpm run build

# 或者使用构建脚本
./build.sh
```

### 4. 启动 CLI

```bash
# 启动交互式 CLI
pnpm start

# 或者直接运行
./quick-start.sh
```

## 💻 开发指南

### 包结构详解

#### 📦 pulse-coder-engine
**AI 引擎核心**，提供：
- LLM 集成和对话管理
- 插件系统支持
- 上下文管理
- 工具调用机制

```typescript
// 基本使用示例
import { Engine } from 'pulse-coder-engine';

const engine = new Engine({
  plugins: [yourPlugin]
});

const result = await engine.run(context, options);
```

#### 🛠️ @pulse-coder/skills
**技能系统**，包含：
- 代码重构技能
- 代码审查技能
- Git 工作流技能
- 研究分析技能

#### 🎯 @pulse-coder/cli
**命令行界面**，功能包括：
- 交互式会话管理
- 实时对话界面
- 会话持久化
- 命令系统支持

### 🎮 CLI 命令

启动 CLI 后，你可以使用以下命令：

#### 会话管理
- `/new [title]` - 创建新会话
- `/resume <id>` - 恢复已保存的会话
- `/sessions` - 列出所有会话
- `/save` - 保存当前会话
- `/delete <id>` - 删除会话

#### 搜索和管理
- `/search <query>` - 搜索会话内容
- `/rename <id> <new-title>` - 重命名会话
- `/status` - 查看当前会话状态
- `/clear` - 清空当前对话

#### 帮助和退出
- `/help` - 显示帮助信息
- `/exit` - 退出应用

### 🧪 开发模式

```bash
# 启动所有包的开发模式
pnpm run dev

# 单独启动某个包的开发模式
pnpm --filter @pulse-coder/cli dev
pnpm --filter pulse-coder-engine dev
pnpm --filter @pulse-coder/skills dev
```

### 🚢 多包发版

现在可以用一条命令同时发版 `cli`、`engine`、`pulse-sandbox` 等包：

```bash
# 默认：所有 packages/* 包执行 prerelease(alpha) + build + publish
pnpm release

# 只发 core 包（engine + cli）
pnpm release:core

# 指定包 + 指定版本策略
pnpm release -- --packages=engine,cli --bump=patch --tag=latest

# 仅发布（跳过自动改版本和构建）
pnpm release -- --packages=engine,cli --skip-version --skip-build

# 预演执行步骤，不真正发布
pnpm release -- --packages=engine,cli --dry-run
```

参数说明：
- `--packages`: 包目录名或包名，支持逗号分隔，如 `engine,cli`
- `--bump`: `major | minor | patch | prerelease | premajor | preminor | prepatch`
- `--preid`: 预发布标识，默认 `alpha`
- `--tag`: npm dist-tag，不传时预发布默认用 `alpha`，正式版本默认用 `latest`
- `--skip-version`: 跳过版本递增
- `--skip-build`: 跳过构建
- `--dry-run`: 只打印执行计划和命令

### 🧪 测试

```bash
# 运行所有测试
pnpm test

# 运行特定包的测试
pnpm --filter pulse-coder-engine test
```

## 📱 应用示例

### 🎮 coder-demo
基础演示应用，展示如何集成 Pulse Coder 引擎：

```bash
cd apps/coder-demo
pnpm install
pnpm dev
```

### 🐍 snake-game
使用 Pulse Coder 构建的贪吃蛇游戏：

```bash
cd apps/snake-game
# 直接在浏览器中打开 index.html
```

### 🌐 personal-portfolio
个人作品集网站模板：

```bash
cd apps/personal-portfolio
# 开发中...
```

## 🔧 高级用法

### 自定义技能开发

创建自定义技能插件：

```typescript
// my-skill.ts
import { Skill } from '@pulse-coder/skills';

export const mySkill: Skill = {
  name: 'my-skill',
  description: '我的自定义技能描述',
  parameters: z.object({
    // 定义参数
  }),
  execute: async (params) => {
    // 实现技能逻辑
    return { result: 'success' };
  }
};
```

### 会话管理

Pulse Coder 自动保存所有会话到本地存储，支持：
- 会话历史查看
- 上下文恢复
- 关键词搜索
- 会话标签管理

### 环境变量

| 变量 | 描述 | 默认值 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API 密钥 | 必填 |
| `OPENAI_BASE_URL` | OpenAI API 基础 URL | `https://api.openai.com/v1` |
| `MODEL_NAME` | 使用的模型名称 | `gpt-4` |
| `MAX_TOKENS` | 最大令牌数 | `4000` |

## 🤝 贡献指南

我们欢迎所有形式的贡献！

### 开发环境设置

1. Fork 项目
2. 克隆到本地
3. 安装依赖：`pnpm install`
4. 创建功能分支：`git checkout -b feature/your-feature`
5. 提交更改：`git commit -m 'Add some feature'`
6. 推送分支：`git push origin feature/your-feature`
7. 创建 Pull Request

### 代码规范

- 使用 TypeScript
- 遵循 ESLint 配置
- 添加适当的测试
- 更新相关文档

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。

## 🙋‍♂️ 支持与社区

- **问题反馈**: 通过 [GitHub Issues](https://github.com/your-repo/issues) 提交
- **功能请求**: 欢迎提交 Issue 或 Pull Request
- **讨论交流**: 加入我们的技术交流群组

---

<p align="center">
  <strong>🚀 让 AI 成为你的编程助手！</strong>
</p>

<p align="center">
  <sub>Built with ❤️ by developers, for developers</sub>
</p>