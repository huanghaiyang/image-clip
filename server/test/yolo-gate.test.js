/**
 * YOLOv5 水印框门控（离线，ONNX）的回归用例。
 *
 * 它与文本门控互补：
 *   - 文本门控覆盖"文字水印"（PP-OCRv4 det）；
 *   - 水印框门控覆盖**图形类/非文字水印**，并且直接给出水印边界框。
 * 实测（samples/蝴蝶-豆包AI水印.jpg）：它只给出 1 个框 247×59，正落在右下角文字上；
 * 三张无水印素材给出 **0 个框** —— 说明它是"语义上认水印"，而不是像纯统计检测那样
 * 把画面内容（蝴蝶翅膀）也当成水印。
 *
 * ONNX 需要构建期导出（模型权重只有 PyTorch 格式），未导出时跳过：
 *   node scripts/download-wm-model.mjs --yolov5
 *   models\venv\Scripts\python.exe scripts/export-wm-yolov5.py
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { analyzeWatermark } from '../src/watermark.js';
import { detectWatermarkRegions, wmModelStatus } from '../src/wm-model.js';

const SAMPLES = path.resolve(import.meta.dirname, '../../samples');
const TEXT_BOX = { x: 2390, y: 1380, width: 330, height: 130 };

test('水印框门控：只框住水印本身（用户实测样例 + 三张无水印素材零框）', async (t) => {
  const status = wmModelStatus();
  if (!status.available) {
    t.skip(`未导出水印框模型（${status.reason}）`);
    return;
  }

  // 1) 用户样例：模型应给出框，且框落在文字水印上
  const buf = await fs.promises.readFile(path.join(SAMPLES, '蝴蝶-豆包AI水印.jpg'));
  const sharpMod = (await import('sharp')).default;
  const { data, info } = await sharpMod(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const image = { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
  const boxes = await detectWatermarkRegions(image);
  assert.ok(boxes.boxes.length > 0, '用户样例应至少给出一个水印框');
  assert.ok(boxes.boxes.length <= 4, `不应给出大量框（当前 ${boxes.boxes.length}）`);
  const overlap = boxes.boxes.some(
    (b) => b.x < TEXT_BOX.x + TEXT_BOX.width && b.x + b.width > TEXT_BOX.x && b.y < TEXT_BOX.y + TEXT_BOX.height && b.y + b.height > TEXT_BOX.y,
  );
  assert.ok(overlap, '给出的框应与右下角文字水印重叠');

  // 2) 门控检测：掩膜必须落在文字框内
  const result = await analyzeWatermark(buf, { method: 'yolo', sensitivity: 55 });
  assert.ok(result.coverage > 0, `门控后应检出（当前 ${(result.coverage * 100).toFixed(3)}%）`);
  let total = 0;
  let inside = 0;
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      if (result.mask.data[y * result.width + x] <= 127) continue;
      total += 1;
      if (x >= TEXT_BOX.x && x < TEXT_BOX.x + TEXT_BOX.width && y >= TEXT_BOX.y && y < TEXT_BOX.y + TEXT_BOX.height) inside += 1;
    }
  }
  assert.ok(total > 0, '掩膜不应为空');
  assert.ok(inside / total >= 0.9, `掩膜应有 ≥90% 落在文字框内（当前 ${((inside / total) * 100).toFixed(1)}%）`);

  // 掩膜必须贴着字形，不能糊成一块（用户实测反馈"范围过大"）：
  // 细笔画的填充率约 0.2~0.3，"糊成一片"会到 0.5 以上。
  let minX = result.width;
  let minY = result.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      if (result.mask.data[y * result.width + x] <= 127) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const fill = total / ((maxX - minX + 1) * (maxY - minY + 1));
  assert.ok(fill <= 0.35, `掩膜填充率应 ≤0.35（贴着笔画；当前 ${fill.toFixed(2)}）`);

  // 3) 无水印素材：模型零框 → 门控直接判无
  for (const name of ['蝴蝶-01.webp', '蝴蝶-02.webp', '蝴蝶-03.webp']) {
    const b = await fs.promises.readFile(path.join(SAMPLES, name));
    const r = await analyzeWatermark(b, { method: 'yolo', sensitivity: 70 });
    assert.equal(r.coverage, 0, `${name} 不应检出（当前 ${(r.coverage * 100).toFixed(3)}%）`);
  }
});
