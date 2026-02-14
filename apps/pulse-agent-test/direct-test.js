#!/usr/bin/env node

// 直接通过相对路径导入
import { PulseAgent } from '../../packages/engine/dist/index.js';

async function directTest() {
  console.log('🚀 Direct testing PulseAgent from dist...\n');

  try {
    // 验证 PulseAgent 是否存在
    console.log('📦 PulseAgent class:', typeof PulseAgent);
    console.log('📦 PulseAgent name:', PulseAgent.name);
    
    // 创建实例
    const agent = new PulseAgent({
      disableBuiltInPlugins: true,
      config: { testMode: true }
    });
    
    console.log('✅ PulseAgent instance created successfully!');
    console.log('🔍 Instance type:', agent.constructor.name);
    
    // 检查方法
    console.log('🔧 Available methods:');
    console.log('  - initialize:', typeof agent.initialize);
    console.log('  - run:', typeof agent.run);
    console.log('  - getPluginStatus:', typeof agent.getPluginStatus);
    
    // 初始化
    await agent.initialize();
    console.log('✅ Agent initialized!');
    
    // 获取状态
    const status = agent.getPluginStatus();
    console.log('📊 Plugin status:', JSON.stringify(status, null, 2));
    
    console.log('\n🎉 PulseAgent SDK is working perfectly!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('💡 Stack trace:', error.stack);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  directTest();
}

export { directTest };