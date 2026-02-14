# PulseAgent SDK 测试项目

一个简单的 Node.js 项目，用于测试 `@pulse-coder/engine` 的 `PulseAgent` 功能。

## 快速开始

1. **安装依赖**
   ```bash
   npm install
   ```

2. **配置 API Key**
   ```bash
   cp .env.example .env
   # 编辑 .env 文件，填入你的 OpenAI API key
   ```

3. **运行测试**
   ```bash
   npm test
   # 或者
   node index.js
   ```

## 测试内容

- ✅ PulseAgent 初始化
- ✅ 插件系统加载
- ✅ 简单代码生成测试
- ✅ 流式输出演示

## 预期输出

运行后你应该会看到：
```
🚀 Testing PulseAgent SDK...

📦 Initializing PulseAgent...
✅ PulseAgent initialized successfully!
🔌 Loaded plugins: { enginePlugins: [...], userConfigPlugins: [...] }

🧪 Test 1: Simple code generation
📝 Prompt: Create a simple JavaScript function...
⏳ Generating...

[生成的代码]

✅ Test completed!
📊 Result length: XXX characters
```