import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config';

export default defineConfig((env) => mergeConfig(baseConfig(env), {
  server: {
    host: '127.0.0.1',
    open: false,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true },
    },
  },
}));
