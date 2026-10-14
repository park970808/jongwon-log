import { defineConfig } from 'vite';
import { resolve } from 'node:path';
const root = import.meta.dirname;
export default defineConfig({
  base: './',
  resolve: { alias: {
    '@': resolve(root, 'vendor/rhwp/src'),
    '@wasm': resolve(root, 'vendor/rhwp/pkg'),
    '@rhwp/hwpctrl/studio-plugin': resolve(root, 'src/no-plugin.js'),
  } },
  define: {
    __APP_VERSION__: JSON.stringify('0.8.6-jongwon.1'),
    __RHWP_DISABLE_EXTERNAL_WEBFONTS__: 'true',
    __RHWP_HWPCTRL__: 'false',
  },
  build: { rollupOptions: { input: {
    app: resolve(root, 'index.html'),
    studio: resolve(root, 'studio.html'),
  } } },
});
