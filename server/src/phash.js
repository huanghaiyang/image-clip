/**
 * 图片感知指纹（dHash 64 位 + 色度/明度直方图）
 * ------------------------------------------------
 * 「智能识图 / 找相似」用的描述子，只用像素、不依赖模型：
 *
 *  - **结构**：灰度缩到 9×8，比较每行相邻像素明暗 → 64 位 dHash。对缩放/再压缩不敏感。
 *  - **颜色**：缩到 64×64，按 YCbCr 的色度 (Cb,Cr) 做 8×8 直方图 + 8 档明度直方图。
 *    透明像素按 alpha 跳过，并按 alpha·色度加权 —— 这样「深色背景 + 主体」和「透明底抠图」
 *    之间比较的是主体颜色，而不是背景色。
 *  - **构图**：覆盖率（不透明像素比例）与宽高比。
 *
 * 只靠结构哈希时，居中构图的蝴蝶和居中构图的花会被误判成相似（两者轮廓都是“中间一坨”），
 * 加入颜色后蓝蝴蝶 vs 绿/红花差异立刻拉开。相似度由 `signatureSimilarity()` 加权得出：
 *   0.55 × 结构 + 0.35 × 颜色 + 0.05 × 宽高比 + 0.05 × 覆盖率
 *
 * 透明边裁剪（trim）在采样前做，保证同一张图加透明留边、白底留边后仍然几乎一致。
 * 服务端用 sharp 解码，单张约 15~25ms。
 */

export const HASH_BITS = 64;
export const SIGNATURE_VERSION = 2;
const SAMPLE = 8;
const SAMPLE_WIDTH = SAMPLE + 1;
const PIXEL_SIZE = 64;
const CHROMA_BINS = 64; // 8 × 8 (Cb, Cr)
const LUMA_BINS = 8;

/** 判定为「同一个/近似同一张」的汉明距离阈值（64 位里差 ≤ 6 位，约 91% 结构相似）。 */
export const NEAR_DUPLICATE_DISTANCE = 6;

/** 相似度权重：结构、颜色、宽高比、覆盖率。 */
export const SIMILARITY_WEIGHTS = { structure: 0.55, color: 0.35, aspect: 0.05, coverage: 0.05 };

// ------------------------------------------------------------------ 采样

/** 把图片缩成 64×64 RGBA（先按 alpha / 纯色边裁掉均匀边框）。 */
async function samplePixels(sharp, buffer) {
  const build = (trim) => {
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate();
    if (trim) pipeline = pipeline.trim({ threshold: 1 });
    return pipeline.ensureAlpha().resize(PIXEL_SIZE, PIXEL_SIZE, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  };
  try {
    return (await build(true)).data;
  } catch {
    // 整张图都是纯色时 trim 会失败（没有可裁的内容），退回不裁的版本
    return (await build(false)).data;
  }
}

/** 从 64×64 RGBA 求 dHash：先按 alpha 压到黑底算灰度，再面积平均缩到 9×8。 */
function dHashFromPixels(data) {
  const gray = new Float64Array(PIXEL_SIZE * PIXEL_SIZE);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const alpha = data[i + 3] / 255;
    gray[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * alpha;
  }

  // 9×8 网格：每个格子覆盖 64/9 ≈ 7.1 列、64/8 = 8 行，按面积加权平均
  const small = new Float64Array(SAMPLE_WIDTH * SAMPLE);
  const colWidth = PIXEL_SIZE / SAMPLE_WIDTH;
  const rowHeight = PIXEL_SIZE / SAMPLE;
  for (let y = 0; y < SAMPLE; y += 1) {
    const y0 = y * rowHeight;
    const y1 = y0 + rowHeight;
    for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
      const x0 = x * colWidth;
      const x1 = x0 + colWidth;
      let sum = 0;
      let area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py += 1) {
        const wy = Math.min(y1, py + 1) - Math.max(y0, py);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px += 1) {
          const wx = Math.min(x1, px + 1) - Math.max(x0, px);
          const weight = wx * wy;
          if (weight <= 0) continue;
          sum += gray[py * PIXEL_SIZE + px] * weight;
          area += weight;
        }
      }
      small[y * SAMPLE_WIDTH + x] = area > 0 ? sum / area : 0;
    }
  }

  let bits = 0n;
  for (let y = 0; y < SAMPLE; y += 1) {
    for (let x = 0; x < SAMPLE; x += 1) {
      const left = small[y * SAMPLE_WIDTH + x];
      const right = small[y * SAMPLE_WIDTH + x + 1];
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(HASH_BITS / 4, '0');
}

/** 从 64×64 RGBA 求色度 / 明度直方图与覆盖率。 */
function histogramFromPixels(data) {
  const chroma = new Float64Array(CHROMA_BINS);
  const luma = new Float64Array(LUMA_BINS);
  let opaque = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += 1;
    const alpha = data[i + 3] / 255;
    if (alpha < 0.13) continue;
    opaque += 1;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 0.5;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 0.5;
    const chromaAmount = Math.hypot(cb - 0.5, cr - 0.5) * 2; // 0 ~ ~1.4
    const binX = Math.min(7, Math.max(0, Math.floor(cb * 8)));
    const binY = Math.min(7, Math.max(0, Math.floor(cr * 8)));
    // 灰/白/黑几乎无色度 → 只留很小的权重，避免背景色主导颜色比较
    chroma[binX * 8 + binY] += alpha * (0.04 + chromaAmount);
    luma[Math.min(7, Math.max(0, Math.floor(y * 8)))] += alpha;
  }
  return {
    chroma: normalize(chroma),
    luma: normalize(luma),
    coverage: opaque / Math.max(1, total),
  };
}

