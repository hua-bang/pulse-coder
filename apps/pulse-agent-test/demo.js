#!/usr/bin/env node

/**
 * PulseAgent SDK 完整演示
 * 展示如何使用 PulseAgent 进行代码生成
 */

import { PulseAgent } from '../../packages/engine/dist/index.js';
import { openai } from '@ai-sdk/openai';

async function demo() {
  console.log('🎯 PulseAgent SDK Demo\n');
  console.log('🔍 This demo shows how to use PulseAgent for AI-powered development');
  console.log('');

  // 检查环境变量
  if (!process.env.OPENAI_API_KEY) {
    console.log('⚠️  No OPENAI_API_KEY found, running in demo mode');
    console.log('💡 To test with AI, set: export OPENAI_API_KEY=your-key');
    console.log('');
    
    // 演示 PulseAgent 的基本功能
    const agent = new PulseAgent({
      disableBuiltInPlugins: true
    });
    
    await agent.initialize();
    
    console.log('✅ PulseAgent Features:');
    console.log('   • Initialize with plugins');
    console.log('   • Manage tools and services');
    console.log('   • Run AI-powered tasks');
    console.log('   • Stream results');
    console.log('   • Handle context');
    
    return;
  }

  // 真实测试模式
  console.log('🤖 Using OpenAI GPT-4o-mini for code generation');
  
  const agent = new PulseAgent({
    config: {
      openai: {
        apiKey: process.env.OPENAI_API_KEY
      }
    }
  });

  await agent.initialize();
  
  console.log('✅ PulseAgent initialized with built-in plugins');
  console.log('🔌 Plugins loaded:', agent.getPluginStatus().enginePlugins.length);
  
  // 示例任务
  const tasks = [
    "Create a simple React hook for managing form state",
    "Generate a Node.js Express middleware for rate limiting",
    "Write a TypeScript utility type for deep readonly"
  ];
  
  for (const task of tasks) {
    console.log(`\n📝 Task: ${task}`);
    console.log('─'.repeat(50));
    
    const context = {
      messages: [{ role: 'user', content: task }]
    };
    
    try {
      const result = await agent.run(context, {
        onText: (text) => process.stdout.write(text),
        onToolCall: (call) => console.log(`\n🔧 ${call.toolName}`)
      });
      
      console.log('\n✅ Task completed');
      
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
    
    console.log('');
  }
}

// 运行演示
if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch(console.error);
}