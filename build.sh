#!/bin/bash

set -e

echo "🏗️  Building Coder 3-package architecture..."

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install

# Build packages in order
echo "🔧 Building @coder/engine..."
cd packages/engine
pnpm build
cd ../..

echo "🔧 Building @coder/skills..."
cd packages/skills
pnpm build
cd ../..

echo "🔧 Building @coder/cli..."
cd packages/cli
pnpm build
cd ../..

echo "✅ All packages built successfully!"
echo ""
echo "🚀 Ready to test:"
echo "  pnpm start    # Run CLI"
echo "  node test-migration.js  # Run migration test"