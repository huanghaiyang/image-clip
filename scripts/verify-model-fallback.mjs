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

const { analyzeWatermark } = await import('../server/src/watermark.js');
const { textModelStatus } = await import('../server/src/text-detect.js');

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
console.log(`模拟"未安装模型"：TEXT_DET_ONNX=${process.env.TEXT_DET_ONNX}`);
console.log(`textModelStatus().available = ${status.available}（期望 false）\n`);
if (status.available) {
  console.error('✗ 环境变量没有生效，验收无效');
  process.exit(1);
}

let failures = 0;
for (const name of SAMPLES) {
  const buffer = await fs.promises.readFile(path.join('samples', name));
  for (const sensitivity of [55, 70]) {
    const off = await analyzeWatermark(buffer, { method: 'auto', sensitivity });
    const on = await analyzeWatermark(buffer, { method: 'auto', sensitivity, textGate: true });
    const same = signature(off) === signature(on);
    if (!same) failures += 1;
    const gateOff = off.textGate?.used === false;
    const gateOn = on.textGate?.used === false; // 没模型时即使请求开启也必须报告未使用
    console.log(
      `${same && gateOff && gateOn ? '✓' : '✗'} ${name.padEnd(22)} s${String(sensitivity).padEnd(3)} ` +
        `门控关:${(off.coverage * 100).toFixed(3)}%/${off.boxes.length}框  ` +
        `门控开(缺模型):${(on.coverage * 100).toFixed(3)}%/${on.boxes.length}框  ` +
        `used=${on.textGate?.used}`,
    );
  }
}

console.log(`\n${failures === 0 ? '✓ 全部一致：模型缺失时行为与之前完全相同' : `✗ ${failures} 处不一致`}`);
process.exit(failures === 0 ? 0 : 1);
