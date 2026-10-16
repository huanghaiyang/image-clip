/**
 * 水印识别 / 去除的**量化验证**报告。
 *
 *   node scripts/verify-watermark.mjs
 *
 * 做法：合成"已知水印"（真值掩膜与不透明度都由脚本自己掌握），于是可以给出硬指标：
 *   - 检测：IoU / 精确率 / 召回率（对比真值掩膜）
 *   - 去除：PSNR / SSIM（对比"干净原图"），并给出带水印图的基线
 *   - 不变量：掩膜外的像素改动数（必须为 0）
 * 另外跑两张真实素材做阴性对照（无水印时不应该报出任何水印）。
 *
 * 结果同时写到 probe-out/watermark/ 便于人工看图确认。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { analyzeWatermark, removeWatermark } from '../server/src/watermark.js';
import { compareMasks } from '../shared/watermark/mask.js';
import { psnr, ssim } from '../shared/watermark/metrics.js';
import { lamaStatus } from '../server/src/lama.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'probe-out', 'watermark');
const W = 900;
const H = 620;

/** 有结构、有纹理的"照片"（纯色图会让一切指标都虚高）。 */
function cleanImage(width = W, height = H) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      data[p] = 64 + 96 * (x / width) + 20 * Math.sin(x / 6);
      data[p + 1] = 86 + 74 * (y / height) + 16 * Math.cos(y / 8);
      data[p + 2] = 146 - 46 * ((x + y) / (width + height)) + 24 * Math.sin((x + y) / 10);
      data[p + 3] = 255;
    }
  }
  // 加几个色块，制造结构
  const blocks = [
    [60, 60, 220, 160],
    [420, 90, 520, 230],
    [240, 400, 460, 520],
  ];
  blocks.forEach(([x0, y0, x1, y1], i) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const p = (y * width + x) * 4;
        data[p] = i === 0 ? 205 : i === 1 ? 60 : 120;
        data[p + 1] = i === 0 ? 110 : i === 1 ? 150 : 90;
        data[p + 2] = i === 0 ? 70 : i === 1 ? 60 : 200;
      }
    }
  });
  return { width, height, data };
}

/** 叠一层半透明水印；返回带水印图与真值掩膜。 */
function applyWatermark(image, { alpha, color = [255, 255, 255], bars }) {
  const dirty = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const mask = new Uint8Array(image.width * image.height);
  for (const [x0, y0, x1, y1] of bars) {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const p = (y * image.width + x) * 4;
        for (let c = 0; c < 3; c += 1) dirty.data[p + c] = dirty.data[p + c] * (1 - alpha) + color[c] * alpha;
        mask[y * image.width + x] = 255;
      }
    }
  }
  return { dirty, truth: { width: image.width, height: image.height, data: mask } };
}

const toPng = (image) =>
  sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } }).png().toBuffer();

const fromBuffer = async (buffer) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
};

