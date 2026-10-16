/**
 * 水印**自动识别**（生成掩膜）
 * -------------------------
 * 三条互补的路线，可单独用，也可以 `auto` 组合：
 *
 * 1. `overlay` —— 半透明叠加层检测（最常用）
 *    水印是"低对比度、低饱和、细笔画、常出现在边角或重复出现"的叠加层。
 *    用形态学顶帽/黑帽把「比局部背景更亮/更暗的细结构」提出来，
 *    Otsu 自适应阈值 + 饱和度门限，再按一组水印特征打分筛选连通域。
 *
 * 2. `periodic` —— 平铺/重复水印检测（无需模板）
 *    对高通残差做 DFT，在对数幅度谱里找非低频峰值 → 得到重复周期 (dx,dy)；
 *    再用「位移自相似」找出一致重复且非平坦的像素，即水印笔画。
 *
 * 3. `template` —— 模板匹配（给一张水印图，或从原图框选一块）
 *    多尺度 TM_CCOEFF_NORMED + 非极大值抑制，精度最高，适合固定角标/固定 logo。
 *
 * 所有算法都只依赖 OpenCV 的基础算子（morphologyEx / threshold / dft /
 * matchTemplate / resize），OpenCV.js 为 Apache-2.0 上游项目；
 * 掩膜的清理、连通域过滤、打分逻辑在本仓库的 mask.js 里完成（纯 JS，可单测）。
 */
import {
  connectedComponents,
  coverage as maskCoverage,
  createMask,
  dilate,
  close as maskClose,
  open as maskOpen,
  union,
} from './mask.js';
import { colorCode, createMatScope, matFromRgba, oddSize } from './cv-utils.js';
import { clamp01 } from './color.js';

export const DETECT_METHODS = Object.freeze(['auto', 'overlay', 'periodic', 'template']);

export const DEFAULT_DETECT_OPTIONS = Object.freeze({
  method: 'auto',
  /** 0 = 最严格，100 = 最宽松 */
  sensitivity: 50,
  /** 模板匹配用（RGBA 对象或 {data,width,height}） */
  template: null,
  /** 从原图截取模板用的矩形（与 template 二选一） */
  templateRect: null,
  /** 限定检测区域 */
  region: null,
  /**
   * 掩膜膨胀像素。**默认 0**：半透明水印要做反混合，掩膜必须贴紧真实水印，
   * 多切进来的干净像素会被"反混合"变暗。修补类引擎（opencv/lama）会自己在
   * remove 阶段再扩边，所以这里不需要预设膨胀。
   */
  dilate: 0,
  /** 候选连通域最小面积 */
  minArea: 24,
  /** 候选区域面积上限（占全图比例），超过视为误检。水印通常由许多小块组成，
   *  单个连通域覆盖全图 20% 以上基本可以确定是画面内容（实测插画背景 33%）。 */
  maxCoverage: 0.2,
  /** 灵敏度 → 分数阈值的线性映射区间 */
  thresholdAt0: 0.78,
  thresholdAt100: 0.24,
  /** 最低可接受不透明度（灵敏度低时更严格） */
  alphaFloorAt0: 0.28,
  alphaFloorAt100: 0.04,
  /**
   * 可接受的不透明度上限。水印是**半透明叠加**；一块区域如果 70% 以上都是实的，
   * 那更可能是画面内容（实测：插画里的白色高光 α≈0.8，会被这条挡掉）。
   */
  alphaCeil: 0.7,
  /**
   * 同一张图里被接受的各连通域之间允许的 α 标准差。
   * 一次水印叠加只有一个不透明度（连通域之间应高度一致）：
   * 实测真值水印 0.016，而插画高光/纹理误检是 0.06~0.15。
   * 超过这个阈值就判定"这不像同一次叠加"，整张不报结果。
   */
  alphaConsistency: 0.05,
  /**
   * 是否要求"重复出现"的支持证据（默认开）：
   * 一个真实水印通常是**平铺/多处出现**的，或者面积足够大；
   * 而插画高光、纹理脊线这类误检往往是**一次性的小块**。
   * 实测（蝴蝶-03.webp 水彩插画）：关掉这条会误检 1%（24 个 α≈0.2 的孤立小块），
   * 打开后为 0。需要检测单个角标 logo 时，请用"模板匹配"或直接框选/画笔，
   * 或把这条关掉（requireRepeat: false）后自行挑选。
   */
  requireRepeat: true,
  /** 单个连通域达到该覆盖率时，即使没有重复也认为有支持证据 */
  repeatCoverageFallback: 0.03,
  /**
   * 水印极性：
   *  - 'auto'（默认）先按"亮水印"（白/浅色文字、logo）检测；
   *    只有当亮极性一无所获时，才再试"暗水印"。
   *  - 'bright' / 'dark' 强制指定。
   *
   * 为什么 auto 不做两路合并：暗极性用「闭运算」估背景时，会把**亮结构之间的
   * 间隙**抬亮，从而在 α-map 上产生成片的假阳性（实测间隙 α≈0.24）；
   * 而亮极性用「开运算」估背景是干净的（实测 笔画 α≈0.35 / 间隙 α≈0）。
   * 两路都跑再合并就会把这些鬼影一起带进来，所以改成"先亮后暗"的短路策略。
   */
  polarity: 'auto',
});

export function normalizeDetectOptions(options = {}) {
  const o = { ...DEFAULT_DETECT_OPTIONS, ...(options || {}) };
  const method = DETECT_METHODS.includes(o.method) ? o.method : 'auto';
  return {
    ...o,
    method,
    sensitivity: Math.max(0, Math.min(100, Number(o.sensitivity) || 0)),
    dilate: Math.max(0, Math.min(64, Math.round(Number(o.dilate) || 0))),
    minArea: Math.max(1, Math.round(Number(o.minArea) || 1)),
    maxCoverage: Math.max(0.01, Math.min(1, Number(o.maxCoverage) || DEFAULT_DETECT_OPTIONS.maxCoverage)),
  };
}

function scoreThreshold(opts) {
  const t = opts.sensitivity / 100;
  return opts.thresholdAt0 + (opts.thresholdAt100 - opts.thresholdAt0) * t;
}

