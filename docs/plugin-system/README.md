# pulse-coder-engine 双轨插件系统设计文档

## 概述

pulse-coder-engine 采用分层插件架构，提供两套完全隔离的插件系统：

1. **引擎开发插件系统** - 为引擎开发者提供核心能力扩展
2. **用户配置插件系统** - 为终端用户提供个性化配置能力

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    pulse-coder-engine                        │
│  ┌─────────────────────┐    ┌─────────────────────┐    │
│  │  引擎开发插件系统    │    │  用户配置插件系统    │    │
│  │                     │    │                     │    │
│  │  - API 传入         │    │  - API 传入         │    │
│  │  - 目录扫描         │    │  - 目录扫描         │    │
│  │  - 核心能力扩展     │    │  - 配置化扩展       │    │
│  │  - 不可被覆盖       │    │  - 错误隔离         │    │
│  └─────────────────────┘    └─────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## 引擎开发插件系统

### 核心定位
为引擎开发者提供运行时扩展能力，支持新的 AI 协议、工具类型、上下文处理器等核心基础设施。

### 插件接口定义

```typescript
// 引擎开发插件接口
interface EnginePlugin {
  name: string;
  version: string;
  dependencies?: string[];
  
  // 生命周期钩子
  beforeInitialize?(context: EngineContext): Promise<void>;
  initialize(context: EngineContext): Promise<void>;
  afterInitialize?(context: EngineContext): Promise<void>;
  
  // 清理钩子
  destroy?(context: EngineContext): Promise<void>;
}

// 引擎上下文
interface EngineContext {
  // 工具注册
  registerTool(tool: Tool): void;
  registerTools(tools: Record<string, Tool>): void;
  
  // 配置管理
  getConfig<T>(key: string): T | undefined;
  setConfig<T>(key: string, value: T): void;
  
  // 日志系统
  logger: Logger;
  
  // 事件系统
  events: EventEmitter;
}
```

### 加载机制

#### 1. API 传入
```typescript
const engine = new Engine({
  enginePlugins: [mcpClientPlugin, subAgentPlugin]
});
```

#### 2. 目录扫描
```typescript
// 默认扫描路径
const DEFAULT_ENGINE_PLUGIN_DIRS = [
  '.coder/engine-plugins',
  '~/.coder/engine-plugins'
];

// 文件命名规范
// *.plugin.js - 插件主文件
// *.plugin.d.ts - 类型定义（可选）
```

### 插件生命周期

```
1. 发现阶段 → 2. 验证阶段 → 3. 初始化阶段 → 4. 运行阶段
   ↓           ↓           ↓           ↓
扫描目录    依赖检查    执行钩子    提供服务
API传入     版本兼容    注册能力    事件监听
```

### 内置插件示例

#### MCP 客户端插件
```typescript
// mcp-client.plugin.js
export default {
  name: 'pulse-coder-engine-mcp-client',
  version: '1.0.0',
  dependencies: ['pulse-coder-engine-core'],
  
  async initialize(context) {
    const mcpClient = new MCPClient();
    await mcpClient.connect();
    
    context.registerTool(createMcpTool(mcpClient));
    
    context.logger.info('MCP client plugin initialized');
  }
};
```

#### SubAgent 插件
```typescript
// sub-agent.plugin.js
export default {
  name: 'pulse-coder-engine-sub-agent',
  version: '1.0.0',
  
  async initialize(context) {
    const subAgentManager = new SubAgentManager();
    
    context.registerTool('subAgent', {
      name: 'subAgent',
      description: 'Execute tasks with specialized sub-agents',
      execute: async (input) => {
        return subAgentManager.execute(input);
      }
    });
  }
};
```

## 用户配置插件系统

### 核心定位
为终端用户提供声明式配置能力，无需编码即可扩展引擎功能。

### 配置格式

#### JSON 配置
```json
{
  "version": "1.0",
  "name": "my-project-config",
  "tools": {
    "customGit": {
      "type": "bash",
      "command": "git",
      "description": "Custom git operations"
    }
  },
  "prompts": {
    "system": "You are a helpful coding assistant..."
  },
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["@modelcontextprotocol/server-filesystem"]
      }
    ]
  },
  "subAgents": [
    {
      "name": "codeReviewer",
      "trigger": "code review",
      "prompt": "Review this code for best practices..."
    }
  ]
}
```

