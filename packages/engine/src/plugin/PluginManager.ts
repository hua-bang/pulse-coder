import { promises as fs } from 'fs';
import path from 'path';
import { glob } from 'glob';
import { EventEmitter } from 'events';

import type { EnginePlugin, EnginePluginContext, EnginePluginLoadOptions } from './EnginePlugin.js';
import type { UserConfigPlugin, UserConfigPluginLoadOptions } from './UserConfigPlugin.js';
import type { ILogger } from '../shared/types.js';
import { ConfigVariableResolver } from './UserConfigPlugin.js';

/**
 * 插件管理器 - 管理双轨插件系统
 */
export class PluginManager {
  private enginePlugins = new Map<string, EnginePlugin>();
  private userConfigPlugins: UserConfigPlugin[] = [];
  private tools = new Map<string, any>();
  private services = new Map<string, any>();
  private protocols = new Map<string, any>();
  private config = new Map<string, any>();

  private events = new EventEmitter();
  private logger: ILogger;

  constructor(logger?: ILogger) {
    this.logger = logger ?? {
      debug: (msg: string, meta?: any) => console.debug(`[PluginManager] ${msg}`, meta),
      info: (msg: string, meta?: any) => console.info(`[PluginManager] ${msg}`, meta),
      warn: (msg: string, meta?: any) => console.warn(`[PluginManager] ${msg}`, meta),
      error: (msg: string, error?: Error, meta?: any) => console.error(`[PluginManager] ${msg}`, error, meta),
    };
  }

  /**
   * 初始化插件系统
   */
  async initialize(options: {
    enginePlugins?: EnginePluginLoadOptions;
    userConfigPlugins?: UserConfigPluginLoadOptions;
  } = {}): Promise<void> {
    this.logger.info('Initializing plugin system...');

    try {
      // 1. 加载引擎插件（优先）
      await this.loadEnginePlugins(options.enginePlugins);

      // 2. 验证核心能力
      await this.validateCoreCapabilities();

      // 3. 加载用户配置插件
      await this.loadUserConfigPlugins(options.userConfigPlugins);

      this.logger.info('Plugin system initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize plugin system', error as Error);
      throw error;
    }
  }

  /**
   * 加载引擎插件
   */
  private async loadEnginePlugins(options: EnginePluginLoadOptions = {}): Promise<void> {
    const plugins: EnginePlugin[] = [];

    // 1. API传入的插件（最高优先级）
    if (options.plugins) {
      plugins.push(...options.plugins);
    }

    // 2. 目录扫描的插件
    if (options.scan !== false) {
      const scanPaths = options.dirs || [
        '.pulse-coder/engine-plugins',
        '.coder/engine-plugins',
        '~/.pulse-coder/engine-plugins',
        '~/.coder/engine-plugins'
      ];

      for (const dir of scanPaths) {
        const scannedPlugins = await this.scanEnginePlugins(dir);
        plugins.push(...scannedPlugins);
      }
    }

    // 3. 按依赖顺序初始化插件
    const sortedPlugins = this.sortPluginsByDependencies(plugins);

    for (const plugin of sortedPlugins) {
      await this.initializeEnginePlugin(plugin);
    }
  }

  /**
   * 扫描引擎插件目录
   */
  private async scanEnginePlugins(dir: string): Promise<EnginePlugin[]> {
    const plugins: EnginePlugin[] = [];
    const resolvedDir = this.resolvePath(dir);

    try {
      const pattern = '**/*.plugin.{js,ts}';
      const files = await glob(pattern, { cwd: resolvedDir, absolute: true });

      for (const file of files) {
        try {
          const plugin = await this.loadEnginePluginFile(file);
          plugins.push(plugin);
          this.logger.info(`Loaded engine plugin: ${plugin.name} from ${file}`);
        } catch (error) {
          this.logger.error(`Failed to load engine plugin from ${file}`, error as Error);
        }
      }
    } catch (error) {
      // 目录不存在是正常现象
      this.logger.debug(`Directory not found: ${resolvedDir}`);
    }

    return plugins;
  }

