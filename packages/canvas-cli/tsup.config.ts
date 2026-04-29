import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI binary entry — only ever loaded by Node as CJS via the bin
  // shebang. Keeping this CJS-only avoids dual-package hazards on the
  // commander / dotenv stack.
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    target: 'es2022',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    outExtension: () => ({ js: '.cjs' }),
  },
  // Library entry — consumed by canvas-workspace's Electron main process
  // (ESM) and by anything else that wants to import team primitives.
  // Build BOTH .cjs and .mjs so each importer picks the right one via
  // the conditional `exports` map in package.json.
  {
    entry: { 'core/index': 'src/core/index.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    target: 'es2022',
    platform: 'node',
    outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.cjs' }),
  },
]);
