/**
 * 大模型的**工具集**：模型的"手"。
 *
 * 原则：**模型只做决策，像素操作全部在本地算法里完成**。
 * 这样既满足"图片不外发"，也避免让视觉模型去生成像素（它做不到精确）。
 *
 * 每个工具返回的都是可 JSON 序列化的摘要 + artifact 列表（带 url），
 * 摘要回灌给模型用于下一步决策，artifact 交给界面展示。
 */
import sharp from 'sharp';

import { analyzeWatermark, maskToPng, removeWatermark } from '../watermark.js';
import { analyze, crop, decodeRgba, normalizeOutputFormat, readMetadata } from '../imaging.js';
import { getOpenCv } from '../opencv.js';
import { artifactView, exportArtifact, getSessionArtifact, saveArtifact } from './assets.js';

/** OpenAI function-calling 的工具定义。 */
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_assets',
      description: '列出本次对话里可用的图片（之前上传/生成的），返回 id 和尺寸。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_info',
      description: '查看某张图片的基本信息（尺寸、格式、透明像素占比、主色）。',
      parameters: {
        type: 'object',
        properties: { assetId: { type: 'string', description: '图片 artifact id' } },
        required: ['assetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crop_transparent',
      description: '自动裁掉四周的透明/纯色区域（AABB 裁剪），返回裁剪后的图片与边界。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          padding: { type: 'number', description: '保留的边距像素，默认 0' },
          threshold: { type: 'number', description: '判定为背景的容差（0~255）' },
        },
        required: ['assetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resize_image',
      description: '缩放图片。只给 width 或 height 时按比例缩放。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          fit: { type: 'string', enum: ['inside', 'cover', 'fill'] },
        },
        required: ['assetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convert_image',
      description: '转换图片格式（png/webp/jpeg/avif），可指定质量。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          format: { type: 'string', enum: ['png', 'webp', 'jpeg', 'avif'] },
          quality: { type: 'number', description: '1~100，jpeg/webp/avif 有效' },
        },
        required: ['assetId', 'format'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'detect_watermark',
      description:
        '在图片里检测水印，返回覆盖率/不透明度/候选框，并生成掩膜。method=model 用文字检测模型、method=yolo 用水印框模型（更准，能区分画面内容与真实水印）。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          method: { type: 'string', enum: ['auto', 'model', 'yolo', 'overlay', 'periodic', 'template'] },
          sensitivity: { type: 'number', description: '0~100，越大越敏感（默认 55）' },
          polarity: { type: 'string', enum: ['auto', 'bright', 'dark'] },
        },
        required: ['assetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_watermark',
      description:
        '去除水印。不传 maskId 时先自动检测；引擎 auto 会按内容自动选（反混合/背景替代/修补/LaMa 深度修补）。',
      parameters: {
        type: 'object',
        properties: {
          assetId: { type: 'string' },
          maskId: { type: 'string', description: '可选：用 detect_watermark 得到的掩膜' },
          engine: { type: 'string', enum: ['auto', 'unblend', 'bgsub', 'opencv', 'lama'] },
          method: { type: 'string', enum: ['auto', 'model', 'yolo', 'overlay', 'periodic', 'template'] },
          sensitivity: { type: 'number' },
        },
        required: ['assetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_artifact',
      description: '把某个 artifact 导出到项目的 data/exports 目录。',
      parameters: {
        type: 'object',
        properties: { artifactId: { type: 'string' }, filename: { type: 'string' } },
        required: ['artifactId'],
      },
    },
  },
];

/** 取会话/请求上下文里的图片 artifact。 */
function requireAsset(sessionId, assetId) {
  const found = getSessionArtifact(sessionId, assetId);
  if (!found) throw new Error(`找不到图片 artifact：${assetId}（先用 list_assets 看可用 id）`);
  if (!/^image\//.test(found.mime)) throw new Error(`${assetId} 不是图片`);
  return found;
}

async function imageStats(buffer) {
  const meta = await readMetadata(buffer);
  const { data, width, height } = await decodeRgba(buffer);
  let transparent = 0;
  const sums = [0, 0, 0];
  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    if (data[p + 3] < 24) transparent += 1;
    sums[0] += data[p];
    sums[1] += data[p + 1];
    sums[2] += data[p + 2];
  }
  const n = width * height || 1;
  return {
    width,
    height,
    format: meta.format,
    bytes: buffer.length,
    transparentRatio: Number((transparent / n).toFixed(4)),
    meanColor: sums.map((v) => Math.round(v / n)),
  };
}

/**
 * 执行一个工具调用。
 * @param {string} name
 * @param {object} args
 * @param {{sessionId:string}} ctx
 */
export async function executeTool(name, args = {}, ctx = {}) {
  const sessionId = ctx.sessionId ?? null;

  switch (name) {
    case 'list_assets': {
      const assets = (ctx.assets ?? []).map(artifactView);
      return { ok: true, assets };
    }
    case 'image_info': {
      const { meta, buffer } = requireAsset(sessionId, args.assetId);
      return { ok: true, artifact: artifactView(meta), ...(await imageStats(buffer)) };
    }
    case 'crop_transparent': {
      const { buffer } = requireAsset(sessionId, args.assetId);
      const options = {
        padding: Number.isFinite(args.padding) ? args.padding : 0,
        threshold: Number.isFinite(args.threshold) ? args.threshold : undefined,
      };
      const analyzed = await analyze(buffer, options);
      const cropped = await crop(buffer, options);
      const saved = saveArtifact(cropped.buffer, {
        ext: 'png',
        kind: 'result',
        label: '透明区域裁剪',
        width: cropped.bounds.width,
        height: cropped.bounds.height,
        sessionId,
      });
      return {
        ok: true,
        bounds: analyzed.bounds ?? null,
        trimmed: Boolean(analyzed.trimmed),
        artifact: artifactView(saved),
      };
    }
    case 'resize_image': {
      const { buffer } = requireAsset(sessionId, args.assetId);
      const meta = await readMetadata(buffer);
      let pipeline = sharp(buffer);
      if (Number.isFinite(args.width) && Number.isFinite(args.height)) {
        pipeline = pipeline.resize({ width: args.width, height: args.height, fit: args.fit || 'inside' });
      } else if (Number.isFinite(args.width)) {
        pipeline = pipeline.resize({ width: args.width });
      } else if (Number.isFinite(args.height)) {
        pipeline = pipeline.resize({ height: args.height });
      } else {
        throw new Error('resize_image 需要 width 或 height');
      }
      const out = await pipeline.png().toBuffer({ resolveWithObject: true });
      const saved = saveArtifact(out.data, {
        ext: 'png',
        kind: 'result',
        label: `缩放 ${out.info.width}×${out.info.height}`,
        width: out.info.width,
        height: out.info.height,
        sessionId,
      });
      return { ok: true, from: { width: meta.width, height: meta.height }, artifact: artifactView(saved) };
    }
    case 'convert_image': {
      const { buffer } = requireAsset(sessionId, args.assetId);
      const format = normalizeOutputFormat(args.format);
      const quality = Number.isFinite(args.quality) ? Math.max(1, Math.min(100, args.quality)) : 90;
      let pipeline = sharp(buffer);
      pipeline = format === 'png' ? pipeline.png() : format === 'webp' ? pipeline.webp({ quality }) : format === 'avif' ? pipeline.avif({ quality }) : pipeline.jpeg({ quality });
      const out = await pipeline.toBuffer({ resolveWithObject: true });
      const saved = saveArtifact(out.data, {
        ext: format === 'jpeg' ? 'jpeg' : format,
        kind: 'result',
        label: `转为 ${format}`,
        width: out.info.width,
        height: out.info.height,
        sessionId,
      });
      return { ok: true, artifact: artifactView(saved) };
    }
    case 'detect_watermark': {
      const { buffer } = await requireAsset(sessionId, args.assetId);
      const options = {
        method: args.method ?? 'model',
        sensitivity: Number.isFinite(args.sensitivity) ? args.sensitivity : 55,
        polarity: args.polarity,
      };
      const result = await analyzeWatermark(buffer, options);
      const maskPng = await maskToPng(result.mask);
      const mask = saveArtifact(maskPng, {
        ext: 'png',
        kind: 'mask',
        label: '水印掩膜',
        width: result.width,
        height: result.height,
        sessionId,
      });
      return {
        ok: true,
        method: result.method,
        coverage: Number((result.coverage * 100).toFixed(3)),
        confidence: result.confidence,
        estimatedAlpha: result.estimatedAlpha,
        boxes: (result.boxes ?? []).slice(0, 8),
        proposal: result.textGate?.used ? { sources: result.textGate.sources, regions: result.textGate.regions } : { used: false },
        mask: artifactView(mask),
        hint: result.coverage > 0 ? '检出掩膜，可调用 remove_watermark（传 maskId）去除' : '未检出：可提高 sensitivity，或改用 method=yolo',
      };
    }
    case 'remove_watermark': {
      const { buffer } = await requireAsset(sessionId, args.assetId);
      const options = {
        engine: args.engine ?? 'auto',
        method: args.method ?? 'model',
        sensitivity: Number.isFinite(args.sensitivity) ? args.sensitivity : 55,
      };
      if (args.maskId) {
        const maskArtifact = getSessionArtifact(sessionId, args.maskId);
        if (!maskArtifact) throw new Error(`找不到掩膜 artifact：${args.maskId}`);
        options.mask = maskArtifact.buffer;
      }
      const removed = await removeWatermark(buffer, options);
      const saved = saveArtifact(removed.buffer, {
        ext: 'png',
        kind: 'result',
        label: `去水印（${removed.engine}）`,
        width: removed.width ?? null,
        height: removed.height ?? null,
        sessionId,
      });
      return {
        ok: true,
        engine: removed.engine,
        alpha: removed.alpha ?? null,
        changedOutsideMask: removed.integrity?.changedOutsideMask ?? null,
        artifact: artifactView(saved),
      };
    }
    case 'save_artifact': {
      const out = exportArtifact(args.artifactId, args.filename);
      return { ok: true, ...out };
    }
    default:
      return { ok: false, error: `未知工具：${name}` };
  }
}

/** 供 /api/llm/health 用：检测能力是否就绪（不实际跑模型）。 */
export async function toolsStatus() {
  try {
    await getOpenCv();
    return { available: true, tools: TOOL_DEFINITIONS.map((t) => t.function.name) };
  } catch (err) {
    return { available: false, error: err.message, tools: TOOL_DEFINITIONS.map((t) => t.function.name) };
  }
}

