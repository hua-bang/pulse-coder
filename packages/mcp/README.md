# @coder/mcp

MCP (Model Context Protocol) integration for Coder.

## Features

- **HTTP Transport Support**: Connect to MCP servers via HTTP
- **Multiple Servers**: Configure and use multiple MCP servers simultaneously
- **Auto Tool Registration**: MCP tools are automatically registered as AI tools
- **Zero Engine Coupling**: Completely independent package with no engine dependencies
- **Tool Prefixing**: All tools are prefixed with `mcp_{serverName}_` to avoid naming conflicts

## Installation

This package is part of the Coder monorepo. Install dependencies:

```bash
pnpm install
```

## Configuration

Create a configuration file at `.coder/mcp-servers.json` (project-level) or `~/.coder/mcp-servers.json` (user-level):

```json
{
  "servers": [
    {
      "name": "example-server",
      "url": "https://your-mcp-server.com/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key-here"
      },
      "description": "Example MCP server",
      "enabled": true
    }
  ]
}
```

### Configuration Options

- `name` (string, required): Unique identifier for the MCP server
- `url` (string, required): HTTP URL of the MCP server
- `headers` (object, optional): HTTP headers (e.g., for authentication)
- `description` (string, optional): Human-readable description
- `enabled` (boolean, optional): Whether to enable this server (default: true)

## Usage

The MCP plugin is automatically loaded when the Coder CLI starts. Once configured, MCP tools will be available to the AI with names like:

- `mcp_example-server_tool_name`
- `mcp_local-server_another_tool`

## Architecture

- **MCPRegistry**: Manages multiple MCP server connections
- **MCPRegistryPlugin**: Implements the EnginePlugin interface
- **Config Scanner**: Scans for configuration files in project and user directories
- **HTTP Transport**: Uses AI SDK's native HTTP transport support

## API

### MCPRegistry

```typescript
import { MCPRegistry } from '@coder/mcp';

const registry = new MCPRegistry();
await registry.initialize(process.cwd());

// Get all registered tools
const tools = registry.getAllTools();

// Get connection info
const connection = registry.getConnection('server-name');

// Close all connections
await registry.close();
```

### mcpRegistryPlugin

```typescript
import { mcpRegistryPlugin } from '@coder/mcp';
import { Engine } from '@coder/engine';

const engine = new Engine({
  enginePlugins: {
    plugins: [mcpRegistryPlugin]
  }
});
```

## Development

```bash
# Build
pnpm run build

# Watch mode
pnpm run dev

# Type check
pnpm run typecheck
```

## License

MIT