/** Sobel 梯度幅值（8U，已缩放到 0..255）——用于判断结构边缘的锐利程度。 */
function sobelMagnitude(cv, scope, gray) {
  const h = gray.rows;
  const w = gray.cols;
  const gx16 = scope.mat(h, w, cv.CV_16SC1);
  const gy16 = scope.mat(h, w, cv.CV_16SC1);
  cv.Sobel(gray, gx16, cv.CV_16S, 1, 0, 3);
  cv.Sobel(gray, gy16, cv.CV_16S, 0, 1, 3);
  const gx = scope.mat(h, w, cv.CV_32F);
  const gy = scope.mat(h, w, cv.CV_32F);
  gx16.convertTo(gx, cv.CV_32F);
  gy16.convertTo(gy, cv.CV_32F);
  const mag = scope.mat(h, w, cv.CV_32F);
  cv.magnitude(gx, gy, mag);
  const out = scope.mat(h, w, cv.CV_8UC1);
  // Sobel 对阶跃边缘的响应约为 4×幅度，这里缩放到 8U 便于统计
  mag.convertTo(out, cv.CV_8UC1, 0.25);
  return out;
}

/**
 * 主入口。
 * @param {object} cv      已初始化的 opencv 模块
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image 直通 RGBA
 * @param {object} options 见 DEFAULT_DETECT_OPTIONS
 */
export function detectWatermark(cv, image, options = {}) {
  const started = Date.now();
  const opts = normalizeDetectOptions(options);
  const scope = createMatScope(cv);
  const diagnostics = { overlay: null, periodic: null, template: null };

  try {
    const rgba = matFromRgba(scope, image);
    const gray = scope.mat(image.height, image.width, cv.CV_8UC1);
    cv.cvtColor(rgba, gray, colorCode(cv, 'RGBA2GRAY'));
    const edge = sobelMagnitude(cv, scope, gray);

    // 透明像素上没有"内容"，不可能存在水印；而且透明边界本身会产生很强的
    // 伪边缘，所以先取出 alpha 当作门限（否则带透明背景的素材会大面积误检，
    // 实测蝴蝶-03.webp 会误检 37%）。直接读 RGBA 的第 4 字节，不依赖 cv 的通道接口。
    const opacity = new Uint8Array(image.width * image.height);
    for (let i = 0, p = 3; i < opacity.length; i += 1, p += 4) opacity[i] = image.data[p];
    const needsAlphaGate = hasTransparentPixels(opacity);
    const alphaGate = (mask) => {
      if (!needsAlphaGate) return mask;
      for (let i = 0; i < mask.data.length; i += 1) {
        if (opacity[i] < 24) mask.data[i] = 0;
      }
      return mask;
    };

    const region = clampRegion(opts.region, image.width, image.height);
    // 只有显式指定 region 时才构造区域掩膜（否则全 0 会把结果全部抹掉）
    const regionMask = region ? createMask(image.width, image.height) : null;
    if (regionMask) fillRect(regionMask, region, 255);

    /**
     * 掩膜式区域限制（比矩形 region 更强）：调用方可以用来把检测**限制在语义上
     * 可能有水印的地方**。例如服务端先用文本检测模型（DBNet）找出图中的文字区域，
     * 再把水印检测限制在这些区域内 —— 这样插画里的非文字内容（例如用户那张图里
     * 20 只蝴蝶的翅膀边缘）根本进不了候选，从结构上消掉"把画面内容当水印"的误检。
     *
     * 尺寸不符时直接忽略（宁可退回无限制，也不静默给出错误结果）。
     */
    const semanticMask =
      opts.regionMaskData && opts.regionMaskWidth === image.width && opts.regionMaskHeight === image.height
        ? { width: opts.regionMaskWidth, height: opts.regionMaskHeight, data: opts.regionMaskData }
        : null;

    const results = [];
    const wantOverlay = opts.method === 'auto' || opts.method === 'overlay';
    const wantPeriodic = opts.method === 'auto' || opts.method === 'periodic';
    const wantTemplate = opts.method === 'template' && (opts.template || opts.templateRect);

    // 级联：overlay（最常见的半透明叠加）优先；只有它一无所获时才试
    // 周期性平铺与模板。这样既快，也避免周期性检测在纹理图上的误检
    // 污染 overlay 已经得出的正确结果。
    if (wantOverlay) {
      const r = detectOverlay(cv, scope, rgba, gray, edge, opacity, opts);
      diagnostics.overlay = r.diagnostics;
      if (r.mask) {
        results.push({ method: 'overlay', ...r });
        if (opts.method === 'auto') return collect(results);
      }
    }
    if (wantPeriodic) {
      const r = detectPeriodic(cv, scope, gray, opts);
      diagnostics.periodic = r.diagnostics;
      if (r.mask) {
        results.push({ method: 'periodic', ...r });
        if (opts.method === 'auto') return collect(results);
      }
    }
    if (wantTemplate) {
      const r = detectTemplate(cv, scope, gray, edge, image, opts);
      diagnostics.template = r.diagnostics;
      if (r.mask) results.push({ method: 'template', ...r });
    }
    return collect(results);

    /** 区域限制 + 透明门限 + 汇总输出。 */
    function collect(entries) {
      for (const r of entries) {
        let m = r.mask;
        if (regionMask) m = intersectWith(m, regionMask);
        if (semanticMask) m = intersectWith(m, semanticMask);
        r.mask = alphaGate(m);
      }
      const usable = entries.filter((r) => r.mask && !isEmptyMask(r.mask));
      if (usable.length === 0) {
        return {
          mask: createMask(image.width, image.height),
          boxes: [],
          usedMethods: [],
          method: opts.method,
          confidence: 0,
          coverage: 0,
          estimatedAlpha: null,
          diagnostics,
          elapsedMs: Date.now() - started,
        };
      }

      // 组合：多方法结果取并集（method 明确指定时通常只有一个来源）
      const combined = usable.reduce(
        (acc, r) => union(acc, r.mask),
        createMask(image.width, image.height),
      );
      let mask = maskClose(maskOpen(combined, 1), 2);
      if (opts.dilate > 0) mask = dilate(mask, opts.dilate);
      mask = filterByArea(mask, Math.max(4, Math.round(opts.minArea / 2)));

      const components = connectedComponents(mask, { minArea: Math.max(4, Math.round(opts.minArea / 2)) });
      const boxes = components.slice(0, 64).map((c) => ({
        x: c.x,
        y: c.y,
      width: c.width,
      height: c.height,
      score: Number(Math.min(1, 0.35 + c.fillRatio * 0.5 + Math.min(0.3, c.area / (image.width * image.height) * 3)).toFixed(4)),
      source: primaryMethod(usable),
    }));

    const best = usable.reduce((a, b) => (b.score > a.score ? b : a));
    const estimatedAlpha =
      usable.find((r) => r.estimatedAlpha !== undefined && r.estimatedAlpha !== null)?.estimatedAlpha ?? null;
    const finalCoverage = maskCoverage(mask);
    // 掩膜为空时不能报"高置信度"（否则界面会出现 confidence=100% + coverage=0% 的自相矛盾结果）
    const confidence = finalCoverage > 0 ? Number(clamp01(best.score).toFixed(4)) : 0;
      return {
        mask,
        boxes: finalCoverage > 0 ? boxes : [],
        usedMethods: finalCoverage > 0 ? usable.map((r) => r.method) : [],
        method: opts.method === 'auto' ? (finalCoverage > 0 ? best.method : 'auto') : opts.method,
        confidence,
        coverage: Number(finalCoverage.toFixed(5)),
        /** 检测阶段顺带估出的水印不透明度，可作为反混合搜索的先验 */
        estimatedAlpha: finalCoverage > 0 && estimatedAlpha !== null ? Number(estimatedAlpha.toFixed(3)) : null,
        diagnostics,
        elapsedMs: Date.now() - started,
      };
    }
  } finally {
    scope.release();
  }
}

