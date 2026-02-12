import { Engine } from '../engine/src/Engine.js';
import { SubAgentPlugin } from '../engine-plugins/sub-agent/index.js';

async function testSubAgentPlugin() {
  console.log('🚀 Testing SubAgentPlugin...');
  
  try {
    // 创建引擎并添加插件
    const engine = new Engine({
      disableBuiltInPlugins: true // 暂时禁用其他插件，专注测试
    });
    
    // 手动添加子代理插件
    engine.getPluginManager().addPlugin(new SubAgentPlugin());
    
    await engine.initialize();
    
    // 获取注册的工具
    const tools = engine.getTools();
    console.log('📋 Registered agent tools:', Object.keys(tools));
    
    // 测试调用子代理
    const context = {
      messages: [
        {
          role: 'user',
          content: '使用 agent_code_reviewer 检查以下代码：\n```typescript\nfunction add(a, b) { return a + b; }\n```'
        }
      ]
    };
    
    console.log('🎯 Running agent_code_reviewer...');
    const result = await engine.run(context);
    console.log('✅ Result:', result);
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testSubAgentPlugin();
}