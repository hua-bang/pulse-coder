import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    worktree: 'src/worktree/index.ts',
    workspace: 'src/workspace/index.ts',
    devtools: 'src/devtools/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
});
