/**
 * 把 onnxruntime-web 的 WASM 运行时复制到 web/public/ort/。
 *
 * onnxruntime-web 在浏览器里需要按 URL 加载 .mjs 胶水层与 .wasm 二进制；
 * 复制到 public 后由 Vite（开发）或 Node 服务端（生产）以同源静态资源提供，
 * 避免依赖 CDN、保证离线可用。
 *
 * 由 web/package.json 的 predev / prebuild 自动调用，也可手动执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
const TARGET = path.join(ROOT, 'web/public/ort');
/** CPU 推理只需要这一组（SIMD + 线程版，单线程模式也能用）。 */
const FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

if (!fs.existsSync(SOURCE)) {
  console.error('[ort] 未找到 onnxruntime-web，请先在项目根目录执行 npm install');
  process.exit(1);
}

fs.mkdirSync(TARGET, { recursive: true });
for (const file of FILES) {
  const from = path.join(SOURCE, file);
  const to = path.join(TARGET, file);
  if (!fs.existsSync(from)) {
    console.error(`[ort] 缺少 ${file}，请检查 onnxruntime-web 版本`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
}
console.log(`[ort] 已复制 WASM 运行时 → ${path.relative(ROOT, TARGET)}`);