/** 平铺文字水印（多实例，检测器应当能靠"重复"认出来）。 */
function tiledBars() {
  const bars = [];
  for (let row = 0; row < 4; row += 1) {
    const y0 = 120 + row * 110;
    for (let col = 0; col < 3; col += 1) {
      const x0 = 60 + col * 280 + row * 12;
      bars.push([x0, y0, x0 + 220, y0 + 14]);
    }
  }
  return bars;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const lama = lamaStatus();
  console.log('═'.repeat(78));
  console.log('水印识别 / 去除 · 量化验证');
  console.log(`  LaMa 模型：${lama.available ? `已安装（${lama.path}，${(lama.bytes / 1024 / 1024).toFixed(0)}MB）` : '未安装 → 深度引擎将回退 OpenCV'}`);
  console.log('═'.repeat(78));

  const scenarios = [
    { name: '平铺文字水印 α=0.30', alpha: 0.3, bars: tiledBars() },
    // 居中但是"文字状"的细笔画（自动检测针对细结构，粗大色块不在其范围内）
    {
      name: '居中文字水印 α=0.45',
      alpha: 0.45,
      bars: [
        [260, 250, 640, 262], [260, 276, 600, 288], [260, 302, 620, 314], [260, 328, 580, 340],
        [300, 360, 600, 372], [330, 386, 570, 398],
      ],
    },
    { name: '低不透明度 α=0.18', alpha: 0.18, bars: tiledBars().slice(0, 6) },
  ];

  const rows = [];
  for (const scenario of scenarios) {
    const clean = cleanImage();
    const { dirty, truth } = applyWatermark(clean, scenario);

    const dirtyPng = await toPng(dirty);
    const detect = await analyzeWatermark(dirtyPng, { method: 'auto', sensitivity: 50 });
    const cmp = compareMasks(detect.mask, truth);

    // 检测不到时不去除（remove 会明确报 EMPTY_MASK），报告里如实标注
    let removed = null;
    try {
      removed = await removeWatermark(dirtyPng, { engine: 'auto' });
    } catch (err) {
      console.log(`  ⚠ ${scenario.name}：自动检测未找到水印（${err.message}）`);
    }
    const output = removed ? await fromBuffer(removed.buffer) : null;

    const row = {
      scene: scenario.name,
      method: `${detect.method}${detect.usedMethods.length > 1 ? ` (${detect.usedMethods.join('+')})` : ''}`,
      iou: cmp.iou,
      precision: cmp.precision,
      recall: cmp.recall,
      alpha: removed?.alpha ?? null,
      engine: removed?.engine ?? '—',
      before: psnr(clean, dirty),
      after: output ? psnr(clean, output) : NaN,
      ssimAfter: output ? ssim(clean, output) : NaN,
      leaked: removed?.integrity.changedOutsideMask ?? '—',
      ms: removed?.elapsedMs ?? detect.elapsedMs,
    };
    rows.push(row);

    // 输出图，便于人工确认
    const stem = scenario.name.replace(/[^\w\u4e00-\u9fa5]+/g, '-');
    await fs.writeFile(path.join(OUT, `${stem}-1-带水印.png`), dirtyPng);
    await fs.writeFile(
      path.join(OUT, `${stem}-2-检测掩膜.png`),
      await sharp(detect.mask.data, { raw: { width: detect.mask.width, height: detect.mask.height, channels: 1 } })
        .png()
        .toBuffer(),
    );
    if (removed) await fs.writeFile(path.join(OUT, `${stem}-3-去除结果.png`), removed.buffer);
  }

  const fmt = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
  console.log('\n【合成水印：检测精度 / 去除质量】');
  console.log('场景                     检测                                 IoU    精确   召回   α估计   引擎     带水印PSNR  去除后PSNR  SSIM    掩膜外改动  耗时');
  for (const r of rows) {
    console.log(
      `${r.scene.padEnd(24)}${r.method.padEnd(36)}${fmt(r.iou).padEnd(7)}${fmt(r.precision).padEnd(7)}${fmt(r.recall).padEnd(7)}` +
        `${String(r.alpha ?? '—').padEnd(8)}${r.engine.padEnd(9)}${fmt(r.before, 2).padEnd(12)}${fmt(r.after, 2).padEnd(12)}` +
        `${fmt(r.ssimAfter, 4).padEnd(8)}${String(r.leaked).padEnd(12)}${r.ms}ms`,
    );
  }

  console.log('\n【真实素材：阴性对照（原图没有水印，应当"什么都不报"）】');
  const samples = ['蝴蝶-01.webp', '蝴蝶-02.webp', '蝴蝶-03.webp'];
  for (const name of samples) {
    const buffer = await fs.readFile(path.join(ROOT, 'samples', name));
    const result = await analyzeWatermark(buffer, { method: 'auto', sensitivity: 50 });
    console.log(
      `  ${name.padEnd(18)} 覆盖率 ${(result.coverage * 100).toFixed(2)}%  置信度 ${result.confidence}  候选框 ${result.boxes.length}  ${result.elapsedMs}ms`,
    );
  }

  console.log('\n【演示素材：真的带水印的合成样例】');
  for (const name of ['示例-平铺水印.webp', '示例-角标水印.webp']) {
    const buffer = await fs.readFile(path.join(ROOT, 'samples', name));
    const result = await analyzeWatermark(buffer, { method: 'auto', sensitivity: 50 });
    const withRepeat = result.coverage > 0;
    console.log(
      `  ${name.padEnd(20)} 覆盖率 ${(result.coverage * 100).toFixed(2)}%  置信度 ${result.confidence}  α估计 ${result.estimatedAlpha ?? '—'}  ${
        withRepeat ? '已识别' : '未识别（单个角标建议用模板匹配/画笔，或调高灵敏度）'
      }`,
    );
  }

  console.log(`\n图片输出目录：${path.relative(ROOT, OUT)}`);
}

await main();
