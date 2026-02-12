#!/usr/bin/env node

/**
 * SubAgent 插件演示
 * 
 * 这个示例展示了如何使用内置的 SubAgent 插件
 * 子代理配置存储在 .coder/agents/ 目录的 Markdown 文件中
 */

import { Engine } from '../packages/engine/src/Engine.js';

async function demo() {
  console.log('🚀 SubAgent Plugin Demo');
  console.log('===================');
  
  try {
    // 创建引擎（自动包含内置插件）
    const engine = new Engine();
    await engine.initialize();
    
    // 查看已注册的子代理工具
    const tools = engine.getTools();
    const agentTools = Object.keys(tools).filter(name => name.startsWith('agent_'));
    
    console.log('📋 Available agent tools:');
    agentTools.forEach(name => {
      console.log(`  - ${name}: ${tools[name].description}`);
    });
    
    if (agentTools.length === 0) {
      console.log('💡 No agent configs found. Create .coder/agents/*.md files to add agents.');
      console.log('📁 Example: .coder/agents/code-reviewer.md');
      return;
    }
    
    // 测试调用子代理
    console.log('\n🎯 Testing agent_code_reviewer...');
    
    const result = await engine.run({
      messages: [{
        role: 'user',
        content: '使用 agent_code_reviewer 检查以下代码有什么潜在问题：\n\n```typescript\nfunction processUser(users: any[]) {\n  return users.map(u => u.name.toUpperCase());\n}\n```'
      }]
    });
    
    console.log('\n📊 Review Result:');
    console.log(result);
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// 如果直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  demo();
}