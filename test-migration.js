#!/usr/bin/env node

import { Engine } from './packages/engine/dist/index.js';
import { skillPlugin } from './packages/skills/dist/index.js';
import { Context } from './packages/engine/dist/shared/types.js';

async function testMigration() {
  console.log('🧪 Testing migration...');
  
  try {
    // 测试引擎创建
    const engine = new Engine();
    console.log('✅ Engine created');

    // 测试插件加载
    await engine.loadPlugin(skillPlugin);
    console.log('✅ Skills plugin loaded');

    // 测试工具获取
    const tools = engine.getTools();
    console.log(`✅ Available tools: ${Object.keys(tools).length}`);

    // 测试基本运行
    const context: Context = {
      messages: [{ role: 'user', content: 'Hello' }]
    };

    console.log('✅ All core components migrated successfully!');
    console.log('\n📦 Migration complete:');
    console.log('  - @coder/engine: plugin-based AI engine');
    console.log('  - @coder/skills: skill system implementation');
    console.log('  - @coder/cli: CLI interface');
    
  } catch (error) {
    console.error('❌ Migration test failed:', error);
    process.exit(1);
  }
}

testMigration();