function normalize(values) {
  let sum = 0;
  for (const value of values) sum += value;
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = sum > 0 ? values[i] / sum : 0;
  return out;
}

// ------------------------------------------------------------------ 指纹 API

/**
 * 计算一张图片的完整指纹。
 * @param {Function} sharp sharp 模块（调用方复用，避免重复动态 import）
 * @param {Buffer} buffer 图片字节
 * @returns {Promise<{hash:string, chroma:number[], luma:number[], coverage:number, aspect:number, width:number, height:number}>}
 */
export async function computeSignature(sharp, buffer) {
  const pixels = await samplePixels(sharp, buffer);
  const meta = await sharp(buffer).metadata().catch(() => ({}));
  const width = Number(meta?.width) || 0;
  const height = Number(meta?.height) || 0;
  const { chroma, luma, coverage } = histogramFromPixels(pixels);
  return {
    hash: dHashFromPixels(pixels),
    chroma,
    luma,
    coverage,
    aspect: height > 0 ? width / height : 1,
    width,
    height,
  };
}

/** 单独计算 dHash（保留给测试与只需要结构的场景）。 */
export async function computeDHash(sharp, buffer) {
  const pixels = await samplePixels(sharp, buffer);
  const meta = await sharp(buffer).metadata().catch(() => ({}));
  return {
    hash: dHashFromPixels(pixels),
    width: Number(meta?.width) || 0,
    height: Number(meta?.height) || 0,
  };
}

/** 16 位十六进制指纹（大小写不敏感）。 */
export function isValidHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value);
}

/** 索引里的一条指纹是否完整（旧版只有 hash 的条目会被判为过期，自动重算）。 */
export function isValidSignature(value) {
  return Boolean(
    value &&
    isValidHash(value.hash) &&
    Array.isArray(value.chroma) &&
    value.chroma.length === CHROMA_BINS &&
    Array.isArray(value.luma) &&
    value.luma.length === LUMA_BINS &&
    Number.isFinite(Number(value.aspect)) &&
    Number(value.aspect) > 0 &&
    Number.isFinite(Number(value.coverage)),
  );
}

/** 两个指纹的汉明距离（0~64）；任一非法时返回 null。 */
export function hammingDistance(a, b) {
  if (!isValidHash(a) || !isValidHash(b)) return null;
  let diff = BigInt('0x' + a) ^ BigInt('0x' + b);
  let distance = 0;
  while (diff) {
    distance += Number(diff & 1n);
    diff >>= 1n;
  }
  return distance;
}

function intersection(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.min(a[i], b[i]);
  return sum;
}

/**
 * 两个指纹的相似度（0~1，1 = 完全一致），并给出各维度分项，便于前端解释。
 * @returns {{score:number, structure:number, color:number, chroma:number, luma:number, aspect:number, coverage:number, distance:number}}
 */
export function signatureSimilarity(a, b) {
  if (!isValidSignature(a) || !isValidSignature(b)) return null;
  const distance = hammingDistance(a.hash, b.hash);
  if (distance == null) return null;
  const structure = 1 - distance / HASH_BITS;
  const chroma = intersection(a.chroma, b.chroma);
  const luma = intersection(a.luma, b.luma);
  const color = chroma * 0.85 + luma * 0.15;
  const aspect = Math.min(a.aspect, b.aspect) / Math.max(a.aspect, b.aspect);
  const coverage = 1 - Math.abs(Number(a.coverage) - Number(b.coverage));
  const score =
    SIMILARITY_WEIGHTS.structure * structure +
    SIMILARITY_WEIGHTS.color * color +
    SIMILARITY_WEIGHTS.aspect * aspect +
    SIMILARITY_WEIGHTS.coverage * coverage;
  return {
    score: Number(Math.max(0, Math.min(1, score)).toFixed(4)),
    structure: Number(structure.toFixed(4)),
    color: Number(color.toFixed(4)),
    chroma: Number(chroma.toFixed(4)),
    luma: Number(luma.toFixed(4)),
    aspect: Number(aspect.toFixed(4)),
    coverage: Number(coverage.toFixed(4)),
    distance,
  };
}

/** 结构相似度 0~1（只要 dHash 的场景）。 */
export function similarityScore(a, b) {
  const distance = hammingDistance(a, b);
  if (distance == null) return null;
  return 1 - distance / HASH_BITS;
}
