import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/devtools/',
  server: {
    port: 5173,
    proxy: {
      '/api/devtools': 'http://127.0.0.1:3000',
    },
  },
});