function primaryMethod(results) {
  return results.reduce((a, b) => (b.score > a.score ? b : a)).method;
}

// --------------------------------------------------------------- overlay

/**
 * 半透明叠加层检测。
 *
 * 核心是**不透明度图（α-map）**而不是简单的差分：
 * 对每个像素用「比局部背景亮/暗了多少，相对于该处还能亮多少」来估计叠加的不透明度
 *
 *     α ≈ (I − B) / (W − B)      （亮水印，W=255）
 *
 * 水印的判别特征是「**整块区域 α 几乎恒定**」—— 这是全局 Otsu 完全抓不到的：
 * 亮度差会随背景明暗剧烈变化（亮背景处差得少），而 α 不变。
 * 因此这里先算 α-map，再按 α 均值/标准差、饱和度、重复性、面积等特征给连通域打分。
 */
function detectOverlay(cv, scope, rgba, gray, edge, opacity, opts) {
  const w = gray.cols;
  const h = gray.rows;
  const scale = Math.min(w, h);

  // 背景要用**形态学**估计而不是高斯模糊：
  // 模糊的尺度一旦接近水印笔画间距，笔画之间的干净区域就会被"抬高"，
  // 从而在 α-map 上留下负向鬼影（实测会把笔画间隙误检成水印）。
  // 开运算/闭运算用大于笔画宽度的结构元可以干净地"抹掉"细结构，
  // 得到接近真实的低频背景（类似滚动球背景校正）。
  //
  // 尺度选择：min(w,h)/22 对应"笔画宽度 ≤ 约 45px"的水印，覆盖绝大多数文字/细线
  // 水印（1000px 图上约 45px）。**实测刻意不做更粗的尺度**：更大的结构元会把插画里
  // 大面积的柔和区域也抹成"背景"，从而把画面内容误判成水印（蝴蝶-03.webp 会误检 4.3%）。
  // 粗大/大面积水印请走"模板匹配 / 框选区域 / 画笔"这条确定性的路径。
  const kernels = [oddSize(Math.max(15, Math.round(scale / 22)), 15, 121)];
  const backgrounds = kernels.map((k) => {
    const se = scope.track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
    const brightBg = scope.mat(h, w, cv.CV_8UC1);
    const darkBg = scope.mat(h, w, cv.CV_8UC1);
    cv.morphologyEx(gray, brightBg, cv.MORPH_OPEN, se);
    cv.morphologyEx(gray, darkBg, cv.MORPH_CLOSE, se);
    return { kernel: k, bright: brightBg, dark: darkBg };
  });

  const rgb = scope.mat(h, w, cv.CV_8UC3);
  const hsv = scope.mat(h, w, cv.CV_8UC3);
  cv.cvtColor(rgba, rgb, colorCode(cv, 'RGBA2RGB'));
  cv.cvtColor(rgb, hsv, colorCode(cv, 'RGB2HSV'));
  const channels = scope.vector();
  cv.split(hsv, channels);
  const sat = channels.get(1);

  const scoreThresholdValue = scoreThreshold(opts);
  const alphaFloor = opts.alphaFloorAt0 + (opts.alphaFloorAt100 - opts.alphaFloorAt0) * (opts.sensitivity / 100);
  // 饱和度门限：水印多为白/灰，但**叠在彩色内容上**时局部饱和度依然偏高，
  // 因此这里放宽（精度由"重复性支持 + α 一致性聚类"保证，而不是靠饱和度硬切）。
  const satLimit = 40 + scoreThresholdValue * 140;

  const g = gray.data;
  const s = sat.data;

  // ---- 极性先验：用"背景余量"决定先试哪一极 ----------------------------------
  // 亮水印的 α ≈ (I−B)/(255−B)：背景越接近纯白，"还能再亮多少"就越小，α 越欠定
  // （2~3 级压缩噪声就能凑出 α≈0.1~0.2 的假水印）。所以当整张图大面积是近白背景时，
  // 亮极性的结果不可信，应当**优先试暗极性**（灰/黑水印，α ≈ (B−I)/B 在亮背景上很干净）。
  //
  // 实测：豆包角标图（2720×1520，58.8% 像素 >240）——亮极性先试时检出的是白蝴蝶边缘的
  // 噪声（自动检测返回 0%），改成暗极性先试后正确给出 1.89%/64 个候选；
  // 而三张无水印素材在暗极性下仍是 0.000%，平铺水印（中灰背景）依旧由亮极性给出 7.09%。
  const minHeadroom = Math.max(4, Number(opts.minHeadroom) || 32);
  const usableFraction = (() => {
    const bgBright = backgrounds[0].bright.data;
    let usable = 0;
    let opaque = 0;
    for (let i = 0; i < opacity.length; i += 7) {
      if (opacity[i] < 24) continue;
      opaque += 1;
      if (255 - bgBright[i] >= minHeadroom) usable += 1;
    }
    return opaque ? usable / opaque : 1;
  })();
  const preferredPolarity = usableFraction >= 0.5 ? 'bright' : 'dark';

  const candidates = [];
  const polarities =
    opts.polarity === 'auto'
      ? [preferredPolarity, preferredPolarity === 'bright' ? 'dark' : 'bright']
      : [opts.polarity];
  for (const polarity of polarities) {
    const perScale = [];
    for (const bg of backgrounds) {
      const background = polarity === 'bright' ? bg.bright.data : bg.dark.data;

      // α-map：把「与局部背景的亮度差」归一化成「叠加的不透明度」
      const alphaMap = new Uint8Array(w * h);
      for (let i = 0; i < alphaMap.length; i += 1) {
        if (opacity[i] < 24) continue; // 透明处没有内容
        // 余量不足的像素直接判为不可测（见上面的极性先验说明）
        if (polarity === 'bright' ? 255 - background[i] < minHeadroom : background[i] < minHeadroom) continue;
        const diff = polarity === 'bright' ? g[i] - background[i] : background[i] - g[i];
        if (diff <= 0) continue;
        const denom = Math.max(polarity === 'bright' ? 255 - background[i] : background[i], 24);
        alphaMap[i] = Math.min(255, Math.round((diff / denom) * 255));
      }

      const rawMask = createMask(w, h);
      const alphaFloor8 = Math.round(alphaFloor * 255);
      for (let i = 0; i < alphaMap.length; i += 1) {
        if (alphaMap[i] < alphaFloor8) continue;
        if (s[i] > satLimit) continue; // 水印多为白/灰，高饱和多半是画面内容
        rawMask.data[i] = 255;
      }

      // 清理强度：默认 open(1)+close(2) 用来去掉孤立噪点；但在**语义门控**路径上，
      // 区域内已经确认是文字，而降采样后笔画往往只剩 1~2px —— 再做一次开运算会把它们
      // 整体抹掉（实测用户图：门控内只剩 1.4% 的笔画像素，去除时几乎没效果）。
      // 所以门控时只做轻量闭运算（close(1)），不掉笔画。
      const cleaned =
        opts.cleanupLevel === 'light' ? maskClose(rawMask, 1) : maskClose(maskOpen(rawMask, 1), 2);
      const scored = scoreCandidates(
        cleaned,
        { alphaMap, sat: s, grad: edge.data, borderRatio: 0.18 },
        {
          minArea: opts.cleanupLevel === 'light' ? Math.max(4, Math.round(opts.minArea / 4)) : opts.minArea,
          threshold: scoreThresholdValue,
          imageArea: w * h,
          alphaFloor,
          alphaCeil: opts.alphaCeil,
          maxCoverage: opts.maxCoverage,
        },
      );
      perScale.push({ polarity, bgKernel: bg.kernel, ...scored });
    }

    // 同一极性下取"最好"的那个尺度
    const bestForPolarity = perScale.reduce((a, b) => (b.scoreSum > a.scoreSum ? b : a));
    candidates.push(bestForPolarity);
    // auto：亮极性已经有可信结果就不再跑暗极性（避免闭运算背景带来的鬼影）
    if (opts.polarity === 'auto' && bestForPolarity.kept > 0) break;
  }

  const best = candidates.reduce((a, b) => (b.scoreSum > a.scoreSum ? b : a));

  // 一致性判据：同一次水印叠加的不透明度应当高度一致。
  // 各连通域 α 离散度太大 → 判定"这不像同一次叠加"，整张不给出结果。
  const componentAlphas = best.componentAlphas ?? [];
  const alphaMean = componentAlphas.length
    ? componentAlphas.reduce((sum, v) => sum + v, 0) / componentAlphas.length
    : 0;
  const alphaStdAcross = componentAlphas.length
    ? Math.sqrt(componentAlphas.reduce((sum, v) => sum + (v - alphaMean) ** 2, 0) / componentAlphas.length)
    : 0;
  // 一致性已由 scoreCandidates 的 α 聚类判定（incoherent）
  const inconsistent = Boolean(best.incoherent);
  // 重复性支持：至少两个"有分量"的同尺寸实例，或者整体覆盖面积足够大
  const componentCoverage = best.componentCoverage ?? 0;
  const repeatSupport = Boolean(best.meaningfulRepeat) || componentCoverage >= opts.repeatCoverageFallback;
  const lacksRepeat = Boolean(opts.requireRepeat) && !repeatSupport;
  const rejected = inconsistent || lacksRepeat;

  return {
    mask: !rejected && best.mask.data.some((v) => v > 127) ? best.mask : null,
    score: rejected ? 0 : best.scoreSum,
    estimatedAlpha: best.medianAlpha,
    diagnostics: {
      bgKernel: best.bgKernel,
      alphaFloor: Number(alphaFloor.toFixed(3)),
      alphaCeil: opts.alphaCeil,
      satLimit: Number(satLimit.toFixed(1)),
      polarity: best.polarity,
      kept: best.kept,
      rejected: best.rejected,
      medianAlpha: best.medianAlpha === null ? null : Number(best.medianAlpha.toFixed(3)),
      alphaMean: Number(alphaMean.toFixed(3)),
      alphaStdAcross: Number(alphaStdAcross.toFixed(4)),
      consistencyRejected: inconsistent,
      repeatRejected: lacksRepeat,
      meaningfulRepeat: Boolean(best.meaningfulRepeat),
      meaningfulArea: best.meaningfulArea ?? null,
      components: best.components,
      candidates: candidates.map((c) => ({
        polarity: c.polarity,
        bgKernel: c.bgKernel,
        kept: c.kept,
        score: Number(c.scoreSum.toFixed(4)),
        medianAlpha: c.medianAlpha === null ? null : Number(c.medianAlpha.toFixed(3)),
      })),
    },
  };
}

