#!/bin/bash

set -e

echo "🚀 Coder Refactor - Quick Start"
echo "==============================="

# 1. 构建所有包
echo "📦 Building packages..."
./build.sh

# 2. 验证迁移
echo "🔍 Running migration test..."
node test-migration.js

# 3. 启动CLI
echo "🎯 Starting CLI..."
pnpm --filter @coder/cli start

echo "✅ Migration complete!"