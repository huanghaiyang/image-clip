/**
 * 水印识别与去除 · 服务端编排
 * --------------------------
 * 三个去除引擎（都能被 UI 单独选择，`auto` 会按水印性质自动挑）：
 *
 * 1. `unblend` —— 半透明反混合。信息还在，只是被 α·W+(1−α)·B 混合过，
 *    估出 α/W 就能几乎无损还原（实测掩膜区 PSNR 19→58dB）。**半透明水印首选。**
 * 2. `opencv`  —— Telea/NS 修补。快（毫秒级）、无需模型，适合细笔画、不透明水印。
 * 3. `lama`    —— LaMa 深度修补（198MB ONNX，逐 512 patch 推理）。复杂背景/大面积最好。
 *
 * 检测一律走 shared/watermark/detect.js（与浏览器端同一份源码），
 * 掩膜、指标、反混合走 shared/watermark/*（纯 JS，可单测）。
 */
import sharp from 'sharp';

import {
  DEFAULT_DETECT_OPTIONS,
  colorCode,
  createMask,
  intersect as intersectMask,
  union as unionMask,
  countMask,
  createMatScope,
  detectWatermark,
  dilate as dilateMask,
  erode as erodeMask,
  estimateWatermarkParams,
  feather as featherMask,
  isUnblendPlausible,
  matFromMask,
  matFromRgba,
  parseWatermarkColor,
  unblendImage,
} from '../../shared/watermark/index.js';
import { InputError, decodeRgba, readMetadata, toBuffer } from './imaging.js';
import { getOpenCv } from './opencv.js';
import { lamaInpaint, lamaStatus } from './lama.js';
import { removeByBackground } from './bgsub.js';
import { detectTextRegions, textModelStatus } from './text-detect.js';
import { detectWatermarkRegions, wmModelStatus } from './wm-model.js';

export const REMOVE_ENGINES = Object.freeze(['auto', 'unblend', 'bgsub', 'opencv', 'lama']);

export const DEFAULT_REMOVE_OPTIONS = Object.freeze({
  engine: 'auto',
  /** OpenCV 修补半径 */
  inpaintRadius: 4,
  /**
   * 修补类引擎（opencv/lama）在掩膜外再扩的边。
   * 水印边缘有抗锯齿残留，稍微多修一圈可以避免留下"描边"；
   * 反混合引擎不使用这个扩展（多修会把干净像素变暗）。
   */
  inpaintDilate: 2,
  /** 贴回时的羽化半径（消除接缝） */
  feather: 2,
  /** LaMa 的上下文扩张比例 */
  lamaContext: 0.25,
  /** LaMa 单次请求最大推理窗口数 */
  lamaMaxPatches: 32,
  /** 反混合的水印颜色 */
  watermarkColor: 'auto',
  /** 仅用 OpenCV Telea 还是 NS */
  inpaintMethod: 'telea',
  /** 输出编码 */
  format: 'png',
  quality: 92,
  /** 是否在响应里带上自检信息 */
  integrity: true,
});

/** 把检测参数从 options 里择出来（检测相关键在 detect.js 有默认值）。 */
function detectOptionsFrom(options = {}) {
  const keys = Object.keys(DEFAULT_DETECT_OPTIONS);
  const picked = {};
  for (const key of keys) if (options[key] !== undefined) picked[key] = options[key];
  return picked;
}

function removeOptionsFrom(options = {}) {
  return { ...DEFAULT_REMOVE_OPTIONS, ...(options || {}) };
}

/**
 * 模板参数可能是 dataURL/base64（来自 HTTP），也可能已经是 RGBA 对象。
 * 这里统一解码成检测层要的 {width,height,data} 格式。
 */
async function resolveTemplateOption(options) {
  const source = options.templateBuffer ?? options.template;
  if (!source) return options;
  if (source && typeof source === 'object' && source.data) return options; // 已经是 RGBA
  if (typeof source !== 'string') {
    throw new InputError('template 需要是 dataURL / base64 字符串，或 {width,height,data} 对象', 'BAD_TEMPLATE');
  }
  const buffer = toBuffer(source);
  const { data, info } = await sharp(buffer)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    ...options,
    template: { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
  };
}

/**
 * 大于该边长时，**检测**先降采样再跑，掩膜最后放大回原分辨率。
 *
 * 为什么要这么做：2720×1520 的 JPEG 里，白底上的压缩噪声会在 α-map 上产生上千个
 * 碎片——实测单极性耗时 38s，而且碎片把"各连通域 α 一致"这条判据彻底搅乱
 * （真水印被淹没在噪声里）。降采样相当于一次低通：噪声被抹平、笔画 α 反而更一致，
 * 耗时也回到 1~3s。水印文字本身足够大（缩到 1400px 仍有几十像素高），不会因此漏检。
 *
 * 只对长边 > 1400 的图生效，所以小图（含全部回归用例）的检测结果完全不变。
 */
const DETECT_MAX_EDGE = 1400;

