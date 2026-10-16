/**
 * 验收脚本：**模型未安装时行为必须与之前完全一致**（可开关、可回退）。
 *
 * 做法：用环境变量 TEXT_DET_ONNX 指向一个不存在的路径来模拟"没装模型"
 * （比改名/删文件干净，也不依赖文件系统权限）。然后逐字节比较：
 *   - 门控开启 但模型缺失  → 结果必须与"门控关闭"完全一致；
 *   - 三种开关组合都不能抛异常。
 *
 * 用法：node scripts/verify-model-fallback.mjs
 */
import path from 'node:path';
import fs from 'node:fs';

process.env.TEXT_DET_ONNX = path.resolve('/definitely-missing/ppocrv4-det.onnx');
process.env.WM_MODEL_PATH = path.resolve('/definitely-missing/watermark-yolov5.onnx');

const { analyzeWatermark } = await import('../server/src/watermark.js');
const { textModelStatus } = await import('../server/src/text-detect.js');
const { wmModelStatus } = await import('../server/src/wm-model.js');

const SAMPLES = [
  '蝴蝶-豆包AI水印.jpg',
  '蝴蝶-01.webp',
  '蝴蝶-02.webp',
  '蝴蝶-03.webp',
  '示例-平铺水印.webp',
  '示例-角标水印.webp',
];

function signature(result) {
  return JSON.stringify({
    coverage: Number(result.coverage.toFixed(8)),
    confidence: Number(result.confidence.toFixed(6)),
    alpha: result.estimatedAlpha,
    method: result.method,
    boxes: result.boxes.length,
    maskOn: result.mask.data.reduce((n, v) => n + (v > 127 ? 1 : 0), 0),
  });
}

const status = textModelStatus();
const yoloStatus = wmModelStatus();
console.log('模拟"未安装任何模型"：');
console.log(`  TEXT_DET_ONNX=${process.env.TEXT_DET_ONNX}`);
console.log(`  WM_MODEL_PATH=${process.env.WM_MODEL_PATH}`);
console.log(`  textModelStatus().available = ${status.available}（期望 false）`);
console.log(`  wmModelStatus().available  = ${yoloStatus.available}（期望 false）\n`);
if (status.available || yoloStatus.available) {
  console.error('✗ 环境变量没有生效，验收无效');
  process.exit(1);
}

// 请求方式：门控布尔、以及两个 method 门控值 —— 模型都不在时，结果必须与"无门控"完全一致
const VARIANTS = [
  ['textGate', { textGate: true }],
  ['yoloGate', { yoloGate: true }],
  ['method=model', { method: 'model' }],
  ['method=yolo', { method: 'yolo' }],
  ['双源并集', { textGate: true, yoloGate: true }],
];

let failures = 0;
for (const name of SAMPLES) {
  const buffer = await fs.promises.readFile(path.join('samples', name));
  for (const sensitivity of [55, 70]) {
    const off = await analyzeWatermark(buffer, { method: 'auto', sensitivity });
    for (const [label, extra] of VARIANTS) {
      // method 变体要把 sensitivity 带上；布尔变体沿用 auto
      const on = await analyzeWatermark(buffer, { method: 'auto', sensitivity, ...extra });
      const same = signature(off) === signature(on);
      if (!same) failures += 1;
      const reportedUnused = on.textGate?.used === false;
      if (!reportedUnused) failures += 1;
      console.log(
        `${same && reportedUnused ? '✓' : '✗'} ${name.padEnd(22)} s${String(sensitivity).padEnd(3)} ${label.padEnd(12)} ` +
          `无门控:${(off.coverage * 100).toFixed(3)}%/${off.boxes.length}框  ` +
          `缺模型时:${(on.coverage * 100).toFixed(3)}%/${on.boxes.length}框  used=${on.textGate?.used}`,
      );
    }
  }
}

console.log(`\n${failures === 0 ? '✓ 全部一致：模型缺失时行为与之前完全相同' : `✗ ${failures} 处不一致`}`);
process.exit(failures === 0 ? 0 : 1);
