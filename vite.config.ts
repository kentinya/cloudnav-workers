import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');

    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        open: true,
        proxy: {
          '/api': {
            target: 'http://127.0.0.1:8788',
            changeOrigin: true,
          },
        },
      },
      plugins: [
        react(),
      ],
      // define: {
      //   // 移除API密钥暴露到前端的配置
      //   // API密钥应该只在后端使用
      // },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, './src'),
          '@components': path.resolve(__dirname, './components'),
          '@services': path.resolve(__dirname, './services'),
          '@utils': path.resolve(__dirname, './utils'),
          '@types': path.resolve(__dirname, './types'),
        }
      },
      build: {
        outDir: 'dist',
        sourcemap: mode === 'development',
        minify: 'terser',
        terserOptions: {
          compress: {
            drop_console: mode === 'production',
            drop_debugger: mode === 'production',
          },
        },
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
                return 'vendor';
              }
              if (id.includes('node_modules/lucide-react/')) {
                return 'ui';
              }
              if (id.includes('node_modules/@dnd-kit/')) {
                return 'dnd';
              }
            },
            chunkFileNames: 'assets/[name]-[hash].js',
            entryFileNames: 'assets/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash].[ext]',
          },
        },
        // 减小 chunk 大小限制
        chunkSizeWarningLimit: 500,
        // 启用 Tree Shaking
        target: 'esnext',
      },
      optimizeDeps: {
        include: ['react', 'react-dom', 'lucide-react'],
      },
      css: {
        devSourcemap: true,
      },
      preview: {
        port: 4173,
      },
    };
});
