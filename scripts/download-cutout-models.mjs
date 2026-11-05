/**
 * 下载 AI 精准抠图模型（ONNX）。
 *
 * 模型来自 Concat（https://github.com/jub0t/Concat）使用的同一批权重：
 *   - person: Robust Video Matting MobileNetV3 (GPL-3.0)
 *   - object: IS-Net general use (Apache-2.0)
 *   - selfie: MediaPipe Selfie Segmentation (Apache-2.0)
 *
 * 本项目只下载官方发布/上游仓库的权重做本地推理，不打包、不再分发模型文件。
 *
 * 用法:
 *   node scripts/download-cutout-models.mjs                    # 下载人像发丝模型（RVM，推荐）
 *   node scripts/download-cutout-models.mjs --model selfie     # 只下载快速人像模型（约 0.5MB）
 *   node scripts/download-cutout-models.mjs --model object     # 只下载通用物体模型（约 178MB）
 *   node scripts/download-cutout-models.mjs --all              # 下载全部三个模型
 *   node scripts/download-cutout-models.mjs --force            # 忽略已存在/校验失败，重新下载
 *
 * 特性：断点续传（.part + Range）、进度输出、大小与 sha256 校验。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CUTOUT_MODELS, findCutoutModel } from '../shared/cutout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = process.env.IMAGE_CLIP_MODEL_DIR || path.join(ROOT, 'models');

/** 每个模型的上游地址（与共享注册表保持一致，selfie 额外给镜像与 GitHub API 兜底）。 */
const MIRRORS = {
  selfie: [
    (model) => model.upstream,
    () => 'https://cdn.jsdelivr.net/gh/jub0t/Concat@main/src/crates/concat-vision/models/selfie-segmentation.onnx',
    // raw.githubusercontent / jsDelivr 在部分网络下不可达；GitHub 内容 API 走不同域名，可作为兜底
    () => ({ blob: 'https://api.github.com/repos/jub0t/Concat/contents/src/crates/concat-vision/models/selfie-segmentation.onnx?ref=main' }),
  ],
};

function parseArgs(argv) {
  const args = { models: ['person'], force: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--model') args.models.push(argv[++i]);
    else if (a === '--all') args.all = true;
    else if (a === '--force') args.force = true;
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (args.help) return args;
  if (args.all) args.models = CUTOUT_MODELS.map((model) => model.id);
  else args.models = [...new Set(args.models.filter(Boolean))];
  for (const id of args.models) {
    if (!findCutoutModel(id)) throw new Error(`未知模型：${id}（可选 ${CUTOUT_MODELS.map((m) => m.id).join(' / ')}）`);
  }
  return args;
}

function human(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  return hash.digest('hex');
}

/** 从 .part 续传并打印进度。 */
async function downloadTo(url, dest) {
  const part = `${dest}.part`;
  let start = 0;
  if (fs.existsSync(part)) start = (await fsp.stat(part)).size;
  const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
  const response = await fetch(url, { headers });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const total = Number(response.headers.get('content-length') ?? 0) + start;
  let written = start;
  let lastReport = 0;
  const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      await new Promise((resolve, reject) => out.write(value, (err) => (err ? reject(err) : resolve())));
      if (written - lastReport > 4 * 1024 * 1024 || written === total) {
        lastReport = written;
        const percent = total ? ((written / total) * 100).toFixed(1) : '?';
        process.stdout.write(`\r  ${percent}%  ${human(written)} / ${human(total)}`);
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  process.stdout.write('\n');
  await fsp.rename(part, dest);
}

/** GitHub Contents API 兜底：返回 base64 编码的完整文件内容。 */
async function downloadBlob(url, dest) {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (!payload.content) throw new Error('GitHub API 未返回文件内容（文件过大或触发限流）');
  const bytes = Buffer.from(payload.content, payload.encoding === 'base64' ? 'base64' : 'utf8');
  const part = `${dest}.part`;
  await fsp.writeFile(part, bytes);
  await fsp.rename(part, dest);
  console.log(`  ${human(bytes.length)}（GitHub API）`);
}

async function fetchModel(model, { force = false, outDir = MODEL_DIR } = {}) {
  await fsp.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, model.file);
  const part = `${dest}.part`;

  if (!force && fs.existsSync(dest)) {
    const size = (await fsp.stat(dest)).size;
    const digest = await sha256Of(dest);
    const sizeOk = size === model.bytes;
    const hashOk = !model.sha256 || digest === model.sha256;
    if (sizeOk && hashOk) {
      console.log(`[cutout] ${model.id} 已存在，跳过：${path.relative(ROOT, dest)} (${human(size)})`);
      return { path: dest, skipped: true };
    }
    console.log(`[cutout] ${model.id} 校验失败（大小 ${human(size)} / ${human(model.bytes)}），重新下载`);
    await fsp.rm(dest, { force: true });
    await fsp.rm(part, { force: true });
  }

  const sources = (MIRRORS[model.id] ?? [() => model.upstream]).map((fn) => fn(model));
  let lastError = null;
  for (const source of sources) {
    const url = typeof source === 'string' ? source : source.blob;
    try {
      if (typeof source === 'string') {
        console.log(`[cutout] 下载 ${model.id}：${url}`);
        await downloadTo(url, dest);
      } else {
        console.log(`[cutout] 下载 ${model.id}：GitHub API 兜底`);
        await downloadBlob(url, dest);
      }
      const stat = await fsp.stat(dest);
      if (stat.size !== model.bytes) {
        throw new Error(`大小不符：${human(stat.size)}，期望 ${human(model.bytes)}`);
      }
      if (model.sha256) {
        const digest = await sha256Of(dest);
        if (digest !== model.sha256) throw new Error(`sha256 不符：${digest}`);
      }
      console.log(`[cutout] ${model.id} 完成：${path.relative(ROOT, dest)} (${human(stat.size)})`);
      return { path: dest, bytes: stat.size };
    } catch (err) {
      lastError = err;
      console.log(`[cutout] 该来源失败：${err.message}`);
      await fsp.rm(`${dest}.part`, { force: true });
    }
  }
  throw new Error(`下载 ${model.id} 失败：${lastError?.message ?? '未知错误'}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[cutout] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log('用法：node scripts/download-cutout-models.mjs [--model person|object|selfie] [--all] [--force] [--out-dir <dir>]');
    return;
  }
  console.log(`[cutout] 模型目录：${args.outDir ?? MODEL_DIR}`);
  let failed = 0;
  for (const id of args.models) {
    const model = findCutoutModel(id);
    try {
      await fetchModel(model, { force: args.force, outDir: args.outDir });
    } catch (err) {
      failed += 1;
      console.error(`[cutout] ${err.message}`);
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log('[cutout] 全部完成。进入「背景去除」面板即可使用 AI 精准抠像。');
}

await main();
