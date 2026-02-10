# MCP 插件实现指南

## 核心架构

```typescript
// 插件主入口 src/index.ts
import { EnginePlugin } from '@coder/engine';
import { loadMCPConfig } from './config-loader';
import { createHTTPTransport } from './transport';

export const mcpPlugin: EnginePlugin = {
  name: '@coder/mcp-plugin',
  version: '1.0.0',
  
  async initialize(context) {
    const config = await loadMCPConfig(process.cwd());
    
    for (const [serverName, serverConfig] of Object.entries(config.servers)) {
      try {
        const transport = createHTTPTransport(serverConfig);
        const client = await createMCPClient({ transport });
        
        const tools = await client.tools();
        context.registerTools(tools);
        
        console.log(`✅ MCP server "${serverName}" loaded (${Object.keys(tools).length} tools)`);
      } catch (error) {
        console.warn(`❌ Failed to load MCP server "${serverName}": ${error.message}`);
      }
    }
  }
};
```

## 配置加载器

### src/config-loader.ts

```typescript
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

export interface MCPPluginConfig {
  servers: Record<string, {
    url: string;
  }>;
}

export async function loadMCPConfig(cwd: string): Promise<MCPPluginConfig> {
  const configPath = path.join(cwd, '.coder', 'mcp.json');
  
  if (!existsSync(configPath)) {
    return { servers: {} };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    
    if (!parsed.servers || typeof parsed.servers !== 'object') {
      console.warn('Invalid MCP config: missing "servers" object');
      return { servers: {} };
    }

    return { servers: parsed.servers };
  } catch (error) {
    console.warn(`Failed to load MCP config: ${error.message}`);
    return { servers: {} };
  }
}
```

## 传输层实现

### src/transport.ts

```typescript
export interface HTTPTransportConfig {
  url: string;
}

export function createHTTPTransport(config: HTTPTransportConfig) {
  return {
    type: 'http' as const,
    url: config.url
  };
}
```

## 包定义

### package.json

```json
{
  "name": "@coder/mcp-plugin",
  "version": "1.0.0",
  "description": "Lightweight MCP plugin for Coder engine",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest"
  },
  "dependencies": {
    "@ai-sdk/mcp": "^latest",
    "@coder/engine": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsup": "^8.0.0"
  }
}
```

## 测试配置

### 测试文件 .coder/mcp.json

```json
{
  "servers": {
    "test": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## 构建配置

### tsconfig.json

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### tsup.config.ts

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true
});
```

## 集成步骤

### 1. 创建插件包
```bash
cd /Users/colepol/project/Coder/packages
mkdir mcp-plugin
cd mcp-plugin
```

### 2. 安装依赖
```bash
npm install @ai-sdk/mcp @coder/engine
```

### 3. 添加到 CLI 依赖
在 `/Users/colepol/project/Coder/packages/cli/package.json` 中添加：
```json
{
  "dependencies": {
    "@coder/mcp-plugin": "workspace:*"
  }
}
```

### 4. 注册插件
在 CLI 的 engine 初始化中添加：
```typescript
import { mcpPlugin } from '@coder/mcp-plugin';

// 在 Engine 构造函数中
this.engine = new Engine({
  enginePlugins: {
    plugins: [skillRegistryPlugin, mcpPlugin], // 添加 mcpPlugin
    // ... 其他配置
  }
});
```

## 验证测试

### 1. 启动测试 MCP 服务器
```bash
# 使用任意 HTTP MCP 服务器
npx @modelcontextprotocol/server-everything --port 3000
```

### 2. 创建测试配置
```bash
echo '{"servers":{"test":{"url":"http://localhost:3000/mcp"}}}' > .coder/mcp.json
```

### 3. 启动 Coder CLI
启动后应该能看到：
```
✅ MCP server "test" loaded (X tools)
```