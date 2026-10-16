/**
 * 下载 LaMa 修复模型（ONNX）。
 *
 * LaMa: "Resolution-robust Large Mask Inpainting with Fourier Convolutions" (WACV 2022)
 *   - 上游项目: https://github.com/advimman/lama          (Apache-2.0)
 *   - 权重来源: https://huggingface.co/Carve/LaMa-ONNX    (Apache-2.0，ONNX 导出)
 * 本项目只使用官方发布的权重做推理，不打包、不再分发权重文件本身。
 *
 * 用法:
 *   node scripts/download-lama.mjs                 # 下 lama_fp32.onnx（推荐，精度最好）
 *   node scripts/download-lama.mjs --file lama.onnx
 *   node scripts/download-lama.mjs --force         # 忽略已存在/大小校验失败，重新下载
 *
 * 特性：断点续传（.part + Range）、镜像回退、进度输出、按上游 Content-Length 校验体积。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = process.env.IMAGE_CLIP_MODEL_DIR || path.join(ROOT, 'models');

/** 镜像顺序：国内可达性优先，失败自动回退。 */
const MIRRORS = [
  (file) => `https://hf-mirror.com/Carve/LaMa-ONNX/resolve/main/${file}`,
  (file) => `https://huggingface.co/Carve/LaMa-ONNX/resolve/main/${file}`,
];

function parseArgs(argv) {
  const args = { file: 'lama_fp32.onnx', force: false, url: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
  }
  return args;
}

export const KNOWN_SIZES = {
  'lama_fp32.onnx': 208044816,
  'lama.onnx': 207575722,
};

function human(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 依次尝试镜像；支持从已有 .part 续传。 */
async function download(file, { force = false, url = null, outDir = MODEL_DIR } = {}) {
  await fsp.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, file);
  const part = `${dest}.part`;

  if (!force && fs.existsSync(dest)) {
    const size = (await fsp.stat(dest)).size;
    const expect = KNOWN_SIZES[file];
    if (!expect || size === expect) {
      console.log(`[lama] 已存在，跳过：${path.relative(ROOT, dest)} (${human(size)})`);
      return { path: dest, bytes: size, skipped: true };
    }
    console.log(`[lama] 体积不符（${human(size)}，期望 ${human(expect)}），重新下载`);
    await fsp.rm(dest, { force: true });
  }

  const sources = url ? [() => url] : MIRRORS.map((fn) => () => fn(file));
  let lastError = null;

  for (const makeUrl of sources) {
    const source = makeUrl();
    let start = 0;
    if (!force && fs.existsSync(part)) {
      start = (await fsp.stat(part)).size;
      console.log(`[lama] 断点续传，从 ${human(start)} 继续`);
    } else {
      await fsp.rm(part, { force: true });
    }

    try {
      console.log(`[lama] 下载源: ${source}`);
      const res = await fetch(source, {
        redirect: 'follow',
        headers: start > 0 ? { Range: `bytes=${start}-` } : {},
      });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);

      const contentRange = res.headers.get('content-range');
      const contentLength = Number(res.headers.get('content-length') || 0);
      const total = contentRange
        ? Number(contentRange.split('/')[1])
        : contentLength + (res.status === 206 ? start : 0);

      if (!res.body) throw new Error('响应无 body');

      const out = fs.createWriteStream(part, { flags: start > 0 && res.status === 206 ? 'a' : 'w' });
      let received = res.status === 206 ? start : 0;
      let lastReport = 0;
      const startedAt = Date.now();

      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(Buffer.from(chunk))) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
        const now = Date.now();
        if (now - lastReport > 1500 || (total && received >= total)) {
          lastReport = now;
          const pct = total ? ((received / total) * 100).toFixed(1) : '?';
          const speed = received / Math.max(0.001, (now - startedAt) / 1000) / 1024 / 1024;
          process.stdout.write(`\r[lama] ${pct}%  ${human(received)}${total ? ` / ${human(total)}` : ''}  ${speed.toFixed(1)} MB/s`);
        }
      }
      await new Promise((resolve, reject) => {
        out.end((err) => (err ? reject(err) : resolve()));
      });
      process.stdout.write('\n');

      const size = (await fsp.stat(part)).size;
      const expect = KNOWN_SIZES[file];
      if (total && size !== total) throw new Error(`下载不完整：${human(size)} / ${human(total)}`);
      if (expect && size !== expect && !url) {
        throw new Error(`体积与上游记录不一致：${human(size)}，期望 ${human(expect)}`);
      }

      await fsp.rm(dest, { force: true });
      await fsp.rename(part, dest);
      console.log(`[lama] 完成：${path.relative(ROOT, dest)} (${human(size)})`);
      return { path: dest, bytes: size, skipped: false };
    } catch (err) {
      lastError = err;
      console.warn(`[lama] 该源失败：${err.message}`);
    }
  }

  throw new Error(`所有下载源都失败：${lastError?.message ?? '未知错误'}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  try {
    await download(args.file, { force: args.force, url: args.url, outDir: args.outDir ?? MODEL_DIR });
  } catch (err) {
    console.error(`[lama] ${err.message}`);
    process.exitCode = 1;
  }
}

export { download, human, MODEL_DIR };
