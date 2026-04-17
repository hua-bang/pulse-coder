import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: process.env.SKIP_DTS ? false : true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  external: ['langfuse', 'pulse-coder-engine'],
});
