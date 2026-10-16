/**
 * 无 esbuild 配置 —— 给“禁止派生原生子进程”的环境（沙箱 / 部分 CI）使用。
 *
 * Vite 默认依赖 esbuild 做：配置文件打包、define 常量替换、语法降级、代码压缩。
 * 它们都需要 spawn 一个原生子进程，在受限环境里会直接 EPERM。
 * Vue SFC 的编译（compiler-sfc）本身是纯 JS，因此换掉这几处即可：
 *
 *   npm run build:restricted     # = node scripts/vite-runner.mjs build --configLoader runner --config vite.noesbuild.config.js
 *   npm run dev:restricted
 *
 * 代价：产物不压缩、不做语法降级（target=esnext），只适合现代浏览器 + 受限环境验证。
 */
import base from './vite.config.js';

/**
 * 把 esbuild 负责的内置常量替换自己做掉。
 * Vite 的 vite:define 插件只有在源码里命中 define key 时才会调用 esbuild，
 * 提前替换掉这些标识符，就能让构建链路完全不碰 esbuild。
 */
const INLINE_DEFINES = [
  [/process\.env\.NODE_ENV/g, null], // 值在 configResolved 里按命令决定
  [/__VUE_OPTIONS_API__/g, 'true'],
  [/__VUE_PROD_DEVTOOLS__/g, 'false'],
  [/__VUE_PROD_HYDRATION_MISMATCH_DETAILS__/g, 'false'],
];

function inlineDefinesPlugin() {
  let isBuild = true;
  return {
    name: 'image-clip:inline-defines',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    transform(code, id) {
      if (!/\.(m?[jt]sx?|vue)(\?|$)/.test(id)) return null;
      if (!code.includes('process.env.NODE_ENV') && !code.includes('__VUE_')) return null;

      const nodeEnv = JSON.stringify(isBuild ? 'production' : 'development');
      let out = code;
      for (const [pattern, value] of INLINE_DEFINES) {
        out = out.replace(pattern, value ?? nodeEnv);
      }
      return out === code ? null : { code: out, map: null };
    },
  };
}

export default {
  ...base,
  plugins: [...base.plugins, inlineDefinesPlugin()],
  esbuild: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  build: {
    ...base.build,
    target: 'esnext',
    minify: false,
    cssMinify: false,
  },
};