/**
 * 区域提议（语义模型门控）的默认值 —— **默认全部关闭**。
 *
 * 也就是说：默认的检测是**纯统计**路径（α-map + 形态学背景 + 周期/模板级联），
 * 不会调用任何模型。文本门控 / 水印框门控都要显式请求：
 *   · method=model（文本模型）/ method=yolo（水印框模型）
 *   · 或 textGate=1 / yoloGate=1（与 method=auto 组合，可两个一起用以取并集）
 * 模型文件不存在时，这些开关会被忽略并退回纯统计路径（可回退，行为与从前一致）。
 */
export const DEFAULT_GATE_OPTIONS = Object.freeze({
  textGate: false,
  yoloGate: false,
  textGateRelax: true,
  textRecover: true,
  textLimitSide: 1600,
  textThreshold: 0.25,
  yoloConfidence: 0.35,
  yoloIou: 0.45,
  yoloMaxBoxes: 24,
});

/**
 * 文本区域门控（"模型给区域、本地给像素"的第一段）。
 *
 * 为什么要它：纯统计检测没有"水印"概念。实测用户那张 20 只蝴蝶的图，亮极性把浅色
 * 蝴蝶读成 α≈0.48~0.55 的叠加物（掩膜 99.6% 是内容），周期性路径更把蝴蝶网格判成
 * 平铺水印（22%）。而**绝大多数可见水印是文字**，所以先用一个 4.5MB 的文本检测模型
 * （PP-OCRv4 det / DBNet，纯 ONNX、离线）把"图里哪儿是文字"找出来：
 *   - 非文字内容（蝴蝶翅膀、纹理、高光）**根本进不了候选** —— 这是结构性的修复；
 *   - 文字区域只当**种子**：DBNet 对这种低对比空心字只能覆盖文字框的 17%~34%
 *     （实测），所以把种子外扩一段，再在扩后的框内用**更低的 α 下限**重跑 α-map，
 *     由本地算法补全整段文字的像素与不透明度。
 *   - 模型缺失/关闭时完全走原来的路径（行为不变）。
 */
async function buildTextGate(image, options) {
  const status = textModelStatus();
  if (!status.available) return { used: false, reason: status.reason, gate: null };
  const regions = await detectTextRegions(image, {
    limitSide: options.textLimitSide,
    threshold: options.textThreshold,
  });
  if (!regions.coverage) {
    // 请求了语义门控、但图里**没有文字** —— 这时诚实的答案是"没有文字水印"，
    // 而不是退回无门控检测：退回会把之前那些画面内容误检（蝴蝶网格被判成平铺水印）
    // 又放回来，正好抵消掉门控的意义。
    return {
      used: true,
      source: 'text',
      empty: true,
      reason: '图中未检测到文字区域：不认为存在文字水印（可在界面关掉语义门控改走统计检测）',
      gate: null,
      regions: 0,
      coverage: 0,
    };
  }
  // 种子外扩：
  //  1) 统一留白 margin：让 α-map 能把笔画边缘补全；
  //  2) **沿文字行方向再外扩 0.6×框宽**：文本检测器常常只在一段文字的局部着火
  //     （实测用户图的「豆包AI生成」只找到右半段「AI生成」），而水印通常是**一整行**字，
  //     所以按行方向拉长是对的；垂直方向不拉，避免把上下相邻的内容卷进来。
  const margin = Math.max(24, Math.round(Math.min(image.width, image.height) * 0.025));
  const gate = createMask(image.width, image.height);
  const rects = [];
  for (const box of regions.boxes) {
    const extendX = Math.round(box.width * 0.6);
    const x0 = Math.max(0, box.x - margin - extendX);
    const y0 = Math.max(0, box.y - margin);
    const x1 = Math.min(image.width, box.x + box.width + margin + extendX);
    const y1 = Math.min(image.height, box.y + box.height + margin);
    rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) gate.data[y * image.width + x] = 255;
    }
  }
  return {
    used: true,
    source: 'text',
    reason: null,
    gate,
    rects,
    regions: regions.boxes.length,
    coverage: regions.coverage,
    boxes: regions.boxes.slice(0, 12),
    elapsedMs: regions.elapsedMs,
  };
}

/**
 * 水印框门控（第二个区域提议源，YOLOv5 水印检测器）。
 *
 * 与文本门控互补：文本模型覆盖"文字水印"，这个模型覆盖**图形类/非文字水印**
 * （logo、图标、印章式标记）。它直接给出水印的边界框，所以不需要像文本那样
 * 沿行外扩，只要给一点留白让 α-map 能补全边缘。
 *
 * 权重来自 Eugeoter/yolov5-watermark-detection（AGPL-3.0，见 THIRD_PARTY_NOTICES），
 * 构建期用 scripts/export-wm-yolov5.py 导出 ONNX，运行期同样只依赖 onnxruntime。
 */
