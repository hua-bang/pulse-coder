# 🚀 Pulse Coder - AI-Powered Coding Assistant

**Pulse Coder** is a plugin-based AI coding assistant designed for developers, providing intelligent code generation, refactoring, debugging, and project development support. It combines modern AI technology with a flexible plugin architecture to adapt to various development scenarios.

## 📖 Documentation
- [English README](./README.md) ← Current document
- [中文 README](./README-CN.md)

## ✨ Core Features

- **🧠 Intelligent Dialogue**: AI engine based on OpenAI with natural language interaction support
- **🔧 Plugin System**: Modular skill system with extensible architecture design
- **💾 Session Management**: Support for session saving, recovery, search, and management
- **⚡ Real-time Response**: Streaming output with interrupt support and real-time tool calls
- **🎯 Multi-language Support**: TypeScript/JavaScript priority with support for multiple programming languages
- **📱 Cross-platform**: CLI tool that can run in any terminal environment

## 📁 Project Structure

```
pulse-coder/
├── 📦 packages/              # Core packages
│   ├── 🎯 cli/              # Command line interface
│   ├── ⚙️ engine/           # AI engine core
│   └── 🛠️ skills/           # Skill system
├── 📱 apps/                 # Application examples
│   ├── 🎮 coder-demo/       # Demo application
│   ├── 🐍 snake-game/       # Snake game
│   └── 🌐 personal-portfolio/# Personal portfolio
├── 📋 docs/                 # Documentation directory
├── 🚀 build.sh             # Build script
├── 🔄 fix-imports.sh       # Import fix script
└── ⚡ quick-start.sh       # Quick start script
```

## 🏗️ Technology Stack

| Technology | Purpose | Version |
|---|---|---|
| **TypeScript** | Main development language | ^5.0.0 |
| **Node.js** | Runtime environment | 18+ |
| **pnpm** | Package manager | 10.28.0 |
| **AI SDK** | AI engine | ^6.0.57 |
| **OpenAI** | LLM provider | ^3.0.21 |
| **Vitest** | Testing framework | ^1.0.0 |
| **tsup** | Build tool | ^8.0.0 |

## 🚀 Quick Start

### 1. Install Dependencies

```bash
# Install pnpm (if not already installed)
npm install -g pnpm

# Install project dependencies
pnpm install
```

### 2. Environment Configuration

Create `.env` file:
```bash
cp .env.example .env
```

Edit `.env` file and add your OpenAI API key:
```env
OPENAI_API_KEY=your_openai_api_key_here
```

### 3. Build Project

```bash
# Build all packages
pnpm run build

# Or use build script
./build.sh
```

### 4. Start CLI

```bash
# Start interactive CLI
pnpm start

# Or run directly
./quick-start.sh
```

## 💻 Development Guide

### Package Structure Details

#### 📦 pulse-coder-engine
**AI engine core**, providing:
- LLM integration and conversation management
- Plugin system support
- Context management
- Tool invocation mechanism

```typescript
// Basic usage example
import { Engine } from 'pulse-coder-engine';

const engine = new Engine({
  plugins: [yourPlugin]
});

const result = await engine.run(context, options);
```

#### 🛠️ @pulse-coder/skills
**Skill system**, including:
- Code refactoring skills
- Code review skills
- Git workflow skills
- Research analysis skills

#### 🎯 @pulse-coder/cli
**Command line interface**, features include:
- Interactive session management
- Real-time dialogue interface
- Session persistence
- Command system support

### 🎮 CLI Commands

After starting CLI, you can use the following commands:

#### Session Management
- `/new [title]` - Create new session
- `/resume <id>` - Resume saved session
- `/sessions` - List all sessions
- `/save` - Save current session
- `/delete <id>` - Delete session

#### Search and Management
- `/search <query>` - Search session content
- `/rename <id> <new-title>` - Rename session
- `/status` - View current session status
- `/clear` - Clear current conversation

