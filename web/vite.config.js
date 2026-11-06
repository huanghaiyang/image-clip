import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * onnxruntime-web 在运行时用 `import(url)` 加载 /ort/ 下的 WASM 胶水模块。
 * Vite 的 import 分析会把这类动态 import 改写成 `__vite__injectQuery(url, 'import')`，
 * 请求就变成 `/ort/xxx.mjs?import` —— public 下的静态文件没有 `?import` 的加载器，
 * 开发服务器会直接 500。这里在 Vite 内部中间件之前把该 query 去掉，
 * 让 /ort/ 回到普通静态文件的处理路径（生产构建不受影响）。
 */
function stripOrtImportQuery() {
  return {
    name: 'strip-ort-import-query',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/ort/') && req.url.includes('?import')) {
          req.url = req.url.replace('?import', '');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [vue(), stripOrtImportQuery()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 检测算法与 Node 服务端共用同一份源码，保证两端结果一致
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
    // onnxruntime-web 只有在命中该条件时才会走「外部 WASM」构建：
    // 运行时代码从 /ort/ 加载，而不是把 28MB 的 wasm 打进 dist 产物。
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