async function buildYoloGate(image, options) {
  const status = wmModelStatus();
  if (!status.available) return { used: false, source: 'yolo', reason: status.reason, gate: null };
  const detected = await detectWatermarkRegions(image, {
    confidence: options.yoloConfidence,
    iou: options.yoloIou,
    maxBoxes: options.yoloMaxBoxes,
  });
  if (!detected.boxes.length) {
    return {
      used: true,
      source: 'yolo',
      empty: true,
      reason: '水印框模型未框出任何区域：不认为存在水印',
      gate: null,
      regions: 0,
      coverage: 0,
      elapsedMs: detected.elapsedMs,
    };
  }
  const margin = Math.max(16, Math.round(Math.min(image.width, image.height) * 0.008));
  const gate = createMask(image.width, image.height);
  const rects = [];
  for (const box of detected.boxes) {
    const x0 = Math.max(0, box.x - margin);
    const y0 = Math.max(0, box.y - margin);
    const x1 = Math.min(image.width, box.x + box.width + margin);
    const y1 = Math.min(image.height, box.y + box.height + margin);
    rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) gate.data[y * image.width + x] = 255;
    }
  }
  return {
    used: true,
    source: 'yolo',
    reason: null,
    gate,
    rects,
    regions: detected.boxes.length,
    coverage: countMask(gate) / (image.width * image.height),
    boxes: detected.boxes.slice(0, 12),
    elapsedMs: detected.elapsedMs,
  };
}

/**
 * 区域提议调度：按请求选择文本门控 / 水印框门控 / 两者并集。
 *
 * 语义（都很重要，踩过坑）：
 *  - **没有任何提议源可用（未安装/出错）** → 返回 used:false，让检测回退到纯统计路径。
 *    这正是验收里的"模型未安装时行为与现在完全一致"。
 *  - **有提议源跑通了但一个区域都没给出** → empty：直接判"没有水印"，
 *    而不是回退统计检测（回退会把画面内容的误检放回来，抵消门控的意义）。
 *  - **可回退**：显式要"模型"但只装了 YOLO → 用 YOLO 顶上并在 reason 里说明。
 */
async function buildRegionGate(image, options, { wantsText, wantsYolo, allowFallback }) {
  const textStatus = textModelStatus();
  const yoloStatus = wmModelStatus();
  const notes = [];
  let wantText = wantsText;
  let wantYolo = wantsYolo;

  if (allowFallback && wantText && !textStatus.available && yoloStatus.available) {
    wantText = false;
    wantYolo = true;
    notes.push('文本检测模型未安装，已回退到水印框模型');
  }

  const sources = [];
  if (wantText) {
    if (!textStatus.available) notes.push(textStatus.reason);
    else {
      try {
        sources.push(await buildTextGate(image, options));
      } catch (err) {
        notes.push(`文本检测失败：${err.message}`);
      }
    }
  }
  if (wantYolo) {
    if (!yoloStatus.available) notes.push(yoloStatus.reason);
    else {
      try {
        sources.push(await buildYoloGate(image, options));
      } catch (err) {
        notes.push(`水印框模型失败：${err.message}`);
      }
    }
  }

  const ran = sources.filter((s) => s.used);
  const usable = ran.filter((s) => s.gate);
  if (!usable.length) {
    if (!ran.length) {
      // 一个提议源都没跑起来 → 交给调用方回退统计检测
      return { used: false, gate: null, sources: [], reason: notes.join('；') || '区域提议不可用' };
    }
    return {
      used: true,
      empty: true,
      gate: null,
      sources: ran.map((s) => s.source),
      reason: [...notes, ...ran.map((s) => s.reason).filter(Boolean)].join('；') || '未找到候选区域：不认为存在水印',
    };
  }

  const gate = createMask(image.width, image.height);
  const rects = [];
  let coverage = 0;
  let regions = 0;
  let boxes = [];
  let elapsedMs = 0;
  for (const s of usable) {
    for (let i = 0; i < gate.data.length; i += 1) {
      if (s.gate.data[i] > 127) gate.data[i] = 255;
    }
    rects.push(...(s.rects ?? []));
    coverage += s.coverage ?? 0;
    regions += s.regions ?? 0;
    boxes = boxes.concat(s.boxes ?? []);
    elapsedMs += s.elapsedMs ?? 0;
  }
  return {
    used: true,
    reason: notes.join('；') || null,
    gate,
    rects,
    regions,
    coverage: countMask(gate) / (image.width * image.height),
    boxes: boxes.slice(0, 12),
    elapsedMs,
    sources: usable.map((s) => s.source),
  };
}