#### YAML 配置
```yaml
version: "1.0"
name: my-project-config

tools:
  customGit:
    type: bash
    command: git
    description: Custom git operations

prompts:
  system: You are a helpful coding assistant...

mcp:
  servers:
    - name: filesystem
      command: npx
      args: ["@modelcontextprotocol/server-filesystem"]

subAgents:
  - name: codeReviewer
    trigger: code review
    prompt: Review this code for best practices...
```

### 配置验证

```typescript
interface UserConfig {
  version: string;
  name?: string;
  
  // 工具配置
  tools?: Record<string, ToolConfig>;
  
  // 提示词配置
  prompts?: {
    system?: string;
    user?: string;
    assistant?: string;
  };
  
  // MCP 配置
  mcp?: {
    servers?: MCPServerConfig[];
  };
  
  // SubAgent 配置
  subAgents?: SubAgentConfig[];
  
  // 技能配置
  skills?: {
    directories?: string[];
    autoScan?: boolean;
  };
}
```

### 加载机制

#### 1. API 传入
```typescript
const engine = new Engine({
  userConfigs: [{
    tools: { /* ... */ },
    mcp: { /* ... */ }
  }]
});
```

#### 2. 目录扫描
```typescript
// 默认扫描路径
const DEFAULT_USER_CONFIG_DIRS = [
  '.coder/config',
  '~/.coder/config'
];

// 支持的文件格式
// config.json, config.yaml, config.yml
// *.config.json, *.config.yaml, *.config.yml
```

### 错误处理与隔离

```typescript
class UserConfigPlugin {
  async load(configPath: string) {
    try {
      const config = await this.parseConfig(configPath);
      await this.validateConfig(config);
      await this.applyConfig(config);
    } catch (error) {
      // 记录错误但不中断引擎运行
      this.logger.error(`Failed to load user config ${configPath}:`, error);
    }
  }
}
```

## 插件加载优先级

```
1. API 传入的引擎插件（最高优先级）
2. 目录扫描的引擎插件（按字母顺序）
3. API 传入的用户配置（中等优先级）
4. 目录扫描的用户配置（按字母顺序）
```

## 开发工具链

### 插件开发 CLI
```bash
# 创建引擎插件
coder-plugin create engine-plugin my-plugin

# 创建用户配置模板
coder-plugin create user-config my-config

# 验证插件
coder-plugin validate path/to/plugin

# 调试插件
coder-plugin dev path/to/plugin
```

### 类型支持
```typescript
// 引擎插件类型声明
import type { EnginePlugin, EngineContext } from 'pulse-coder-engine/engine-plugin';

// 用户配置类型声明
import type { UserConfig } from 'pulse-coder-engine/user-config';
```

## 迁移路径

### 从现有 skill 系统迁移
```typescript
// 现有 skill 配置自动转换为用户配置
const legacySkills = await scanLegacySkills();
const userConfig = convertToUserConfig(legacySkills);
```

## 测试策略

### 引擎插件测试
```typescript
describe('MCP Plugin', () => {
  it('should register MCP protocol handler', async () => {
    const context = createTestContext();
    await mcpPlugin.initialize(context);
    
    expect(context.getService('mcpClient')).toBeDefined();
  });
});
```

### 用户配置测试
```typescript
describe('User Config Validation', () => {
  it('should validate MCP server config', () => {
    const config = loadConfig('test/mcp-config.json');
    expect(validateConfig(config)).toBe(true);
  });
});
```

## 部署与发布

### 引擎插件发布
```bash
npm publish pulse-coder-engine-plugin-mcp
# 或
# 分发到 .coder/engine-plugins/
```

### 用户配置模板
```bash
# 社区配置模板仓库
# .coder/templates/mcp-basic.json
# .coder/templates/sub-agent-advanced.yaml
```

## 监控与调试

### 插件调试面板
```typescript
// 运行时信息
{
  "loadedPlugins": {
    "engine": ["mcp-client", "sub-agent"],
    "user": ["my-project-config", "team-standards"]
  },
  "errors": [],
  "performance": {
    "loadTime": 120,
    "memoryUsage": "2.1MB"
  }
}
```

## 安全考虑

### 引擎插件安全
- 数字签名验证
- 依赖安全检查
- 运行时权限控制

### 用户配置安全
- 配置验证白名单
- 路径访问限制
- 敏感信息脱敏

---

## 后续计划

1. **第一阶段**：引擎开发插件系统（2周）
2. **第二阶段**：用户配置插件系统（2周）
3. **第三阶段**：迁移现有 skill 系统（1周）
4. **第四阶段**：社区模板和工具链（1周）