#### Help and Exit
- `/help` - Show help information
- `/exit` - Exit application

### 🧪 Development Mode

```bash
# Start development mode for all packages
pnpm run dev

# Start development mode for specific package
pnpm --filter @pulse-coder/cli dev
pnpm --filter pulse-coder-engine dev
pnpm --filter @pulse-coder/skills dev
```

### 🚢 Multi-package Release

You can now release `cli`, `engine`, `pulse-sandbox`, and other workspace packages with one command:

```bash
# Default: release every package in packages/* with prerelease(alpha) + build + publish
pnpm release

# Release only core packages (engine + cli)
pnpm release:core

# Target selected packages with a specific bump strategy
pnpm release -- --packages=engine,cli --bump=patch --tag=latest

# Publish only (skip auto version bump and build)
pnpm release -- --packages=engine,cli --skip-version --skip-build

# Preview commands without mutating or publishing
pnpm release -- --packages=engine,cli --dry-run
```

Available flags:
- `--packages`: package directory names or package names, comma-separated, e.g. `engine,cli`
- `--bump`: `major | minor | patch | prerelease | premajor | preminor | prepatch`
- `--preid`: prerelease identifier, default `alpha`
- `--tag`: npm dist-tag, defaults to `alpha` for prerelease bumps and `latest` for stable bumps
- `--skip-version`: skip version bump
- `--skip-build`: skip build step
- `--dry-run`: print plan and commands only

### 🧪 Testing

```bash
# Run all tests
pnpm test

# Run tests for specific package
pnpm --filter pulse-coder-engine test
```

## 📱 Application Examples

### 🎮 coder-demo
Basic demo application showing how to integrate Pulse Coder engine:

```bash
cd apps/coder-demo
pnpm install
pnpm dev
```

### 🐍 snake-game
Snake game built with Pulse Coder:

```bash
cd apps/snake-game
# Open index.html directly in browser
```

### 🌐 personal-portfolio
Personal portfolio website template:

```bash
cd apps/personal-portfolio
# In development...
```

## 🔧 Advanced Usage

### Custom Skill Development

Create custom skill plugins:

```typescript
// my-skill.ts
import { Skill } from '@pulse-coder/skills';

export const mySkill: Skill = {
  name: 'my-skill',
  description: 'My custom skill description',
  parameters: z.object({
    // Define parameters
  }),
  execute: async (params) => {
    // Implement skill logic
    return { result: 'success' };
  }
};
```

### Session Management

Pulse Coder automatically saves all sessions to local storage, supporting:
- Session history viewing
- Context recovery
- Keyword search
- Session tag management

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API key | Required |
| `OPENAI_BASE_URL` | OpenAI API base URL | `https://api.openai.com/v1` |
| `MODEL_NAME` | Model name to use | `gpt-4` |
| `MAX_TOKENS` | Maximum tokens | `4000` |

## 🤝 Contribution Guidelines

We welcome all forms of contributions!

### Development Environment Setup

1. Fork the project
2. Clone locally
3. Install dependencies: `pnpm install`
4. Create feature branch: `git checkout -b feature/your-feature`
5. Commit changes: `git commit -m 'Add some feature'`
6. Push branch: `git push origin feature/your-feature`
7. Create Pull Request

### Code Standards

- Use TypeScript
- Follow ESLint configuration
- Add appropriate tests
- Update relevant documentation

## 📄 License

This project is open source under the [MIT License](LICENSE).

## 🙋‍♂️ Support and Community

- **Issue reporting**: Submit via [GitHub Issues](https://github.com/your-repo/issues)
- **Feature requests**: Welcome to submit Issues or Pull Requests
- **Discussion**: Join our technical discussion group

---

<p align="center">
  <strong>🚀 Make AI your programming assistant!</strong>
</p>

<p align="center">
  <sub>Built with ❤️ by developers, for developers</sub>
</p>