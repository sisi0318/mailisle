import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { getBuildInfo } from '../../scripts/build-info';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __MAILISLE_BUILD__: JSON.stringify(getBuildInfo()) },
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } } },
});
