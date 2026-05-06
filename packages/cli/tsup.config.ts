import { defineConfig } from 'tsup';

export default defineConfig((options) => {
  const isWatch = Boolean(options.watch);
  const isDebugBuild = process.env.PULSE_CODER_DEBUG === '1';
  const shouldKeepDebugInfo = isWatch || isDebugBuild;

  return {
    entry: {
      index: 'src/index.ts',
      runner: 'src/sandbox-runner.ts'
    },
    format: ['cjs'],
    dts: false,
    clean: true,
    splitting: false,
    sourcemap: shouldKeepDebugInfo,
    banner: { js: '#!/usr/bin/env node' },
    bundle: true,
    minify: !shouldKeepDebugInfo,
    treeshake: !shouldKeepDebugInfo,
    platform: 'node',
    external: [
      'ink',
      ...(isDebugBuild ? ['pulse-coder-acp', 'pulse-coder-engine', 'pulse-coder-memory-plugin'] : []),
    ],
    noExternal: ['pulse-sandbox'],
    outExtension: () => ({ js: '.cjs' })
  };
});

