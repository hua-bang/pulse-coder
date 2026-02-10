# MCP 插件开发检查清单

## 项目设置
- [ ] 创建 `packages/mcp-plugin/` 目录
- [ ] 初始化 `package.json` 并添加依赖
- [ ] 配置 TypeScript 构建
- [ ] 设置工作区链接

## 核心实现
- [ ] 创建 `src/index.ts` - 插件入口
- [ ] 创建 `src/config-loader.ts` - 配置加载
- [ ] 创建 `src/transport.ts` - HTTP 传输
- [ ] 实现错误处理

## 配置验证
- [ ] 测试 `.coder/mcp.json` 文件读取
- [ ] 验证 JSON 格式解析
- [ ] 测试配置缺失场景
- [ ] 测试配置错误场景

## 集成测试
- [ ] 创建测试 MCP 服务器
- [ ] 验证工具注册
- [ ] 测试 HTTP 连接
- [ ] 验证错误隔离

## CLI 集成
- [ ] 添加 CLI 依赖
- [ ] 注册插件到引擎
- [ ] 测试端到端流程
- [ ] 验证日志输出

## 示例配置
- [ ] 创建示例 `.coder/mcp.json`
- [ ] 编写使用文档
- [ ] 提供测试用例

## 构建和发布
- [ ] 配置构建脚本
- [ ] 生成类型定义
- [ ] 测试构建输出
- [ ] 准备发布包

## 快速开始模板

### 1. 初始化项目
```bash
cd /Users/colepol/project/Coder/packages
mkdir mcp-plugin
cd mcp-plugin

# 创建 package.json
cat > package.json << 'EOF'
{
  "name": "@coder/mcp-plugin",
  "version": "1.0.0",
  "description": "Lightweight MCP plugin for Coder engine",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch"
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
EOF
```

### 2. 创建基础文件
```bash
# 创建目录结构
mkdir src

# 创建 TypeScript 配置
cat > tsconfig.json << 'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
EOF

# 创建构建配置
cat > tsup.config.ts << 'EOF'
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true
});
EOF
```

### 3. 创建核心文件
```bash
# 创建配置加载器
cat > src/config-loader.ts << 'EOF'
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

export interface MCPPluginConfig {
  servers: Record<string, { url: string }>;
}

export async function loadMCPConfig(cwd: string): Promise<MCPPluginConfig> {
  const configPath = path.join(cwd, '.coder', 'mcp.json');
  if (!existsSync(configPath)) return { servers: {} };
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    return { servers: parsed.servers || {} };
  } catch (error) {
    console.warn(`Failed to load MCP config: ${error.message}`);
    return { servers: {} };
  }
}
EOF

# 创建传输实现
cat > src/transport.ts << 'EOF'
export interface HTTPTransportConfig {
  url: string;
}

export function createHTTPTransport(config: HTTPTransportConfig) {
  return { type: 'http' as const, url: config.url };
}
EOF

# 创建主插件文件
cat > src/index.ts << 'EOF'
import { EnginePlugin } from '@coder/engine';
import { createMCPClient } from '@ai-sdk/mcp';
import { loadMCPConfig } from './config-loader';
import { createHTTPTransport } from './transport';

export const mcpPlugin: EnginePlugin = {
  name: '@coder/mcp-plugin',
  version: '1.0.0',
  
  async initialize(context) {
    const config = await loadMCPConfig(process.cwd());
    
    for (const [name, serverConfig] of Object.entries(config.servers)) {
      try {
        const transport = createHTTPTransport(serverConfig);
        const client = await createMCPClient({ transport });
        
        const tools = await client.tools();
        context.registerTools(tools);
        
        console.log(`✅ MCP server "${name}" loaded (${Object.keys(tools).length} tools)`);
      } catch (error) {
        console.warn(`❌ Failed to load MCP server "${name}": ${error.message}`);
      }
    }
  }
};

export default mcpPlugin;
EOF
```

### 4. 集成到 CLI
```bash
# 添加到 CLI 依赖
cd ../cli

# 更新 package.json 添加依赖
# 手动添加 "@coder/mcp-plugin": "workspace:*"

# 注册插件到引擎
# 在 packages/cli/src/index.ts 的 Engine 构造函数中
# 添加 mcpPlugin 到 enginePlugins.plugins 数组
```

### 5. 测试配置
```bash
# 创建测试配置
cd /Users/colepol/project/Coder
echo '{"servers":{"test":{"url":"http://localhost:3000/mcp"}}}' > .coder/mcp.json

# 构建插件
cd packages/mcp-plugin
npm run build

# 启动测试
# 确保 CLI 已经注册了插件
```