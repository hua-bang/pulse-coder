# 双轨插件系统 API 参考

## 引擎开发插件 API

### 核心接口

#### EnginePlugin
```typescript
interface EnginePlugin {
  name: string;           // 插件名称，全局唯一
  version: string;        // 遵循语义化版本规范
  dependencies?: string[]; // 依赖的其他插件
  
  // 生命周期钩子
  beforeInitialize?(context: EngineContext): Promise<void>;
  initialize(context: EngineContext): Promise<void>;
  afterInitialize?(context: EngineContext): Promise<void>;
  
  // 清理钩子
  destroy?(context: EngineContext): Promise<void>;
}
```

#### EngineContext
```typescript
interface EngineContext {
  // 工具注册
  registerTool(tool: Tool): void;
  registerTools(tools: Record<string, Tool>): void;
  
  // 配置管理
  getConfig<T>(key: string): T | undefined;
  setConfig<T>(key: string, value: T): void;
  
  // 服务注册
  registerService(name: string, service: any): void;
  getService<T>(name: string): T;
  
  // 事件系统
  events: EventEmitter;
  
  // 日志系统
  logger: Logger;
  
  // 调试接口
  debug: {
    log: (message: string, data?: any) => void;
    error: (message: string, error: Error) => void;
  };
}
```

### 使用示例

#### 创建简单插件
```typescript
import type { EnginePlugin, EngineContext } from 'pulse-coder-engine/engine-plugin';

const myPlugin: EnginePlugin = {
  name: 'my-custom-plugin',
  version: '1.0.0',
  
  async initialize(context) {
    // 注册自定义工具
    context.registerTool({
      name: 'customTool',
      description: 'A custom tool for specific operations',
      inputSchema: z.object({ input: z.string() }),
      execute: async ({ input }) => {
        return `Processed: ${input}`;
      }
    });
    
    // 注册事件监听
    context.events.on('tool:call', (toolName, args) => {
      context.logger.info(`Tool ${toolName} called with args:`, args);
    });
  }
};

export default myPlugin;
```

#### 带依赖的插件
```typescript
const mcpPlugin: EnginePlugin = {
  name: 'pulse-coder-engine-mcp-client',
  version: '2.0.0',
  dependencies: ['pulse-coder-engine-core'],
  
  async beforeInitialize(context) {
    // 检查依赖
    const core = context.getService('core');
    if (!core) {
      throw new Error('Core service not found');
    }
  },
  
  async initialize(context) {
    const mcpClient = new MCPClient(context.getConfig('mcp'));
    await mcpClient.connect();
    
    context.registerService('mcpClient', mcpClient);
  },
  
  async destroy(context) {
    const mcpClient = context.getService('mcpClient');
    if (mcpClient) {
      await mcpClient.disconnect();
    }
  }
};
```

### 高级功能

#### 动态工具注册
```typescript
interface DynamicToolPlugin extends EnginePlugin {
  async initialize(context) {
    const tools = await discoverTools();
    
    for (const tool of tools) {
      context.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: buildSchema(tool.schema),
        execute: tool.handler
      });
    }
  }
}
```

## 用户配置插件 API

### 配置格式

#### JSON Schema
```json
{
  "$schema": "https://coder.dev/schemas/user-config.json",
  "version": "1.0",
  "name": "my-project-config",
  "description": "Configuration for my project",
  
  "tools": {
    "customGit": {
      "type": "bash",
      "command": "git",
      "args": ["--version"],
      "description": "Check git version"
    }
  },
  
  "prompts": {
    "system": "You are a helpful coding assistant...",
    "user": "Please help me with..."
  },
  
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["@modelcontextprotocol/server-filesystem", "."],
        "env": {
          "NODE_ENV": "production"
        }
      }
    ]
  },
  
  "subAgents": [
    {
      "name": "codeReviewer",
      "trigger": ["review", "code review"],
      "prompt": "Act as a code reviewer...",
      "model": "gpt-4",
      "temperature": 0.3
    }
  ],
  
  "skills": {
    "directories": ["./custom-skills"],
    "autoScan": true
  }
}
```

#### YAML 格式
```yaml
version: "1.0"
name: my-project-config
description: Configuration for my project

tools:
  customGit:
    type: bash
    command: git
    args: ["--version"]
    description: Check git version
    
  httpRequest:
    type: http
    baseUrl: "https://api.github.com"
    headers:
      Authorization: "Bearer ${GITHUB_TOKEN}"

prompts:
  system: |
    You are a helpful coding assistant specializing in TypeScript.
    Always provide type-safe solutions.
  user: |
    Please help me with {task}

mcp:
  servers:
    - name: filesystem
      command: npx
      args: ["@modelcontextprotocol/server-filesystem", "."]
      env:
        NODE_ENV: production
        
    - name: postgres
      command: npx
      args: ["@modelcontextprotocol/server-postgres"]
      env:
        DATABASE_URL: ${DATABASE_URL}

subAgents:
  - name: codeReviewer
    trigger: ["review", "code review", "cr"]
    prompt: |
      Act as an experienced code reviewer. Focus on:
      1. Code quality and best practices
      2. Security vulnerabilities
      3. Performance optimizations
    model: gpt-4
    temperature: 0.3
    maxTokens: 2000
    
  - name: architect
    trigger: ["architecture", "design"]
    prompt: |
      You are a software architect. Provide high-level design guidance.
    model: claude-3-sonnet
    temperature: 0.7

skills:
  directories:
    - ./project-skills
    - ~/.coder/skills
  autoScan: true
```