/** 检测：图片字节 → { mask, boxes, ... } */
export async function analyzeWatermark(buffer, options = {}) {
  const resolved = await resolveTemplateOption(options);
  // method: 'model' = "先用离线语义模型提议区域，再在区域内跑常规级联"。
  // 这是检出方法层面的开关；等价于 textGate 开启 + method auto，但语义更清楚。
  const useTextMethod = resolved.method === 'model';
  const useYoloMethod = resolved.method === 'yolo';
  const isModelMethod = useTextMethod || useYoloMethod;
  const opts = detectOptionsFrom({ ...resolved, method: isModelMethod ? 'auto' : resolved.method });
  const cv = await getOpenCv();
  const { data, width, height } = await decodeRgba(buffer);
  const longEdge = Math.max(width, height);

  // 区域提议（"模型给区域、本地给像素"的第一段）。
  // 变量名沿用 textGate 是历史原因：它现在可能来自文本模型、水印框模型或两者并集，
  // 对外用 sources 字段说明实际来源（'text' / 'yolo'）。
  const image = { width, height, data: new Uint8ClampedArray(data) };
  let textGate = { used: false, reason: null, gate: null };
  const wantsText = useTextMethod || resolved.textGate === true;
  const wantsYolo = useYoloMethod || resolved.yoloGate === true;
  const regionGateRequested = (wantsText || wantsYolo) && !resolved.template && !resolved.templateRect;
  if (regionGateRequested) {
    try {
      textGate = await buildRegionGate(image, resolved, { wantsText, wantsYolo, allowFallback: isModelMethod });
    } catch (err) {
      // 模型侧出错（文件损坏、onnxruntime 异常）不应让整个请求失败，退回统计检测并说明原因
      textGate = { used: false, reason: `区域提议失败（${err.message}），退回无门控检测`, gate: null };
    }
  }
  if (textGate.empty) {
    // 请求了门控但图中无文字 → 直接判"没有文字水印"（见 buildTextGate 里的说明）
    return {
      mask: createMask(width, height),
      boxes: [],
      usedMethods: [],
      method: resolved.method,
      confidence: 0,
      coverage: 0,
      estimatedAlpha: null,
      diagnostics: { gate: textGate.reason },
      elapsedMs: 0,
      width,
      height,
      textGate: {
        used: true,
        reason: textGate.reason,
        sources: textGate.sources ?? [],
        regions: 0,
        coverage: 0,
        boxes: [],
        elapsedMs: textGate.elapsedMs ?? null,
      },
    };
  }
  const gatedOpts = { ...opts };
  /**
   * 门控掩膜必须与"检测实际运行的那张图"同尺寸。
   * 大图会先降采样再检测（DETECT_MAX_EDGE），所以这里按目标尺寸**块状降采样**：
   * 小块内只要有一个门控像素就置位（保守方向，宁可多给一点区域也不漏水印）。
   * 踩过的坑：直接把原尺寸门控传进去，尺寸校验不通过 → 门控被安全地忽略 → 门控形同虚设。
   */
  const gateFor = (w, h) => {
    if (!textGate.gate) return null;
    if (w === width && h === height) return textGate.gate.data;
    const out = new Uint8Array(w * h);
    const stepX = width / w;
    const stepY = height / h;
    for (let y = 0; y < h; y += 1) {
      const y0 = Math.floor(y * stepY);
      const y1 = Math.min(height, Math.max(y0 + 1, Math.ceil((y + 1) * stepY)));
      for (let x = 0; x < w; x += 1) {
        const x0 = Math.floor(x * stepX);
        const x1 = Math.min(width, Math.max(x0 + 1, Math.ceil((x + 1) * stepX)));
        let on = false;
        for (let yy = y0; yy < y1 && !on; yy += 1) {
          const row = yy * width;
          for (let xx = x0; xx < x1; xx += 1) {
            if (textGate.gate.data[row + xx] > 127) {
              on = true;
              break;
            }
          }
        }
        if (on) out[y * w + x] = 255;
      }
    }
    return out;
  };
  if (textGate.gate) {
    // 语义上已确认"这里是文字"，可以在框内放宽 α 下限去捞极淡水印（默认灵敏度提高 30）。
    //
    // 注意：**不要**在这里顺手改成轻量清理（cleanupLevel:'light'）。试过了，虽然能把
    // 门控内的笔画像素从 1.4% 提到 17.3%，但代价是 α 一致性聚类被大量碎点搅坏：
    // 实测平铺水印样例直接掉到 0%、用户图在低灵敏度下归零。召回要在"已确认的水印
    // 区域内"单独做一遍恢复（见 README §6.6 的后续计划），而不是改全局清理强度。
    if (resolved.textGateRelax !== false) {
      gatedOpts.sensitivity = Math.min(100, (opts.sensitivity ?? 55) + 30);
    }
  }

  const attach = (result) => ({
    ...result,
    width,
    height,
    textGate: {
      used: textGate.used,
      reason: textGate.reason,
      sources: textGate.sources ?? [],
      regions: textGate.regions ?? 0,
      coverage: textGate.coverage ?? 0,
      boxes: textGate.boxes ?? [],
      elapsedMs: textGate.elapsedMs ?? null,
    },
  });

  /**
   * 门控内的**召回恢复**（第二遍）。
   *
   * 第一遍走的是常规判据（支持性、α 一致性、默认清理强度），精度高但召回低：
   * 实测用户图只覆盖文字框的 1.4% —— 检出是对的，却清不干净。
   * 所以第一遍确认"这里确实有水印"之后，在**它自己的掩膜外扩一圈**的区域内再跑一遍：
   *   - 降低 α 下限（sensitivity 95 → 下限≈0.03）去捞极淡笔画；
   *   - 轻量清理（close(1)，不掉 1~2px 的细笔画）；
   *   - 关掉支持性判据（区域已被第一遍验证过，不需要再证明"重复出现/贴角"）；
   * 结果与第一遍取并集，并且**始终与语义门控求交**（不会溢出到文字区域之外）。
   *
   * 为什么不能直接把上面这些放宽用在第一遍：那会把 α 一致性聚类搅坏 ——
   * 实测平铺水印样例会直接掉到 0%（见 gatedOpts 处的注释）。
   */
  const recoverInsideGate = (detectImage, first) => {
    if (!textGate.gate || !first || !first.mask || !(first.coverage > 0)) return first;
    if (resolved.textRecover === false) return first;
    const margin = Math.max(12, Math.round(Math.min(detectImage.width, detectImage.height) * 0.02));
    const gateMask = {
      width: detectImage.width,
      height: detectImage.height,
      data: gateFor(detectImage.width, detectImage.height),
    };
    if (!gateMask.data) return first;

    /**
     * 恢复区域 = **包含第一遍命中像素的整个文本框**（不是种子周围那一小圈）。
     *
     * 为什么：文本检测器常常只在一段文字的局部着火（实测用户图只找到「AI生成」，
     * 而水印是整行「豆包AI生成」）。只扩种子周围 30px 的话，「豆包」永远进不来；
     * 而文本框本身来自语义模型，是"这里有一行字"的直接证据，整框都在门控之内，
     * 因此用它当恢复区域既能把整行捞回来，又不会越出文字区域。
     */
    const region = createMask(detectImage.width, detectImage.height);
    const scaleToDetect = detectImage.width / width;
    for (const rect of textGate.rects ?? []) {
      // 该文本框是否与第一遍的命中像素相交
      let hit = false;
      const rx0 = Math.max(0, Math.floor(rect.x * scaleToDetect));
      const ry0 = Math.max(0, Math.floor(rect.y * scaleToDetect));
      const rx1 = Math.min(detectImage.width, Math.ceil((rect.x + rect.width) * scaleToDetect));
      const ry1 = Math.min(detectImage.height, Math.ceil((rect.y + rect.height) * scaleToDetect));
      for (let y = ry0; y < ry1 && !hit; y += 1) {
        for (let x = rx0; x < rx1; x += 1) {
          if (first.mask.data[y * detectImage.width + x] > 127) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) continue;
      for (let y = ry0; y < ry1; y += 1) {
        for (let x = rx0; x < rx1; x += 1) region.data[y * detectImage.width + x] = 255;
      }
    }
    // 文本框之外，再给种子周围留一圈（不依赖文本框也能兜住零散笔画）
    const seedRegion = intersectMask(dilateMask(first.mask, margin), gateMask);
    const recovery = intersectMask(unionMask(region, seedRegion), gateMask);
    if (!countMask(recovery)) return first;

    const second = detectWatermark(cv, detectImage, {
      ...gatedOpts,
      cleanupLevel: 'light',
      sensitivity: 95,
      requireRepeat: false,
      maxCoverage: 0.9,
      regionMaskData: recovery.data,
      regionMaskWidth: recovery.width,
      regionMaskHeight: recovery.height,
    });
    const merged = intersectMask(unionMask(first.mask, second.mask), gateMask);
    const mergedCoverage = countMask(merged) / (detectImage.width * detectImage.height);
    return {
      ...first,
      mask: merged,
      coverage: mergedCoverage,
      recovered: { coverage: second.coverage, maskPixels: countMask(second.mask) },
    };
  };

  if (longEdge <= DETECT_MAX_EDGE) {
    return attach(recoverInsideGate(image, detectWatermark(cv, image, gatedOpts)));
  }

  const scale = DETECT_MAX_EDGE / longEdge;
  const smallW = Math.max(1, Math.round(width * scale));
  const smallH = Math.max(1, Math.round(height * scale));
  const { data: smallData } = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .resize(smallW, smallH, { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const smallGate = gateFor(smallW, smallH);
  const optsSmall = smallGate
    ? { ...gatedOpts, regionMaskData: smallGate, regionMaskWidth: smallW, regionMaskHeight: smallH }
    : gatedOpts;
  const smallImage = { width: smallW, height: smallH, data: new Uint8ClampedArray(smallData) };
  // 恢复这一遍必须在**与检测同分辨率**的图上做（否则掩膜/区域的坐标体系不一致）
  const small = recoverInsideGate(smallImage, detectWatermark(cv, smallImage, optsSmall));

  // 掩膜放回原尺寸；顺带 +1px 膨胀，补偿降采样把细笔画边界磨掉的半个像素
  const bigMask = createMask(width, height);
  const inv = 1 / scale;
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(smallH - 1, Math.floor(y * scale));
    for (let x = 0; x < width; x += 1) {
      if (small.mask.data[sy * smallW + Math.min(smallW - 1, Math.floor(x * scale))] > 127) {
        bigMask.data[y * width + x] = 255;
      }
    }
  }
  const boxes = (small.boxes ?? []).map((b) => ({
    x: Math.round(b.x * inv),
    y: Math.round(b.y * inv),
    width: Math.max(1, Math.round(b.width * inv)),
    height: Math.max(1, Math.round(b.height * inv)),
    score: b.score,
    source: b.source,
  }));

  return attach({
    ...small,
    mask: dilateMask(bigMask, 1),
    boxes,
    downscaled: { detectWidth: smallW, detectHeight: smallH, scale: Number(scale.toFixed(4)) },
  });
}

/** 掩膜 → 灰度 PNG（UI 显示与回传都用它）。 */
export async function maskToPng(mask) {
  return sharp(Buffer.from(mask.data), { raw: { width: mask.width, height: mask.height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** 掩膜 → dataURL（接口回包用）。 */
export async function maskToDataUrl(mask) {
  const png = await maskToPng(mask);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * 解析客户端回传的掩膜：支持灰度 PNG dataURL / base64 / RLE。
 * 尺寸与图片不一致时用最近邻缩放对齐（画笔编辑后一般是一致的）。
 */
export async function decodeMaskInput(input, width, height) {
  if (!input) return null;

  if (typeof input === 'object' && Array.isArray(input.runs)) {
    const data = new Uint8Array(input.width * input.height);
    let i = 0;
    for (let r = 0; r < input.runs.length; r += 2) {
      const on = input.runs[r];
      const len = input.runs[r + 1];
      if (on) data.fill(255, i, Math.min(data.length, i + len));
      i += len;
    }
    const mask = { width: input.width, height: input.height, data };
    return mask.width === width && mask.height === height ? mask : await resizeMask(mask, width, height);
  }

  const buffer = toBuffer(input);
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const mask = { width: info.width, height: info.height, data: new Uint8Array(data) };
  return mask.width === width && mask.height === height ? mask : await resizeMask(mask, width, height);
}

async function resizeMask(mask, width, height) {
  const { data } = await sharp(Buffer.from(mask.data), {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .resize(width, height, { kernel: 'nearest' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width, height, data: new Uint8Array(data) };
}

/** 统计掩膜外的像素被改动了多少（完整性自检：应为 0）。 */
function changedOutsideMask(before, after, mask) {
  let changed = 0;
  for (let i = 0, p = 0; i < mask.data.length; i += 1, p += 4) {
    if (mask.data[i] > 0) continue;
    if (
      before.data[p] !== after.data[p] ||
      before.data[p + 1] !== after.data[p + 1] ||
      before.data[p + 2] !== after.data[p + 2]
    ) {
      changed += 1;
    }
  }
  return changed;
}

/** OpenCV Telea / NS 修补 + 羽化贴回。 */
async function inpaintWithOpenCv(cv, image, mask, { inpaintRadius, feather, inpaintMethod }) {
  const scope = createMatScope(cv);
  try {
    const src = matFromRgba(scope, image);
    const rgb = scope.mat(image.height, image.width, cv.CV_8UC3);
    cv.cvtColor(src, rgb, colorCode(cv, 'RGBA2RGB'));
    const maskMat = matFromMask(scope, mask);
    const dst = scope.mat(image.height, image.width, cv.CV_8UC3);
    const flag = inpaintMethod === 'ns' ? cv.INPAINT_NS : cv.INPAINT_TELEA;
    cv.inpaint(rgb, maskMat, dst, Math.max(1, Math.round(inpaintRadius)), flag);

    const patched = scope.mat(image.height, image.width, cv.CV_8UC4);
    cv.cvtColor(dst, patched, colorCode(cv, 'RGB2RGBA'));

    const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
    const alpha = feather > 0 ? featherMask(mask, feather) : mask;
    for (let i = 0, p = 0; i < mask.data.length; i += 1, p += 4) {
      const a = alpha.data[i] / 255;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        out.data[p + c] = image.data[p + c] * (1 - a) + patched.data[p + c] * a;
      }
    }
    return out;
  } finally {
    scope.release();
  }
}

/**
 * 估计反混合参数。
 *
 * 前端做过羽化（或掩膜本身带抗锯齿边）时，掩膜边界上混着"只被覆盖了一部分"的
 * 像素，会把边界能量判据带偏——实测同一个水印：紧掩膜 α=0.553/置信度 0.46，
 * 经 2px 羽化后置信度掉到阈值以下，于是被误判成"不能反混合"而改用慢得多的
 * LaMa 修补（13.4s vs 1.7s）。因此在"原掩膜"和"向内腐蚀 2px 的掩膜"上各估一次，
 * 取置信度更高的结果。
 */
function estimateUnblendParams(image, mask, options) {
  const base = {
    watermarkColor:
      options.watermarkColor && options.watermarkColor !== 'auto'
        ? options.watermarkColor
        : options.polarity === 'bright'
          ? 'white'
          : options.polarity === 'dark'
            ? 'black'
            : 'auto',
    alphaHint: options.alphaHint ?? null,
    preferHint: Boolean(options.preferAlphaHint),
  };
  let best = estimateWatermarkParams(image, mask, base);
  // 笔画很细时腐蚀会把掩膜整个吃掉，此时边界采样为空 → energy=Infinity/confidence=NaN，
  // 所以只有"腐蚀后仍保留 ≥30% 面积"才用腐蚀结果，并且拒绝非有限值。
  const eroded = erodeMask(mask, 2);
  if (countMask(eroded) >= countMask(mask) * 0.3) {
    const candidate = estimateWatermarkParams(image, eroded, base);
    if (Number.isFinite(candidate.confidence) && candidate.confidence > best.confidence) best = candidate;
  }
  return best;
}

/** 反混合：估计 (α, W) 后解出背景。 */
function removeByUnblend(image, mask, options) {
  // 检测阶段估 α 时用的模型是"亮水印 W=255"或"暗水印 W=0"，
  // 所以极性已知时水印颜色不是自由参数，必须固定成对应的端点色，
  // 否则会出现 (α, W) 退化解（例如 α=0.57/W=#c0c0c0 与 α=0.55/W=#ffffff 混淆）。
  const params = estimateUnblendParams(image, mask, options);
  const output = unblendImage(image, mask, params);
  return { output, params };
}

/**
 * 掩膜紧邻一圈里"平坦底色"像素的占比（用来判断水印底下是底色还是内容）。
 *
 * 取掩膜向外 2~6px 的一圈（不含掩膜本身），统计灰度**接近纯白或纯黑**（≥235 / ≤20）的比例：
 *  - 占比高 → 水印主要压在平坦底色上，底色可以直接观测 → 用背景替代；
 *  - 占比低 → 压在照片/插画内容上 → 靠 (α, W) 反混合。
 *
 * 为什么不用中位数：用户那张图的水印有一部分压在蝴蝶翅膀上，环像素中位数被拉到 211
 * （25 分位 179 / 75 分位 234），单看中位数会误判成"内容"；而看占比是 ——
 * 用户图约 45% 的环像素是纯白底，平铺水印那张只有约 0%（整段挤在 120~161）。
 */
function ringFlatFraction(image, mask) {
  const { width: w, height: h } = image;
  const inner = dilateMask(mask, 2);
  const outer = dilateMask(mask, 6);
  let flat = 0;
  let total = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (outer.data[i] <= 127 || inner.data[i] > 127) continue;
      const p = i * 4;
      const luma = image.data[p] * 0.299 + image.data[p + 1] * 0.587 + image.data[p + 2] * 0.114;
      total += 1;
      if (luma >= 235 || luma <= 20) flat += 1;
    }
  }
  return total ? flat / total : null;
}

/**
 * 自动选择引擎：
 *  - 半透明水印 → unblend（反推 (α, W)）；但若水印压在**平坦底色**上（底色近乎纯白/纯黑），
 *    底色本身可以直接观测，用 bgsub（形态学背景替代）更稳，不依赖 α 估计
 *    —— 实测用户那张白底浅灰角标：反混合取 α=0.187 时水印只是变淡，
 *    换成背景替代后文字基本清除；
 *  - 估不出可信 (α, W) → 装了 LaMa 就用 lama，否则 opencv 修补。
 */
function chooseEngine(image, mask, options) {
  const requested = options.engine;
  const unblendParams = estimateUnblendParams(image, mask, options);
  const hint = Number(options.alphaHint);
  // 检测阶段估出的 α 来自大量相互一致的像素，本身就是"这是半透明叠加"的独立证据；
  // 掩膜不完整时边界能量判据会偏弱，所以两条证据取"或"。
  const hintPlausible = Number.isFinite(hint) && hint >= 0.06 && hint <= 0.9;
  const plausible = isUnblendPlausible(unblendParams) || hintPlausible;
  if (requested !== 'auto') return { engine: requested, unblendParams, reason: '显式指定' };
  if (plausible) {
    const flatFraction = ringFlatFraction(image, mask);
    if (flatFraction !== null && flatFraction >= 0.15) {
      return {
        engine: 'bgsub',
        unblendParams,
        reason: `水印主要压在平坦底色上（邻域纯色占比 ${(flatFraction * 100).toFixed(0)}%）：用形态学背景直接替换，不依赖 α 估计`,
      };
    }
    return {
      engine: 'unblend',
      unblendParams,
      reason: `半透明水印（检测 α≈${Number.isFinite(hint) ? hint.toFixed(2) : '—'}，反混合取 α=${unblendParams.alpha}，置信度 ${unblendParams.confidence}）：按 B=(I−αW)/(1−α) 还原`,
    };
  }
  const status = lamaStatus();
  if (status.available) {
    return { engine: 'lama', unblendParams, reason: '未能估出可信的不透明度，改用 LaMa 深度修补' };
  }
  return { engine: 'opencv', unblendParams, reason: '未安装 LaMa 模型，回退 OpenCV 修补' };
}

/**
 * 去除：图片字节 + （可选）掩膜 → 处理后的图片。
 * options 见 DEFAULT_REMOVE_OPTIONS；未提供掩膜时先自动检测。
 */
export async function removeWatermark(buffer, inputOptions = {}) {
  const started = Date.now();
  const options = await resolveTemplateOption(inputOptions);
  const opts = removeOptionsFrom(options);
  const meta = await readMetadata(buffer);
  const { data, width, height } = await decodeRgba(buffer);
  const image = { width, height, data };

  let mask = await decodeMaskInput(opts.mask, width, height);
  let detection = null;
  let alphaHint = Number.isFinite(Number(opts.alphaHint)) ? Number(opts.alphaHint) : null;
  if (!mask) {
    const detected = await analyzeWatermark(buffer, options);
    mask = detected.mask;
    alphaHint = detected.estimatedAlpha ?? alphaHint;
    detection = {
      method: detected.method,
      usedMethods: detected.usedMethods,
      confidence: detected.confidence,
      coverage: detected.coverage,
      estimatedAlpha: detected.estimatedAlpha ?? null,
      polarity: detected.diagnostics?.overlay?.polarity ?? null,
      alphaStdAcross: detected.diagnostics?.overlay?.alphaStdAcross ?? null,
      preferAlphaHint: Number.isFinite(detected.diagnostics?.overlay?.alphaStdAcross)
        ? detected.diagnostics.overlay.alphaStdAcross <= 0.06
        : false,
      boxes: detected.boxes?.slice(0, 24) ?? [],
    };
  }

  let coverage = 0;
  for (let i = 0; i < mask.data.length; i += 1) if (mask.data[i] > 127) coverage += 1;
  coverage /= mask.width * mask.height;
  if (coverage <= 0) {
    throw new InputError('掩膜为空：没有需要去除的水印区域', 'EMPTY_MASK', 422);
  }

  const preferAlphaHint = Boolean(detection?.preferAlphaHint);
  const selection = chooseEngine(image, mask, {
    ...opts,
    alphaHint,
    preferAlphaHint,
    polarity: detection?.polarity ?? opts.polarity ?? null,
  });
  let output = image;
  let patches = 0;
  let usedEngine = selection.engine;
  /** 实际被允许改动的区域：反混合用紧掩膜，修补引擎用外扩后的掩膜 */
  let effectiveMask = mask;
  let lamaOutputScale = null;

  if (selection.engine === 'unblend') {
    // 反混合必须用**贴紧**的掩膜：把干净像素也算进来会让它们被算暗
    const result = removeByUnblend(image, mask, {
      ...opts,
      alphaHint,
      preferAlphaHint,
      polarity: detection?.polarity ?? opts.polarity ?? null,
    });
    output = result.output;
  } else {
    // 修补类引擎：掩膜略微外扩，避免抗锯齿边缘残留一圈"描边"
    const inpaintMask = opts.inpaintDilate > 0 ? dilateMask(mask, opts.inpaintDilate) : mask;
    effectiveMask = inpaintMask;
    if (selection.engine === 'lama') {
      try {
        const result = await lamaInpaint(image, inpaintMask, {
          context: opts.lamaContext,
          maxPatches: opts.lamaMaxPatches,
        });
        output = result.image;
        patches = result.patches;
        lamaOutputScale = result.outputScale ?? null;
      } catch (err) {
        // LaMa 失败（模型缺失/窗口过多）时明确回退，而不是直接失败
        usedEngine = 'opencv';
        selection.reason = `LaMa 不可用（${err.message}），回退 OpenCV 修补`;
        const cv = await getOpenCv();
        output = await inpaintWithOpenCv(cv, image, inpaintMask, opts);
      }
    } else {
      const cv = await getOpenCv();
      output = await inpaintWithOpenCv(cv, image, inpaintMask, opts);
    }
  }

  const format = String(opts.format ?? 'png').toLowerCase();
  const encoded = await encodeOutput(output, format, opts.quality, meta);

  return {
    buffer: encoded.buffer,
    mime: encoded.mime,
    format: encoded.format,
    engine: usedEngine,
    requestedEngine: opts.engine,
    reason: selection.reason,
    alpha: selection.unblendParams?.alpha ?? null,
    watermarkColor:
      usedEngine === 'unblend' && selection.unblendParams
        ? `#${selection.unblendParams.color.map((c) => c.toString(16).padStart(2, '0')).join('')}`
        : parseWatermarkColor(opts.watermarkColor)
          ? opts.watermarkColor
          : null,
    alphaConfidence: selection.unblendParams?.confidence ?? null,
    coverage: Number(coverage.toFixed(5)),
    patches,
    lamaOutputScale,
    detection,
    maskPng: await maskToPng(mask),
    source: { ...meta, width, height, bytes: buffer.length },
    integrity: opts.integrity ? { changedOutsideMask: changedOutsideMask(image, output, effectiveMask) } : undefined,
    elapsedMs: Date.now() - started,
  };
}

async function encodeOutput(image, format, quality, meta) {
  const raw = {
    raw: { width: image.width, height: image.height, channels: 4 },
  };
  const pipeline = sharp(Buffer.from(image.data), raw);
  const q = Math.max(1, Math.min(100, Math.round(Number(quality) || 92)));

  switch (format) {
    case 'webp':
      return { buffer: await pipeline.webp({ quality: q }).toBuffer(), mime: 'image/webp', format: 'webp' };
    case 'jpeg':
    case 'jpg':
      return {
        buffer: await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: q }).toBuffer(),
        mime: 'image/jpeg',
        format: 'jpeg',
      };
    case 'avif':
      return { buffer: await pipeline.avif({ quality: q }).toBuffer(), mime: 'image/avif', format: 'avif' };
    case 'source': {
      const sourceFormat = String(meta.format ?? 'png').toLowerCase();
      if (['png', 'webp', 'jpeg', 'avif'].includes(sourceFormat)) {
        return encodeOutput(image, sourceFormat, quality, meta);
      }
      break;
    }
    default:
      break;
  }
  return { buffer: await pipeline.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png', format: 'png' };
}

/** 掩膜转成紧凑 RLE（接口同时给 dataUrl 与 rle，前端可自选）。 */
export function maskToRle(mask) {
  const runs = [];
  let prev = mask.data[0] > 127 ? 1 : 0;
  let count = 0;
  for (const v of mask.data) {
    const bit = v > 127 ? 1 : 0;
    if (bit === prev) count += 1;
    else {
      runs.push(prev, count);
      prev = bit;
      count = 1;
    }
  }
  runs.push(prev, count);
  return { width: mask.width, height: mask.height, runs };
}
