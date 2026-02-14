#!/usr/bin/env node

import { PulseAgent } from '@pulse-coder/engine';
import { openai } from '@ai-sdk/openai';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

async function testPulseAgent() {
  console.log('🚀 Testing PulseAgent SDK...\n');

  // 检查 API key
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Please set OPENAI_API_KEY in .env file');
    console.error('   Copy .env.example to .env and add your API key');
    process.exit(1);
  }

  try {
    // 创建 PulseAgent 实例
    const agent = new PulseAgent({
      config: {
        openai: {
          apiKey: process.env.OPENAI_API_KEY
        }
      }
    });

    console.log('📦 Initializing PulseAgent...');
    await agent.initialize();
    
    console.log('✅ PulseAgent initialized successfully!');
    console.log('🔌 Loaded plugins:', agent.getPluginStatus());
    console.log('');

    // 测试 1: 简单代码生成
    console.log('🧪 Test 1: Simple code generation');
    const context = {
      messages: [
        {
          role: 'user',
          content: 'Create a simple JavaScript function that calculates the factorial of a number with input validation'
        }
      ]
    };

    console.log('📝 Prompt:', context.messages[0].content);
    console.log('⏳ Generating...\n');

    const result = await agent.run(context, {
      onToolCall: (toolCall) => {
        console.log(`🔧 Tool: ${toolCall.toolName}`);
      },
      onText: (text) => {
        process.stdout.write(text);
      }
    });

    console.log('\n\n✅ Test completed!');
    console.log('📊 Result length:', result.length, 'characters');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  }
}

// 如果直接运行这个文件
if (import.meta.url === `file://${process.argv[1]}`) {
  testPulseAgent();
}

export { testPulseAgent };