  /**
   * 加载单个引擎插件文件
   */
  private async loadEnginePluginFile(filePath: string): Promise<EnginePlugin> {
    const plugin = await import(filePath);

    // 支持 default export 或直接导出
    const enginePlugin = plugin.default || plugin;

    if (!enginePlugin.name || !enginePlugin.initialize) {
      throw new Error(`Invalid engine plugin: ${filePath}`);
    }

    return enginePlugin;
  }

  /**
   * 初始化单个引擎插件
   */
  private async initializeEnginePlugin(plugin: EnginePlugin): Promise<void> {
    try {
      // 检查依赖
      if (plugin.dependencies) {
        for (const dep of plugin.dependencies) {
          if (!this.enginePlugins.has(dep)) {
            throw new Error(`Dependency not found: ${dep} for plugin ${plugin.name}`);
          }
        }
      }

      const context: EnginePluginContext = {
        registerTool: (name, tool) => {
          this.tools.set(name, tool);
        },
        registerTools: (tools) => {
          Object.entries(tools).forEach(([name, tool]) => {
            this.tools.set(name, tool);
          });
        },
        getTool: (name) => this.tools.get(name),

        registerProtocol: (name, handler) => {
          this.protocols.set(name, handler);
        },
        getProtocol: (name) => this.protocols.get(name),

        registerService: (name, service) => {
          this.services.set(name, service);
        },
        getService: (name) => this.services.get(name),

        getConfig: (key) => this.config.get(key),
        setConfig: (key, value) => this.config.set(key, value),

        events: this.events,
        logger: this.logger
      };

      // 执行生命周期钩子
      if (plugin.beforeInitialize) {
        await plugin.beforeInitialize(context);
      }

      await plugin.initialize(context);

      if (plugin.afterInitialize) {
        await plugin.afterInitialize(context);
      }

      this.enginePlugins.set(plugin.name, plugin);

    } catch (error) {
      throw new Error(`Failed to initialize engine plugin ${plugin.name}: ${error}`);
    }
  }

  /**
   * 加载用户配置插件
   */
  private async loadUserConfigPlugins(options: UserConfigPluginLoadOptions = {}): Promise<void> {
    const configs: UserConfigPlugin[] = [];

    // 1. API传入的配置
    if (options.configs) {
      configs.push(...options.configs);
    }

    // 2. 目录扫描的配置
    if (options.scan !== false) {
      const scanPaths = options.dirs || [
        '.pulse-coder/config',
        '.coder/config',
        '~/.pulse-coder/config',
        '~/.coder/config'
      ];

      for (const dir of scanPaths) {
        const scannedConfigs = await this.scanUserConfigPlugins(dir);
        configs.push(...scannedConfigs);
      }
    }

    // 3. 应用所有配置
    for (const config of configs) {
      await this.applyUserConfig(config);
    }
  }

  /**
   * 扫描用户配置插件目录
   */
  private async scanUserConfigPlugins(dir: string): Promise<UserConfigPlugin[]> {
    const configs: UserConfigPlugin[] = [];
    const resolvedDir = this.resolvePath(dir);

    try {
      const patterns = ['config.{json,yaml,yml}', '*.config.{json,yaml,yml}'];

      for (const pattern of patterns) {
        const files = await glob(pattern, { cwd: resolvedDir, absolute: true });

        for (const file of files) {
          try {
            const config = await this.loadUserConfigFile(file);
            configs.push(config);
            this.logger.info(`Loaded user config: ${config.name || file}`);
          } catch (error) {
            this.logger.error(`Failed to load user config from ${file}`, error as Error);
          }
        }
      }
    } catch (error) {
      this.logger.debug(`Directory not found: ${resolvedDir}`);
    }

    return configs;
  }

  /**
   * 加载单个用户配置文件
   */
  private async loadUserConfigFile(filePath: string): Promise<UserConfigPlugin> {
    const content = await fs.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath);

    let config: UserConfigPlugin;

