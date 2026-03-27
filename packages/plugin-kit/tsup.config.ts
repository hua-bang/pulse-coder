import { defineConfig } from 'tsup';

const skipDts = process.env.SKIP_DTS === '1' || process.env.TSUP_SKIP_DTS === '1';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    worktree: 'src/worktree/index.ts',
    vault: 'src/vault/index.ts',
    devtools: 'src/devtools/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: !skipDts,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
});