### 工具类型定义

#### Bash 工具
```json
{
  "type": "bash",
  "command": "git",
  "args": ["log", "--oneline", "-10"],
  "cwd": "/path/to/project",
  "env": {
    "GIT_AUTHOR_NAME": "bot"
  },
  "timeout": 30000,
  "description": "Get recent git commits"
}
```

#### HTTP 工具
```json
{
  "type": "http",
  "method": "GET",
  "url": "https://api.github.com/repos/{owner}/{repo}/issues",
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json"
  },
  "params": {
    "state": "open",
    "per_page": 10
  },
  "description": "Fetch GitHub issues"
}
```

#### JavaScript 工具
```json
{
  "type": "javascript",
  "code": "
    const fs = require('fs');
    const path = require('path');
    
    module.exports = async function({ directory }) {
      const files = fs.readdirSync(directory);
      return files.filter(f => f.endsWith('.js')).length;
    };
  ",
  "description": "Count JavaScript files in directory"
}
```

### 环境变量支持

#### 配置中的变量替换
```yaml
tools:
  database:
    type: postgres
    connectionString: "postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
    
mcp:
  servers:
    - name: github
      command: npx
      args: ["@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: ${GITHUB_TOKEN}
        GITHUB_API_URL: ${GITHUB_API_URL:-https://api.github.com}
```

## 运行时 API

### 引擎初始化

```typescript
import { Engine } from 'pulse-coder-engine';

// 基础使用
const engine = new Engine();

// 带引擎插件
const engine = new Engine({
  enginePlugins: {
    plugins: [mcpPlugin, subAgentPlugin],
    dirs: ['./custom-engine-plugins'],
    scan: true
  }
});

// 带用户配置
const engine = new Engine({
  userConfigs: {
    configs: [customConfig],
    dirs: ['./project-config'],
    scan: true
  }
});

// 完整配置
const engine = new Engine({
  enginePlugins: {
    plugins: [mcpPlugin],
    dirs: ['./plugins/engine'],
    scan: true
  },
  userConfigs: {
    configs: [projectConfig],
    dirs: ['./config', '~/.coder/config'],
    scan: true
  }
});
```

### 动态配置更新

```typescript
// 运行时添加用户配置
await engine.addUserConfig({
  tools: {
    newTool: { /* ... */ }
  }
});

// 重新加载配置
await engine.reloadUserConfigs();

// 获取配置状态
const status = engine.getPluginStatus();
console.log(status.loadedPlugins);
console.log(status.errors);
```

### 调试接口

```typescript
// 获取插件信息
const pluginInfo = engine.getPluginInfo();
/*
{
  enginePlugins: [
    { name: 'mcp-client', version: '1.0.0', status: 'loaded' },
    { name: 'sub-agent', version: '2.0.0', status: 'loaded' }
  ],
  userConfigs: [
    { name: 'project-config', source: './config/config.json', status: 'loaded' }
  ],
  errors: []
}
*/

// 启用调试日志
engine.enableDebugLogging();

// 性能监控
const metrics = engine.getPluginMetrics();
/*
{
  loadTime: 1234,
  memoryUsage: 1024000,
  pluginCount: 3
}
*/
```

## CLI 工具 API

### 插件管理
```bash
# 创建引擎插件模板
coder-plugin create engine-plugin my-plugin

# 创建用户配置模板
coder-plugin create user-config my-config

# 验证配置
coder-plugin validate config.json

# 调试插件
coder-plugin debug my-plugin

# 查看插件状态
coder-plugin status

# 重新加载配置
coder-plugin reload
```

### 配置生成
```bash
# 交互式配置生成器
coder-config init

# 从模板创建
coder-config create mcp-basic
ncoder-config create sub-agent-advanced

# 配置转换
coder-config convert legacy-config.json
```

## 错误处理

### 错误类型
```typescript
class PluginError extends Error {
  constructor(
    public pluginName: string,
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
  }
}

class EnginePluginError extends PluginError {}
class UserConfigError extends PluginError {}
class ValidationError extends PluginError {}
```

### 错误恢复
```typescript
// 引擎插件错误 - 中断启动
try {
  await engine.initialize();
} catch (error) {
  if (error instanceof EnginePluginError) {
    console.error(`Engine plugin failed: ${error.pluginName}`);
    process.exit(1);
  }
}

// 用户配置错误 - 记录并继续
const errors = engine.getPluginStatus().errors;
errors.forEach(error => {
  if (error instanceof UserConfigError) {
    console.warn(`Config warning: ${error.message}`);
  }
});
```