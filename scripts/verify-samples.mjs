/**
 * 用仓库里的真实样例（蝴蝶-01/02/03）跑一遍服务端链路，
 * 打印每个阈值下的 AABB，方便挑选默认参数并作为回归证据。
 *
 *   node scripts/verify-samples.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, crop } from '../server/src/imaging.js';
import { describeResult, formatBytes } from '../shared/aabb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const outputDir = path.join(ROOT, 'probe-out');

const files = (await fs.readdir(SAMPLES_DIR)).filter((f) => /\.(png|webp|jpe?g|avif)$/i.test(f)).sort();
if (files.length === 0) {
  console.error('samples/ 目录下没有图片');
  process.exit(1);
}

await fs.mkdir(outputDir, { recursive: true });

console.log(`算法 aabb/v1 · 样例 ${files.length} 张\n`);
const thresholds = [0, 1, 8, 16, 32];

for (const file of files) {
  const buffer = await fs.readFile(path.join(SAMPLES_DIR, file));
  console.log(`── ${file}  (${formatBytes(buffer.length)})`);

  for (const alphaThreshold of thresholds) {
    const result = await analyze(buffer, { alphaThreshold });
    const { bounds } = result;
    const ratio = ((bounds.width * bounds.height) / (result.width * result.height)) * 100;
    console.log(
      `   alphaThreshold=${String(alphaThreshold).padStart(3)}  ` +
        `${result.width}×${result.height} → ${bounds.width}×${bounds.height} ` +
        `@(${bounds.x},${bounds.y})  去除 左${result.trimmed.left} 上${result.trimmed.top} 右${result.trimmed.right} 下${result.trimmed.bottom}  ` +
        `保留面积 ${ratio.toFixed(1)}%  ${result.elapsedMs}ms`,
    );
  }

  const best = await analyze(buffer, { alphaThreshold: 8, padding: 0 });
  const cropped = await crop(buffer, { alphaThreshold: 8, padding: 0, format: 'png' });
  const outFile = path.join(outputDir, `${path.basename(file, path.extname(file))}-cropped.png`);
  await fs.writeFile(outFile, cropped.buffer);
  console.log(`   → 默认参数(alphaThreshold=8): ${describeResult(best, buffer.length)}`);
  console.log(`   → 已输出 ${path.relative(ROOT, outFile)} (${formatBytes(cropped.bytes)})\n`);
}

console.log(`输出目录: ${path.relative(ROOT, outputDir)}`);