/**
 * 按水印特征给每个连通域打分并筛选：
 *  - **α 恒定**（同一水印不透明度一致）—— 最强的判据，纹理误检的 α 方差会很大
 *  - α 落在合理区间（太浅是噪声，太深多半是实体物体而不是水印）
 *  - 饱和度低（白/灰水印）
 *  - 面积合理、细笔画、靠近边缘
 *  - 同尺寸区域重复出现（平铺水印）
 */
function scoreCandidates(rawMask, stats, { minArea, threshold, imageArea, alphaFloor, alphaCeil, maxCoverage }) {
  const components = connectedComponents(rawMask, { minArea });
  const buckets = new Map();
  for (const c of components) {
    const key = `${Math.round(c.width / 8)}x${Math.round(c.height / 8)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(c);
    buckets.set(key, bucket);
  }

  const kept = [];
  const rejected = [];
  const { width: w, height: h } = rawMask;
  const allAlphas = [];
  const detailed = [];

  for (const c of components) {
    const coverage = c.area / imageArea;
    if (coverage > maxCoverage) {
      rejected.push({ x: c.x, y: c.y, width: c.width, height: c.height, area: c.area, reason: 'coverage' });
      continue;
    }

    const alphas = [];
    let satSum = 0;
    let gradSum = 0;
    for (let y = c.y; y < c.y + c.height; y += 1) {
      for (let x = c.x; x < c.x + c.width; x += 1) {
        const i = y * w + x;
        if (rawMask.data[i] <= 127) continue;
        alphas.push(stats.alphaMap[i] / 255);
        satSum += stats.sat[i];
        gradSum += stats.grad[i];
      }
    }
    if (alphas.length === 0) continue;

    alphas.sort((a, b) => a - b);
    const medianAlpha = alphas[Math.floor(alphas.length / 2)];
    const meanAlpha = alphas.reduce((sum, v) => sum + v, 0) / alphas.length;
    const variance = alphas.reduce((sum, v) => sum + (v - meanAlpha) ** 2, 0) / alphas.length;
    const alphaStd = Math.sqrt(variance);
    const meanSat = satSum / alphas.length;
    const meanGrad = gradSum / alphas.length;

    // α 恒定 → 像水印；纹理/边缘误检的 α 起伏很大
    const uniformScore = 1 - Math.min(1, alphaStd / 0.22);
    // α 落在 0.08..0.7 之间最像半透明水印
    const alphaScore = medianAlpha < 0.05 ? 0 : medianAlpha > 0.92 ? 0.1 : 1 - Math.min(1, Math.abs(medianAlpha - 0.32) / 0.5);
    const satScore = 1 - Math.min(1, meanSat / 170);
    // 边缘锐度：描边/文字是阶跃边缘，背景纹理（正弦条纹之类）是缓变
    const edgeScore = Math.min(1, meanGrad / 24);
    const thinScore = 1 - Math.min(1, c.fillRatio);
    const sizeScore = coverage < 0.00005 ? 0 : 1;
    const borderDistance = Math.min(c.x, c.y, w - (c.x + c.width), h - (c.y + c.height));
    const borderScore = borderDistance < Math.min(w, h) * 0.18 ? 1 : 0.55;
    const repeatBucket = buckets.get(`${Math.round(c.width / 8)}x${Math.round(c.height / 8)}`) ?? [];
    // 重复出现是水印的强特征；只出现一次的区域不能靠它拿分
    // （否则背景纹理的长条脊线会被当成水印）
    const repeatScore = repeatBucket.length >= 3 ? 1 : repeatBucket.length === 2 ? 0.7 : 0.15;
    // 单块面积过大的区域（背景结构）也不该被当成水印
    const spanScore = coverage > 0.12 ? 0.1 : coverage > 0.05 ? 0.6 : 1;

    const score =
      0.20 * Math.max(0, uniformScore) +
      0.18 * Math.max(0, alphaScore) +
      0.12 * satScore +
      0.13 * repeatScore +
      0.10 * edgeScore +
      0.09 * sizeScore +
      0.06 * thinScore +
      0.05 * borderScore +
      0.07 * spanScore;

    const entry = {
      x: c.x,
      y: c.y,
      width: c.width,
      height: c.height,
      area: c.area,
      score: Number(score.toFixed(4)),
      medianAlpha: Number(medianAlpha.toFixed(3)),
      alphaStd: Number(alphaStd.toFixed(3)),
      meanSat: Number(meanSat.toFixed(1)),
      meanGrad: Number(meanGrad.toFixed(1)),
      repeats: repeatBucket.length,
    };
    detailed.push(entry);

    if (score >= threshold && medianAlpha >= alphaFloor && medianAlpha <= alphaCeil) {
      kept.push(entry);
      allAlphas.push(medianAlpha);
    } else {
      const reason =
        score < threshold ? 'score' : medianAlpha < alphaFloor ? 'alphaFloor' : 'alphaCeil';
      rejected.push({ ...entry, reason });
    }
  }

  const medianAlpha = allAlphas.length
    ? allAlphas.slice().sort((a, b) => a - b)[Math.floor(allAlphas.length / 2)]
    : null;

  // ---- α 聚类：一次水印叠加只有一个不透明度，按面积加权的中位数附近聚成一簇，
  //      只保留这一簇（少数离群组件不该否决整张结果，多个不同 α 的水印也以主导簇为准）。
  const clusterTol = 0.08;
  let clustered = kept;
  let incoherent = false;
  if (kept.length > 1 && medianAlpha !== null) {
    const dominant = kept.filter((c) => Math.abs(c.medianAlpha - medianAlpha) <= clusterTol);
    const keptArea = kept.reduce((sum, c) => sum + c.area, 0);
    const dominantArea = dominant.reduce((sum, c) => sum + c.area, 0);
    // 主导簇连一半面积都占不到 → 这些检测彼此矛盾，判定为不可信
    incoherent = dominantArea < keptArea * 0.5;
    clustered = dominant.length > 0 ? dominant : kept;
  }

  const mask = createMask(w, h);
  for (const c of clustered) {
    for (let y = c.y; y < c.y + c.height; y += 1) {
      for (let x = c.x; x < c.x + c.width; x += 1) {
        const i = y * w + x;
        if (rawMask.data[i] > 127) mask.data[i] = 255;
      }
    }
  }

  const componentAlphas = clustered.map((c) => c.medianAlpha);
  const componentCoverage = clustered.reduce((sum, c) => sum + c.area, 0) / imageArea;
  // "有意义的重复"：同尺寸等级里至少出现两次，且这些实例本身不能是小碎点
  // （插画里的装饰性高光往往正好是"很多个几十像素的小亮点"，必须先排除）
  const meaningfulArea = Math.max(minArea, imageArea * MEANINGFUL_REPEAT_RATIO);
  const meaningfulBuckets = new Map();
  for (const c of clustered) {
    if (c.area < meaningfulArea) continue;
    const key = `${Math.round(c.width / 8)}x${Math.round(c.height / 8)}`;
    meaningfulBuckets.set(key, (meaningfulBuckets.get(key) ?? 0) + 1);
  }
  const meaningfulRepeat = [...meaningfulBuckets.values()].some((n) => n >= 2);

  return {
    mask,
    kept: clustered.length,
    dropped: kept.length - clustered.length,
    rejected: rejected.length,
    scoreSum: clustered.reduce((sum, c) => sum + c.score, 0),
    medianAlpha,
    componentAlphas,
    componentCoverage,
    incoherent,
    meaningfulRepeat,
    meaningfulArea,
    components: clustered.slice(0, 24),
  };
}

/** 参与"重复性支持"的最小实例面积占比（相对整图）。 */
const MEANINGFUL_REPEAT_RATIO = 0.0005;

// --------------------------------------------------------------- periodic

function detectPeriodic(cv, scope, gray, opts) {
  const w = gray.cols;
  const h = gray.rows;
  const sigma = Math.max(3, Math.min(w, h) / 40);

  const f32 = scope.mat(h, w, cv.CV_32F);
  gray.convertTo(f32, cv.CV_32F);
  const blurred = scope.mat(h, w, cv.CV_32F);
  cv.GaussianBlur(f32, blurred, new cv.Size(0, 0), sigma, sigma);
  const residual = scope.mat(h, w, cv.CV_32F);
  cv.subtract(f32, blurred, residual);

  // DFT（复数输出）
  const planes = scope.vector();
  planes.push_back(residual);
  planes.push_back(scope.mat(h, w, cv.CV_32F));
  const complex = scope.mat(h, w, cv.CV_32FC2);
  cv.merge(planes, complex);
  cv.dft(complex, complex);

  const outPlanes = scope.vector();
  cv.split(complex, outPlanes);
  const re = outPlanes.get(0);
  const im = outPlanes.get(1);
  const magnitude = scope.mat(h, w, cv.CV_32F);
  cv.magnitude(re, im, magnitude);

  const { peaks } = findSpectrumPeaks(magnitude, w, h, {
    minPeriod: Math.max(16, Math.round(Math.min(w, h) / 12)),
    maxPeriod: Math.max(48, Math.round(Math.min(w, h) / 2)),
  });

  // 残差的标准差（0..255 量纲）用来定"平坦"与"重复"的阈值
  const residualStd = stdOf(residual.data32F);

  const diagnostics = {
    sigma: Number(sigma.toFixed(2)),
    residualStd: Number(residualStd.toFixed(2)),
    peaks: peaks.map((p) => ({ ...p, periodX: Number(p.periodX.toFixed(1)), periodY: Number(p.periodY.toFixed(1)) })),
    tried: [],
  };

  if (peaks.length === 0) return { mask: null, score: 0, diagnostics };

  let best = null;
  for (const peak of peaks.slice(0, 4)) {
    const dx = Math.round(peak.periodX) % w;
    const dy = Math.round(peak.periodY) % h;
    if (dx === 0 && dy === 0) continue;

    // 平移矩阵（CV_32FC1 是 warpAffine 的标准入参类型）
    const M = scope.mat(2, 3, cv.CV_32FC1);
    M.data32F.set([1, 0, dx, 0, 1, dy]);
    const shifted = scope.mat(h, w, cv.CV_32F);
    cv.warpAffine(residual, shifted, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REFLECT);
    const diff = scope.mat(h, w, cv.CV_32F);
    cv.absdiff(residual, shifted, diff);

    const res = residual.data32F;
    const dif = diff.data32F;
    const epsFlat = Math.max(2.5, residualStd * 0.45);
    const epsSame = Math.max(3, residualStd * 0.5);
    const raw = createMask(w, h);
    for (let i = 0; i < raw.data.length; i += 1) {
      const a = Math.abs(res[i]);
      if (a <= epsFlat) continue; // 平坦区域天然"自相似"，不是水印
      if (Math.abs(dif[i]) <= epsSame) raw.data[i] = 255;
    }
    const cleaned = maskClose(maskOpen(raw, 1), 2);
    const cov = maskCoverage(cleaned);
    const comps = connectedComponents(cleaned, { minArea: Math.max(8, opts.minArea) });
    const entry = {
      dx,
      dy,
      coverage: Number(cov.toFixed(4)),
      components: comps.length,
      plausible: false,
    };

    // 重复性得分：位移后差异小的像素占比 × 覆盖率合理性
    let sameCount = 0;
    let flatCount = 0;
    for (let i = 0; i < raw.data.length; i += 1) {
      if (Math.abs(res[i]) <= epsFlat) flatCount += 1;
      if (Math.abs(res[i]) > epsFlat && Math.abs(dif[i]) <= epsSame) sameCount += 1;
    }
    const sameRatio = sameCount / Math.max(1, raw.data.length - flatCount);
    entry.sameRatio = Number(sameRatio.toFixed(3));

    // 严格判据：真正的平铺水印是"位移后高度一致"的少数几块，
    // 而正弦纹理/噪点会产生几百个碎片、且一致率很低（实测 0.25~0.33）。
    entry.plausible =
      sameRatio >= 0.6 && cov >= 0.003 && cov <= 0.3 && comps.length >= 1 && comps.length <= 200;
    const score = sameRatio * (1 - Math.min(1, Math.abs(cov - 0.06) / 0.3)) * 0.9;
    diagnostics.tried.push(entry);
    if (!entry.plausible) continue;
    if (!best || score > best.score) best = { mask: cleaned, score, dx, dy, sameRatio, coverage: cov };
  }

  if (!best) return { mask: null, score: 0, diagnostics };
  diagnostics.bestShift = { dx: best.dx, dy: best.dy, sameRatio: Number(best.sameRatio.toFixed(3)) };
  return { mask: best.mask, score: best.score, diagnostics };
}

/** 在对数幅度谱里找非低频局部峰值，换算成重复周期。 */
function findSpectrumPeaks(magnitude, w, h, { minPeriod, maxPeriod }) {
  const data = magnitude.data32F;
  const logMag = new Float32Array(w * h);
  let mean = 0;
  for (let i = 0; i < logMag.length; i += 1) {
    const v = Math.log1p(data[i]);
    logMag[i] = v;
    mean += v;
  }
  mean /= logMag.length;
  let variance = 0;
  for (let i = 0; i < logMag.length; i += 1) variance += (logMag[i] - mean) ** 2;
  const std = Math.sqrt(variance / logMag.length);

  const cy = Math.floor(h / 2);
  const cx = Math.floor(w / 2);
  const minFreqRadius = 3; // 排除直流与极低频

  const candidates = [];
  for (let v = 0; v < h; v += 1) {
    for (let u = 0; u < w; u += 1) {
      // 只扫上半平面，另一半是共轭对称
      if (v > h / 2) continue;
      const fu = u <= w / 2 ? u : u - w;
      const fv = v <= h / 2 ? v : v - h;
      const radius = Math.hypot(fu, fv);
      if (radius < minFreqRadius) continue;
      const i = v * w + u;
      const value = logMag[i];
      if (value < mean + 1.5 * std) continue;
      // 3x3 局部极大
      let isPeak = true;
      for (let dy = -1; dy <= 1 && isPeak; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const vy = (v + dy + h) % h;
          const ux = (u + dx + w) % w;
          if (logMag[vy * w + ux] > value) {
            isPeak = false;
            break;
          }
        }
      }
      if (!isPeak) continue;
      const periodX = fu === 0 ? Infinity : w / Math.abs(fu);
      const periodY = fv === 0 ? Infinity : h / Math.abs(fv);
      const px = Number.isFinite(periodX) ? periodX : maxPeriod * 4;
      const py = Number.isFinite(periodY) ? periodY : maxPeriod * 4;
      if (px < minPeriod && py < minPeriod) continue;
      if (px > maxPeriod && py > maxPeriod) continue;
      candidates.push({ u, v, value, periodX: px, periodY: py, score: value - mean });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  // 峰值去重：周期太接近的只保留最强的
  const peaks = [];
  for (const c of candidates) {
    if (peaks.some((p) => Math.abs(p.periodX - c.periodX) < 6 && Math.abs(p.periodY - c.periodY) < 6)) continue;
    peaks.push(c);
    if (peaks.length >= 6) break;
  }

  return { peaks, mean, std };
}

/** 一维数组的标准差（用于残差阈值）。 */
function stdOf(array) {
  const n = array.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += array[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i += 1) variance += (array[i] - mean) ** 2;
  return Math.sqrt(variance / n);
}

// --------------------------------------------------------------- template

function detectTemplate(cv, scope, gray, edge, image, opts) {
  const template = resolveTemplate(cv, scope, image, opts);
  if (!template) {
    return { mask: null, score: 0, diagnostics: { error: '缺少模板图：请提供 template（水印图）或 templateRect（在原图上框选）' } };
  }

  const { width: w, height: h } = { width: gray.cols, height: gray.rows };
  const threshold = 0.72 - (opts.sensitivity / 100) * 0.32; // 0.72 → 0.40
  const scales = [0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
  const matches = [];

  // 在**边缘幅值**上做匹配：水印的结构信息都在边缘上，而平滑背景/渐变的
  // 边缘响应很弱，能显著压低误匹配（纯色模板没有边缘，退回灰度 + 平方差）。
  const flatTemplate = stdOf(template.edge.data) < 2;
  const sourceImage = flatTemplate ? gray : edge;
  const methodFlag = flatTemplate ? cv.TM_SQDIFF_NORMED : cv.TM_CCOEFF_NORMED;

  for (const scale of scales) {
    const tw = Math.round(template.width * scale);
    const th = Math.round(template.height * scale);
    if (tw < 6 || th < 6 || tw >= w || th >= h) continue;

    const tplSource = flatTemplate ? template.gray : template.edge;
    const tplScaled = scope.mat(th, tw, cv.CV_8UC1);
    cv.resize(tplSource, tplScaled, new cv.Size(tw, th), 0, 0, scale < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);

    const result = scope.mat(h - th + 1, w - tw + 1, cv.CV_32F);
    cv.matchTemplate(sourceImage, tplScaled, result, methodFlag);

    // 注意：CV_32F 的 Mat 必须用 data32F（opencv.js 的 .data 永远是字节视图）
    const data = result.data32F;
    const rw = result.cols;
    const rh = result.rows;
    for (let y = 0; y < rh; y += 1) {
      for (let x = 0; x < rw; x += 1) {
        const raw = data[y * rw + x];
        if (raw < threshold) continue;
        // OpenCV 的归一化相关在"窗口内几乎无变化"时是退化的（平滑渐变背景的
        // 梯度幅值近似常数 → 分母趋零 → 到处都能拿高分），所以这里自己复核一遍：
        // 要求候选窗口与模板都具备足够方差，并用零均值 NCC 重新打分。
        const value = verifyTemplateMatch(gray, edge, y, x, tw, th, template, flatTemplate);
        if (value < threshold) continue;
        // 3x3 局部极大
        let isPeak = true;
        for (let dy = -2; dy <= 2 && isPeak; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= rh || xx >= rw) continue;
            if (data[yy * rw + xx] > value) {
              isPeak = false;
              break;
            }
          }
        }
        if (isPeak) matches.push({ x, y, width: tw, height: th, score: value, scale });
      }
    }
  }

  // 全局非极大值抑制 + 相对阈值裁剪：
  // 平滑背景上会有一大串"勉强及格"的匹配，只保留接近最佳分数的那一批。
  matches.sort((a, b) => b.score - a.score);
  const bestScore = matches[0]?.score ?? 0;
  const relativeCut = Math.max(threshold, bestScore * 0.92);
  const kept = [];
  for (const m of matches) {
    if (m.score < relativeCut) break;
    if (kept.some((k) => iou(k, m) > 0.15)) continue;
    kept.push(m);
    if (kept.length >= 32) break;
  }

  const mask = createMask(w, h);
  for (const m of kept) {
    const tw = m.width;
    const th = m.height;
    const tplAlpha = template.alpha;
    for (let y = 0; y < th; y += 1) {
      for (let x = 0; x < tw; x += 1) {
        // 模板带 alpha 时按模板形状（而不是整块矩形）落掩膜，避免多切掉背景
        const inside = tplAlpha
          ? tplAlpha[
              Math.min(template.height - 1, Math.floor(y / m.scale)) * template.width +
                Math.min(template.width - 1, Math.floor(x / m.scale))
            ] > 40
          : true;
        if (!inside) continue;
        const px = m.x + x;
        const py = m.y + y;
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        mask.data[py * w + px] = 255;
      }
    }
  }

  if (kept.length === 0) {
    return {
      mask: null,
      score: 0,
      diagnostics: { matches: 0, threshold: Number(threshold.toFixed(3)), scales: scales.length, flatTemplate },
    };
  }

  const topScore = kept[0].score;
  return {
    mask,
    score: Math.min(1, topScore * Math.min(1, kept.length / 2)),
    diagnostics: {
      matches: kept.length,
      threshold: Number(threshold.toFixed(3)),
      bestScore: Number(bestScore.toFixed(4)),
      flatTemplate,
      scales: [...new Set(kept.map((k) => k.scale))],
      boxes: kept.slice(0, 24),
    },
  };
}

/** 模板来源：外部模板图（带 alpha）或从原图框选的矩形。 */
function resolveTemplate(cv, scope, image, opts) {
  if (opts.template?.data) {
    const t = opts.template;
    const mat = scope.mat(t.height, t.width, cv.CV_8UC4);
    mat.data.set(t.data instanceof Uint8ClampedArray ? t.data : Uint8ClampedArray.from(t.data));
    const gray = scope.mat(t.height, t.width, cv.CV_8UC1);
    cv.cvtColor(mat, gray, colorCode(cv, 'RGBA2GRAY'));
    const hasAlpha = hasTransparency(t);
    const alpha = hasAlpha ? extractAlpha(new Uint8ClampedArray(mat.data), t.width, t.height) : null;
    return { width: t.width, height: t.height, gray, edge: sobelMagnitude(cv, scope, gray), alpha };
  }
  if (opts.templateRect) {
    const rect = clampRect(opts.templateRect, image.width, image.height);
    if (!rect) return null;
    const sub = scope.mat(rect.height, rect.width, cv.CV_8UC4);
    for (let y = 0; y < rect.height; y += 1) {
      const srcStart = ((rect.y + y) * image.width + rect.x) * 4;
      sub.data.set(image.data.subarray(srcStart, srcStart + rect.width * 4), y * rect.width * 4);
    }
    const gray = scope.mat(rect.height, rect.width, cv.CV_8UC1);
    cv.cvtColor(sub, gray, colorCode(cv, 'RGBA2GRAY'));
    return { width: rect.width, height: rect.height, gray, edge: sobelMagnitude(cv, scope, gray), alpha: null };
  }
  return null;
}

function hasTransparency(template) {
  const { data } = template;
  for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) return true;
  return false;
}

/** alpha 通道里是否存在透明像素（决定要不要做透明门限）。 */
function hasTransparentPixels(alpha) {
  for (let i = 0; i < alpha.length; i += 13) {
    if (alpha[i] < 24) return true;
  }
  return false;
}

function extractAlpha(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 3; i < out.length; i += 1, p += 4) out[i] = rgba[p];
  return out;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const unionArea = a.width * a.height + b.width * b.height - inter;
  return unionArea > 0 ? inter / unionArea : 0;
}

/**
 * 自己复核一遍模板匹配：把候选窗口按比例采样到模板尺寸，计算零均值归一化
 * 相关（NCC），并要求**两边都有足够的方差**。
 * 这一步专门解决 OpenCV 归一化相关在平滑背景上的退化（分母趋零）。
 */
function verifyTemplateMatch(gray, edge, y, x, tw, th, template, flatTemplate) {
  const source = flatTemplate ? gray.data : edge.data;
  const tplSource = flatTemplate ? template.gray.data : template.edge.data;
  const srcW = gray.cols;
  const tplW = template.width;
  const tplH = template.height;
  // 模板较大时抽稀采样，精度够用且更快
  const step = tw * th > 4096 ? 2 : 1;

  const sampleA = [];
  const sampleB = [];
  for (let ty = 0; ty < th; ty += step) {
    const sy = y + ty;
    const tty = Math.min(tplH - 1, Math.floor((ty / th) * tplH));
    for (let tx = 0; tx < tw; tx += step) {
      const sx = x + tx;
      const ttx = Math.min(tplW - 1, Math.floor((tx / tw) * tplW));
      sampleA.push(source[sy * srcW + sx]);
      sampleB.push(tplSource[tty * tplW + ttx]);
    }
  }
  const n = sampleA.length;
  if (n === 0) return 0;
  const meanA = sampleA.reduce((s, v) => s + v, 0) / n;
  const meanB = sampleB.reduce((s, v) => s + v, 0) / n;

  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < n; i += 1) {
    const a = sampleA[i] - meanA;
    const b = sampleB[i] - meanB;
    varA += a * a;
    varB += b * b;
    cov += a * b;
  }
  // 任一方几乎无变化 → 判定为不可信（这正是平滑背景误匹配的根因）
  if (Math.sqrt(varA / n) < 3 || Math.sqrt(varB / n) < 3) return 0;
  return Math.max(0, Math.min(1, cov / Math.sqrt(varA * varB)));
}

// --------------------------------------------------------------- 工具

function clampRegion(region, width, height) {
  if (!region) return null;
  const x = Math.max(0, Math.min(width - 1, Math.round(Number(region.x) || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.round(Number(region.y) || 0)));
  const w = Math.max(1, Math.min(width - x, Math.round(Number(region.width) || width)));
  const h = Math.max(1, Math.min(height - y, Math.round(Number(region.height) || height)));
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

function clampRect(rect, width, height) {
  return clampRegion(rect, width, height);
}

function fillRect(mask, rect, value) {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) mask.data[y * mask.width + x] = value;
  }
}

function intersectWith(a, b) {
  const out = createMask(a.width, a.height);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = Math.min(a.data[i], b.data[i]);
  return out;
}

function isEmptyMask(mask) {
  for (let i = 0; i < mask.data.length; i += 1) if (mask.data[i] > 127) return false;
  return true;
}

function filterByArea(mask, minArea) {
  const comps = connectedComponents(mask, { minArea });
  const out = createMask(mask.width, mask.height);
  for (const c of comps) {
    for (let y = c.y; y < c.y + c.height; y += 1) {
      for (let x = c.x; x < c.x + c.width; x += 1) {
        const i = y * mask.width + x;
        if (mask.data[i] > 127) out.data[i] = 255;
      }
    }
  }
  return out;
}
