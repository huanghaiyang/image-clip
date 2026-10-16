/**
 * image-clip 服务端
 * -----------------
 * AABB 自动识别透明区域并裁剪图片的 HTTP API。
 *
 *   GET  /api/health            健康检查 + 引擎能力
 *   GET  /api/options           默认检测参数（与前端共享同一份契约）
 *   GET  /api/samples           示例图片清单
 *   GET  /api/samples/:name     示例图片原图
 *   POST /api/analyze           检测 AABB → JSON
 *   POST /api/crop              裁剪 → 图片二进制（?response=json 可拿 dataURL）
 *   POST /api/crop/batch        批量裁剪 → JSON
 *
 * POST 请求体可以是原始图片二进制（Content-Type: image/*），
 * 也可以是 JSON：{ image: "data:image/png;base64,..." | "<base64>", options: {...} }。
 */
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALGORITHM,
  InputError,
  LIMITS,
  OUTPUT_FORMATS,
  analyze,
  crop,
  pickOptions,
  toBuffer,
  toDataUrl,
} from './imaging.js';
import { DEFAULT_OPTIONS } from '../../shared/aabb.js';
import {
  DEFAULT_REMOVE_OPTIONS,
  REMOVE_ENGINES,
  analyzeWatermark,
  maskToDataUrl,
  maskToRle,
  removeWatermark,
} from './watermark.js';
import { opencvStatus } from './opencv.js';
import { lamaStatus } from './lama.js';
import { textModelStatus } from './text-detect.js';
import { wmModelStatus } from './wm-model.js';
import { DETECT_METHODS, DEFAULT_DETECT_OPTIONS } from '../../shared/watermark/detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const WEB_DIST = path.join(ROOT, 'web/dist');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const SAMPLE_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.avif', '.gif']);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // 所有写接口都用“原始二进制”接收，JSON 负载由 extractInput 内部分支处理。
  const rawBody = express.raw({ type: () => true, limit: LIMITS.maxUploadBytes });

  app.get('/api/health', async (_req, res) => {
    let sharpVersion = null;
    try {
      const sharp = (await import('sharp')).default;
      sharpVersion = sharp.versions?.sharp ?? null;
    } catch {
      /* sharp 不可用时仍然报告服务状态，便于定位 */
    }
    res.json({
      ok: true,
      service: 'image-clip-server',
      algorithm: ALGORITHM,
      engine: 'node-sharp',
      sharp: sharpVersion,
      sharpAvailable: Boolean(sharpVersion),
      outputFormats: OUTPUT_FORMATS,
      limits: LIMITS,
      defaults: DEFAULT_OPTIONS,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get('/api/options', (_req, res) => {
    res.json({ algorithm: ALGORITHM, defaults: DEFAULT_OPTIONS, outputFormats: OUTPUT_FORMATS });
  });

  app.get('/api/samples', async (_req, res, next) => {
    try {
      res.json({ samples: await listSamples() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/samples/:name', async (req, res, next) => {
    try {
      const file = resolveSamplePath(req.params.name);
      await fs.access(file);
      res.type(path.extname(file)).sendFile(file);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/analyze', rawBody, async (req, res, next) => {
    try {
      const { buffer, body } = extractInput(req);
      const options = pickOptions(req.query, body);
      const result = await analyze(buffer, options, null);
      res.json({
        name: body.name ?? null,
        engine: 'node-sharp',
        algorithm: ALGORITHM,
        source: result.source,
        bounds: result.bounds,
        trimmed: result.trimmed,
        empty: result.empty,
        contentPixels: result.contentPixels,
        contentRatio: result.contentRatio,
        options: result.options,
        elapsedMs: result.elapsedMs,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/crop', rawBody, async (req, res, next) => {
    try {
      const { buffer, body } = extractInput(req);
      const options = pickOptions(req.query, body);
      const result = await crop(buffer, options);
      const boundsHeader = Buffer.from(JSON.stringify(result.bounds)).toString('base64');

      if (String(req.query.response ?? body.response ?? '') === 'json') {
        res.json({
          name: body.name ?? null,
          engine: 'node-sharp',
          algorithm: ALGORITHM,
          mime: result.mime,
          bytes: result.bytes,
          bounds: result.bounds,
          trimmed: result.trimmed,
          source: result.source,
          options: result.options,
          elapsedMs: result.elapsedMs,
          dataUrl: toDataUrl(result.mime, result.buffer),
        });
        return;
      }

      res
        .status(200)
        .type(result.mime)
        .set('X-Image-Clip-Bounds', boundsHeader)
        .set('X-Image-Clip-Engine', 'node-sharp')
        .set('X-Image-Clip-Algorithm', ALGORITHM)
        .set('Content-Disposition', `inline; filename="${encodeURIComponent(croppedName(body.name, result.format))}"`)
        .send(result.buffer);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/crop/batch', rawBody, async (req, res, next) => {
    try {
      const body = parseJsonBody(req);
      const images = Array.isArray(body?.images) ? body.images : null;
      if (!images) throw new InputError('批量裁剪需要 JSON：{ images: [{ name, image }], options }', 'BAD_BATCH_INPUT');
      if (images.length === 0) throw new InputError('images 为空', 'BAD_BATCH_INPUT');
      if (images.length > LIMITS.maxBatch) {
        throw new InputError(`单次批量最多 ${LIMITS.maxBatch} 张`, 'BATCH_TOO_LARGE', 413);
      }

      const options = pickOptions({}, body);
      const results = [];
      for (const [index, item] of images.entries()) {
        const name = item?.name ?? `image-${index + 1}`;
        try {
          const result = await crop(toBuffer(item?.image ?? item?.dataUrl), options);
          results.push({
            name,
            ok: true,
            mime: result.mime,
            bytes: result.bytes,
            bounds: result.bounds,
            trimmed: result.trimmed,
            source: result.source,
            dataUrl: toDataUrl(result.mime, result.buffer),
          });
        } catch (err) {
          results.push({ name, ok: false, error: { code: err.code ?? 'FAILED', message: err.message } });
        }
      }

      res.json({
        algorithm: ALGORITHM,
        engine: 'node-sharp',
        options: pickOptions({}, { options: body.options }),
        total: results.length,
        succeeded: results.filter((r) => r.ok).length,
        results,
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------- 水印

  app.get('/api/watermark/health', async (_req, res) => {
    const [opencv, lama] = await Promise.all([opencvStatus(), Promise.resolve(lamaStatus())]);
    res.json({
      ok: opencv.available,
      service: 'image-clip-watermark',
      engine: opencv.available ? 'node-opencv' : 'unavailable',
      opencv,
      lama,
      textModel: textModelStatus(),
      wmModel: wmModelStatus(),
      detectMethods: [
        ...DETECT_METHODS,
        ...(textModelStatus().available ? ['model'] : []),
        ...(wmModelStatus().available ? ['yolo'] : []),
      ],
      engines: REMOVE_ENGINES,
      detectDefaults: DEFAULT_DETECT_OPTIONS,
      removeDefaults: DEFAULT_REMOVE_OPTIONS,
      limits: { maxPixels: LIMITS.maxPixels },
    });
  });

  app.post('/api/watermark/detect', rawBody, async (req, res, next) => {
    try {
      const { buffer, body } = extractInput(req);
      const options = watermarkOptions(req.query, body);
      const result = await analyzeWatermark(buffer, options);
      res.json({
        name: body.name ?? null,
        engine: 'node-opencv',
        method: result.method,
        usedMethods: result.usedMethods,
        confidence: result.confidence,
        coverage: result.coverage,
        estimatedAlpha: result.estimatedAlpha,
        boxes: result.boxes,
        mask: {
          width: result.mask.width,
          height: result.mask.height,
          dataUrl: await maskToDataUrl(result.mask),
        },
        rle: maskToRle(result.mask),
        width: result.width,
        height: result.height,
        textGate: result.textGate ?? null,
        diagnostics: result.diagnostics,
        elapsedMs: result.elapsedMs,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/watermark/remove', rawBody, async (req, res, next) => {
    try {
      const { buffer, body } = extractInput(req);
      const options = watermarkOptions(req.query, body);
      // 前端画笔编辑过的掩膜会以 mask 字段回传，优先使用它
      if (body.mask) options.mask = body.mask;
      const result = await removeWatermark(buffer, options);

      if (String(req.query.response ?? body.response ?? '') === 'json') {
        res.json({
          name: body.name ?? null,
          engine: result.engine,
          requestedEngine: result.requestedEngine,
          reason: result.reason,
          alpha: result.alpha,
          alphaConfidence: result.alphaConfidence,
          watermarkColor: result.watermarkColor,
          coverage: result.coverage,
          patches: result.patches,
          detection: result.detection,
          integrity: result.integrity,
          source: result.source,
          elapsedMs: result.elapsedMs,
          mime: result.mime,
          bytes: result.buffer.length,
          dataUrl: toDataUrl(result.mime, result.buffer),
          maskDataUrl: result.maskPng ? toDataUrl('image/png', result.maskPng) : null,
        });
        return;
      }

      res
        .status(200)
        .type(result.mime)
        .set('X-Image-Clip-Engine', result.engine)
        .set('X-Image-Clip-Alpha', String(result.alpha ?? ''))
        .set('X-Image-Clip-Elapsed-Ms', String(result.elapsedMs ?? ''))
        .set('X-Watermark-Engine', result.engine)
        .set('X-Watermark-Elapsed-Ms', String(result.elapsedMs ?? ''))
        .set('X-Watermark-Alpha', String(result.alpha ?? ''))
        .set('Content-Disposition', `inline; filename="${encodeURIComponent(watermarkFilename(body.name, result.format))}"`)
        .send(result.buffer);
    } catch (err) {
      next(err);
    }
  });

  // 生产模式：`npm run build` 之后由同一个 Node 进程托管前端产物。
  app.use(express.static(WEB_DIST, { index: false, fallthrough: true }));
  app.get(/^(?!\/api\/).*/, async (req, res, next) => {
    try {
      const index = path.join(WEB_DIST, 'index.html');
      await fs.access(index);
      res.sendFile(index);
    } catch {
      if (req.path === '/' || req.path === '/index.html') {
        res
          .status(200)
          .type('text/plain; charset=utf-8')
          .send('image-clip server 已启动。开发模式请访问 Vite 地址（默认 http://127.0.0.1:5173）；或先执行 npm run build 生成 web/dist。');
        return;
      }
      next();
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `未找到 ${req.method} ${req.path}` } });
  });

  // eslint-disable-next-line no-unused-vars -- express 靠 4 个参数识别错误处理中间件
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.type === 'entity.too.large' ? 413 : 500);
    const code = err.code ?? (status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR');
    const message = status === 413 ? '请求体过大' : err.message || '服务器内部错误';
    if (status >= 500) console.error('[image-clip]', err);
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

/** 统一解析入参：原始二进制 或 JSON{ image } → Buffer + 元信息。 */
function extractInput(req) {
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    const body = parseJsonBody(req);
    const raw = body.image ?? body.dataUrl ?? body.base64 ?? body.buffer;
    if (!raw) throw new InputError('JSON 请求体需要 image 字段（dataURL 或 base64）', 'MISSING_IMAGE');
    return { buffer: toBuffer(raw), body };
  }
  if (!req.body?.length) throw new InputError('请求体为空：请以 image/* 二进制或 JSON dataURL 提交图片', 'MISSING_IMAGE');
  return { buffer: req.body, body: {} };
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const text = req.body?.length ? req.body.toString('utf8') : '{}';
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InputError(`JSON 解析失败：${err.message}`, 'BAD_JSON');
  }
}

async function listSamples() {
  let entries = [];
  try {
    entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const samples = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SAMPLE_EXT.has(ext)) continue;
    const file = path.join(SAMPLES_DIR, entry.name);
    const stat = await fs.stat(file);
    const label = path.basename(entry.name, ext);
    samples.push({
      name: entry.name,
      label,
      ext,
      bytes: stat.size,
      url: `/api/samples/${encodeURIComponent(entry.name)}`,
    });
  }
  return samples.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 阻止 ../ 穿越，只允许读取 samples 目录下的白名单扩展名。 */
function resolveSamplePath(name) {
  const decoded = path.basename(decodeURIComponent(String(name ?? '')));
  const ext = path.extname(decoded).toLowerCase();
  if (!decoded || !SAMPLE_EXT.has(ext)) {
    throw new InputError('示例图片名不合法', 'BAD_SAMPLE_NAME', 400);
  }
  const file = path.join(SAMPLES_DIR, decoded);
  if (path.dirname(file) !== SAMPLES_DIR) throw new InputError('示例图片路径不合法', 'BAD_SAMPLE_PATH', 400);
  return file;
}

function croppedName(name, format) {
  const base = String(name ?? 'image').replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}-cropped.${format === 'jpeg' ? 'jpg' : format}`;
}

function watermarkFilename(name, format) {
  const base = String(name ?? 'image').replace(/\.[^./\\]+$/, '') || 'image';
  return `${base}-watermark-removed.${format === 'jpeg' ? 'jpg' : format}`;
}

/** 水印接口的参数解析：query 与 JSON body.options 都会被读，body 优先。 */
function watermarkOptions(query = {}, body = {}) {
  const raw = { ...stripUndefinedObj(query), ...stripUndefinedObj(body.options ?? {}) };
  const numeric = [
    'sensitivity',
    'dilate',
    'minArea',
    'maxCoverage',
    'alphaFloorAt0',
    'alphaFloorAt100',
    'alphaCeil',
    'alphaConsistency',
    'repeatCoverageFallback',
    'inpaintRadius',
    'inpaintDilate',
    'feather',
    'lamaContext',
    'lamaMaxPatches',
    'quality',
    'alphaHint',
    'textLimitSide',
    'textThreshold',
    'yoloConfidence',
    'yoloIou',
    'yoloMaxBoxes',
    'thresholdAt0',
    'thresholdAt100',
  ];
  const options = {};
  for (const key of numeric) {
    if (raw[key] !== undefined && raw[key] !== '') {
      const value = Number(raw[key]);
      if (Number.isFinite(value)) options[key] = value;
    }
  }
  const booleans = ['requireRepeat', 'integrity', 'textGate', 'textGateRelax', 'yoloGate'];
  for (const key of booleans) {
    if (raw[key] !== undefined && raw[key] !== '') options[key] = toBoolValue(raw[key]);
  }
  if (raw.method) options.method = String(raw.method);
  if (raw.engine) options.engine = String(raw.engine);
  if (raw.polarity) options.polarity = String(raw.polarity);
  if (raw.inpaintMethod) options.inpaintMethod = String(raw.inpaintMethod);
  if (raw.watermarkColor) options.watermarkColor = String(raw.watermarkColor);
  if (raw.format) options.format = String(raw.format);
  if (raw.template) options.templateBuffer = raw.template;
  if (raw.templateRect) options.templateRect = parseRect(raw.templateRect);
  if (raw.region) options.region = parseRect(raw.region);
  return options;
}

/** 'x,y,w,h' 或 {x,y,width,height} 都接受。 */
function parseRect(input) {
  if (!input) return null;
  if (typeof input === 'object') return input;
  const parts = String(input)
    .split(',')
    .map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function stripUndefinedObj(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

/** query 里的布尔值可能是 'true' / '1' / 'false'。 */
function toBoolValue(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`[image-clip] API 已启动: http://${HOST}:${PORT}  (算法 ${ALGORITHM})`);
  });
}

export default createApp;
