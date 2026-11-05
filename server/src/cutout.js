/**
 * AI 精准抠图 · 模型托管
 * ----------------------
 * 推理在浏览器里用 onnxruntime-web（WASM）完成，服务端只负责：
 *   1. 报告模型是否已下载（前端据此决定按钮可用/提示下载命令）；
 *   2. 把本地模型文件以流的方式发给浏览器，供其缓存到 Cache Storage 后推理。
 *
 * 模型文件不随仓库分发，下载命令见 scripts/download-cutout-models.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CUTOUT_MODELS, findCutoutModel } from '../../shared/cutout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 模型目录在调用时解析，便于测试/部署时用环境变量切换。 */
function modelDir() {
  return process.env.IMAGE_CLIP_MODEL_DIR || path.join(ROOT, 'models');
}

/** 单个模型的落盘路径；id 必须来自注册表，避免路径穿越。 */
export function cutoutModelPath(id) {
  const model = findCutoutModel(id);
  if (!model) return null;
  return path.join(modelDir(), model.file);
}

/** 模型可用状态（供 /api/cutout/health 与前端按钮状态使用）。 */
export function cutoutStatus() {
  return {
    ok: true,
    service: 'image-clip-cutout',
    runtime: 'onnxruntime-web (WASM)',
    models: CUTOUT_MODELS.map((model) => {
      const modelPath = cutoutModelPath(model.id);
      let available = false;
      let actualBytes = null;
      try {
        actualBytes = fs.statSync(modelPath).size;
        available = actualBytes === model.bytes;
      } catch {
        actualBytes = null;
      }
      return {
        id: model.id,
        label: model.label,
        hint: model.hint,
        file: model.file,
        bytes: model.bytes,
        actualBytes,
        available,
        licence: model.licence,
        url: `/api/cutout/model/${model.id}`,
      };
    }),
    install: 'node scripts/download-cutout-models.mjs',
  };
}
