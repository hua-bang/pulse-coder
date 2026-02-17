import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  platform: 'node',
  noExternal: ['pulse-coder-engine'],
});