    try {
      if (ext === '.json') {
        config = JSON.parse(content);
      } else if (ext === '.yaml' || ext === '.yml') {
        // 使用动态导入避免依赖问题
        const YAML = await import('yaml');
        config = YAML.parse(content);
      } else {
        throw new Error(`Unsupported config format: ${ext}`);
      }
    } catch (error) {
      throw new Error(`Failed to parse config file ${filePath}: ${error}`);
    }

    // 环境变量替换
    const resolver = new ConfigVariableResolver();
    config = resolver.resolveObject(config);

    return config;
  }

  /**
   * 应用用户配置
   */
  private async applyUserConfig(config: UserConfigPlugin): Promise<void> {
    try {
      // 配置工具
      if (config.tools) {
        for (const [name, toolConfig] of Object.entries(config.tools)) {
          if (toolConfig.enabled !== false) {
            // 这里将根据配置创建具体工具实例
            this.logger.debug(`Configured tool: ${name}`);
          }
        }
      }

      // 配置MCP服务器
      if (config.mcp?.servers) {
        for (const server of config.mcp.servers) {
          if (server.enabled !== false) {
            this.logger.debug(`Configured MCP server: ${server.name}`);
          }
        }
      }

      // 配置子代理
      if (config.subAgents) {
        for (const agent of config.subAgents) {
          if (agent.enabled !== false) {
            this.logger.debug(`Configured sub-agent: ${agent.name}`);
          }
        }
      }

      // 配置技能（向后兼容）
      if (config.skills) {
        this.logger.debug(`Configured skills scanning`, config.skills);
      }

      this.userConfigPlugins.push(config);

    } catch (error) {
      this.logger.error('Failed to apply user config', error as Error);
    }
  }

  /**
   * 验证核心能力
   */
  private async validateCoreCapabilities(): Promise<void> {
    // 检查必需的核心插件是否已加载
    const requiredCapabilities = [
      'skill-registry'  // 确保skill系统可用
    ];

    for (const capability of requiredCapabilities) {
      if (!this.enginePlugins.has(capability) && !this.enginePlugins.has(`pulse-coder-engine-${capability}`)) {
        this.logger.warn(`Missing core capability: ${capability}`);
      }
    }
  }

  /**
   * 插件依赖排序
   */
  private sortPluginsByDependencies(plugins: EnginePlugin[]): EnginePlugin[] {
    const sorted: EnginePlugin[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (plugin: EnginePlugin) => {
      if (visited.has(plugin.name)) return;
      if (visiting.has(plugin.name)) {
        throw new Error(`Circular dependency detected: ${plugin.name}`);
      }

      visiting.add(plugin.name);

      if (plugin.dependencies) {
        for (const dep of plugin.dependencies) {
          const depPlugin = plugins.find(p => p.name === dep);
          if (depPlugin) {
            visit(depPlugin);
          }
        }
      }

      visiting.delete(plugin.name);
      visited.add(plugin.name);
      sorted.push(plugin);
    };

    for (const plugin of plugins) {
      visit(plugin);
    }

    return sorted;
  }

  /**
   * 工具获取
   */
  getTools(): Record<string, any> {
    return Object.fromEntries(this.tools);
  }

  /**
   * 服务获取
   */
  getService<T>(name: string): T | undefined {
    return this.services.get(name);
  }

  /**
   * 协议获取
   */
  getProtocol(name: string): any {
    return this.protocols.get(name);
  }

  /**
   * 获取插件状态
   */
  getStatus() {
    return {
      enginePlugins: Array.from(this.enginePlugins.keys()),
      userConfigPlugins: this.userConfigPlugins.map(c => c.name || 'unnamed'),
      tools: Array.from(this.tools.keys()),
      services: Array.from(this.services.keys()),
      protocols: Array.from(this.protocols.keys())
    };
  }

  /**
   * 解析路径（支持 ~ 和相对路径）
   */
  private resolvePath(dir: string): string {
    if (dir.startsWith('~/')) {
      return path.join(process.env.HOME || process.env.USERPROFILE || '', dir.slice(2));
    }
    return path.resolve(dir);
  }
}