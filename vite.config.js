import { defineConfig } from 'vite';
import { resolve } from 'node:path';
const root = import.meta.dirname;
// The editor page is loaded in an iframe; GitHub Pages lets browsers reuse it for 10 minutes. A new address on
// every build makes everyone get the new editor right after a deploy (with the new main page).
const build = Date.now().toString(36);
const studioVersion = { name: 'studio-version', transformIndexHtml: html => html.replaceAll('__STUDIO_BUILD__', build) };
export default defineConfig({
  base: './',
  plugins: [studioVersion],
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
