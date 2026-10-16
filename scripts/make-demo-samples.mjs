/**
 * 生成"带水印"的演示素材。
 *
 * 仓库里的三张蝴蝶图本身没有水印（自动检测会如实报告"没找到"），
 * 所以这里合成一张**平铺半透明文字水印**的示例图，方便直接体验
 * 「自动识别 → 反混合去除」的完整流程。
 *
 *   node scripts/make-demo-samples.mjs
 *
 * 输出：samples/示例-平铺水印.webp（不透明底图 + 旋转平铺文字，α≈0.28）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = path.join(ROOT, 'samples');

/** 平铺水印的单个瓦片（旋转 -30° 的半透明文字）。
 *  不透明度取 0.55：叠在彩色主体上时，半透明水印会把局部饱和度拉低，
 *  而检测器有饱和度门限（用来挡掉彩色画面内容），所以演示图用真实素材里
 *  常见的"明显可见"档位，保证开箱即能被识别。 */
function watermarkTile({ size = 440, alpha = 0.55 } = {}) {
  return Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(-30 ${size / 2} ${size / 2})" fill="#ffffff" fill-opacity="${alpha}"
     font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="700" letter-spacing="3">
    <text x="24" y="150">DEMO WATERMARK</text>
    <text x="24" y="320">示例水印 2026</text>
  </g>
</svg>`);
}

async function main() {
  const base = path.join(SAMPLES, '蝴蝶-02.webp');
  const image = sharp(base);
  const meta = await image.metadata();

  // 1) 把带透明通道的素材压到渐变底上，模拟"照片"（这样水印是叠加在内容之上的）
  //    底色刻意压暗一些：水印是白色半透明，底色越亮对比越弱（这是物理限制）
  const background = Buffer.from(`<svg width="${meta.width}" height="${meta.height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#9aa6b2"/>
      <stop offset="55%" stop-color="#7d8b99"/>
      <stop offset="100%" stop-color="#5d6b78"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`);

  const flattened = await sharp(background)
    .composite([{ input: await fs.readFile(base), blend: 'over' }])
    .png()
    .toBuffer();

  // 2) 平铺半透明水印
  const watermarked = await sharp(flattened)
    .composite([{ input: watermarkTile(), tile: true, blend: 'over' }])
    .webp({ quality: 92 })
    .toBuffer();

  const outFile = path.join(SAMPLES, '示例-平铺水印.webp');
  await fs.writeFile(outFile, watermarked);

  // 3) 顺便写一张"角标"变体：同一个角标出现在**两个对角**（这是常见的版权水印形态，
  //    也让"重复性"判据能认出来）。单个孤立的角标请用模板匹配/框选/画笔。
  const cornerMark = Buffer.from(`<svg width="320" height="90" xmlns="http://www.w3.org/2000/svg">
  <g fill="#ffffff" fill-opacity="0.5" font-family="Arial, Helvetica, sans-serif">
    <circle cx="34" cy="46" r="20" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="4"/>
    <text x="66" y="42" font-size="22" font-weight="700">DEMO</text>
    <text x="66" y="68" font-size="16" letter-spacing="3">STOCK PHOTO</text>
  </g>
</svg>`);
  const cornerFile = path.join(SAMPLES, '示例-角标水印.webp');
  const cornerImage = await sharp(flattened)
    .composite([
      { input: cornerMark, top: 40, left: 40, blend: 'over' },
      { input: cornerMark, top: meta.height - 130, left: meta.width - 360, blend: 'over' },
    ])
    .webp({ quality: 92 })
    .toBuffer();
  await fs.writeFile(cornerFile, cornerImage);

  console.log(`已生成：${path.relative(ROOT, outFile)}（${(watermarked.length / 1024).toFixed(0)} KB）`);
  console.log(`已生成：${path.relative(ROOT, cornerFile)}（${(cornerImage.length / 1024).toFixed(0)} KB）`);
}

await main();
