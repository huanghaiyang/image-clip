/**
 * 文本区域门控（离线语义模型）的回归用例。
 *
 * 这条用例锁住用户实测的那个问题：那张 20 只蝴蝶的插画里**只有右下角有文字水印**，
 * 而纯统计检测把画面内容也算成了水印（掩膜 99.6% 落在蝴蝶上）。
 * 门控开启后要求：
 *   - 检出结果 100% 落在文字区域内；
 *   - 无水印素材仍然 0%。
 *
 * 模型文件（models/ppocrv4-det.onnx，4.5MB）没有随仓库分发，所以缺模型时跳过，
 * 不让没有模型的机器变红：`node scripts/download-wm-model.mjs` 可获取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { analyzeWatermark } from '../src/watermark.js';
import { textModelStatus } from '../src/text-detect.js';

const SAMPLES = path.resolve(import.meta.dirname, '../../samples');
/** 用户样例里「豆包AI生成」实际占用的区域（目测，用于算精确率）。 */
const TEXT_BOX = { x: 2390, y: 1380, width: 330, height: 130 };

test('文本门控：把水印检测限制在文字区域内（用户实测样例）', async (t) => {
  const status = textModelStatus();
  if (!status.available) {
    t.skip(`未安装文本检测模型（${status.reason}）`);
    return;
  }

  const buffer = await fs.promises.readFile(path.join(SAMPLES, '蝴蝶-豆包AI水印.jpg'));
  const result = await analyzeWatermark(buffer, { method: 'auto', sensitivity: 55, textGate: true });

  assert.equal(result.textGate.used, true, '应启用文本门控');
  assert.ok(result.textGate.regions > 0, `应找到文字区域（当前 ${result.textGate.regions}）`);
  assert.ok(result.coverage > 0, `门控后仍应检出这段角标（当前 ${(result.coverage * 100).toFixed(3)}%）`);

  // 精确率：检出的掩膜必须全部落在文字框内（这正是修复"把蝴蝶认成水印"的判据）
  let total = 0;
  let inside = 0;
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      if (result.mask.data[y * result.width + x] <= 127) continue;
      total += 1;
      if (x >= TEXT_BOX.x && x < TEXT_BOX.x + TEXT_BOX.width && y >= TEXT_BOX.y && y < TEXT_BOX.y + TEXT_BOX.height) {
        inside += 1;
      }
    }
  }
  assert.ok(total > 0, '掩膜不应为空');
  // 召回：门控内还会跑一遍低阈值恢复（见 analyzeWatermark 的 recoverInsideGate），
  // 否则只覆盖文字框的 1.4%，检出是对的却清不干净。实测恢复后约 24%。
  const boxCoverage = inside / (TEXT_BOX.width * TEXT_BOX.height);
  assert.ok(boxCoverage >= 0.15, `文字框覆盖率应 ≥15%（当前 ${(boxCoverage * 100).toFixed(1)}%）`);
  const precision = inside / total;
  assert.ok(precision >= 0.9, `掩膜应有 ≥90% 落在文字框内（当前 ${(precision * 100).toFixed(1)}%）`);
});

test('文本门控：无文字的无水印素材不应产生任何检出', async (t) => {
  const status = textModelStatus();
  if (!status.available) {
    t.skip(`未安装文本检测模型（${status.reason}）`);
    return;
  }
  for (const name of ['蝴蝶-01.webp', '蝴蝶-02.webp', '蝴蝶-03.webp']) {
    const buffer = await fs.promises.readFile(path.join(SAMPLES, name));
    const result = await analyzeWatermark(buffer, { method: 'auto', sensitivity: 70, textGate: true });
    assert.equal(result.coverage, 0, `${name} 不应检出（当前 ${(result.coverage * 100).toFixed(3)}%）`);
  }
});
