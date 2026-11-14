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
    /**
     * 冷启动预热：开发模式下浏览器是「边跑边请求模块」的，首次打开时
     * App.vue 的依赖图有 100+ 个模块要逐个走 esbuild 转换，实测冷启动 DCL 能到 3.5s。
     * 这里让 Vite 在服务启动时就把首屏与各工作区用到的模块预转换好，
     * 首次打开只需要传输、不再等编译（代价是 dev server 启动慢 1~2s）。
     */
    warmup: {
      clientFiles: [
        './src/main.js',
        './src/App.vue',
        './src/components/**/*.vue',
        './src/composables/**/*.js',
        './src/lib/**/*.js',
      ],
    },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8786', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
