/**
 * 3D LUT 调色 —— 纯算法，浏览器与 Node 共用
 * -------------------------------------------
 * 为什么是 LUT：PS 的曲线 / 色阶 / HSL / 白平衡本质都是「每个通道的一条查表曲线」，
 * 把它们编译成一张 N³ 的查找表之后，预览只需要一次三线性采样，
 * 不需要逐像素跑 6 个公式。33³ = 35,937 个格子，编译一次 < 5ms。
 *
 * 数据布局：data[((b*N + g)*N + r)*3 + c]，即 r 变化最快 —— 与 .cube 规范一致。
 */

export const LUT_SIZE = 33;

/** 恒等 LUT。 */
export function identityLut(size = LUT_SIZE) {
  const n = Math.max(2, Math.round(size));
  const data = new Float32Array(n * n * n * 3);
  let i = 0;
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        data[i++] = r / (n - 1);
        data[i++] = g / (n - 1);
        data[i++] = b / (n - 1);
      }
    }
  }
  return { size: n, data };
}

export const DEFAULT_ADJUST = {
  enabled: false,
  exposure: 0, // -100~100 → ±2 档
  contrast: 0, // -100~100
  saturation: 0, // -100~100
  temperature: 0, // -100~100 蓝→黄
  tint: 0, // -100~100 绿→洋红
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  /** 每条曲线：{ rgb:[[x,y]...], r:[[...]], g:[[...]], b:[[...]] }，坐标 0~1 */
  curves: { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
};

export function normalizeAdjust(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULT_ADJUST };
  for (const key of ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows', 'whites', 'blacks']) {
    const value = Number(source[key]);
    out[key] = Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) : 0;
  }
  out.enabled = Boolean(source.enabled);
  out.curves = { ...DEFAULT_ADJUST.curves, ...(source.curves ?? {}) };
  return out;
}

/** 曲线上采样：控制点按 x 升序，两点之间线性插值（和 PS 的线性段一致）。 */
export function sampleCurve(points, t) {
  const list = Array.isArray(points) && points.length >= 2 ? points : [[0, 0], [1, 1]];
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  for (let i = 1; i < list.length; i += 1) {
    const [x0, y0] = list[i - 1];
    const [x1, y1] = list[i];
    if (x <= x1 || i === list.length - 1) {
      if (x1 <= x0) return y1;
      const k = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * Math.max(0, Math.min(1, k));
    }
  }
  return x;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(v) {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
}

/** 单像素调色：所有参数在 [0,1] 的浮点空间里算，最后再夹一次。 */
function shade(r, g, b, adj) {
  let rr = r;
  let gg = g;
  let bb = b;

  // 曝光按档位：+1EV = 亮度乘 2
  const ev = adj.exposure / 100 * 2;
  const gain = 2 ** ev;
  rr *= gain;
  gg *= gain;
  bb *= gain;

  // 色温 / 色调
  const t = adj.temperature / 100;
  const ti = adj.tint / 100;
  rr += t * 0.12;
  bb -= t * 0.12;
  gg += ti * 0.08;

  // 对比度：围绕 0.5 中灰线性拉伸
  const k = 1 + adj.contrast / 100;
  rr = (rr - 0.5) * k + 0.5;
  gg = (gg - 0.5) * k + 0.5;
  bb = (bb - 0.5) * k + 0.5;

  // 饱和度：向亮度靠拢 / 远离
  const luma = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
  const sat = 1 + adj.saturation / 100;
  rr = luma + (rr - luma) * sat;
  gg = luma + (gg - luma) * sat;
  bb = luma + (bb - luma) * sat;

  // 高光 / 阴影：按亮度加权，避免把中间调整片拉亮
  const l = clamp01(0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
  const hi = adj.highlights / 100 * 0.25 * smoothstep((l - 0.45) / 0.55);
  const sh = adj.shadows / 100 * 0.25 * smoothstep((0.55 - l) / 0.55);
  rr += hi + sh;
  gg += hi + sh;
  bb += hi + sh;

  // 白场 / 黑场：等价于色阶里的输入端点，做线性重映射
  const bp = adj.blacks / 100 * 0.25;
  const wp = 1 - adj.whites / 100 * 0.25;
  const span = Math.max(0.02, wp - bp);
  rr = (rr - bp) / span;
  gg = (gg - bp) / span;
  bb = (bb - bp) / span;

  rr = clamp01(rr);
  gg = clamp01(gg);
  bb = clamp01(bb);

  // 曲线：先 RGB 复合曲线，再各通道独立曲线
  rr = sampleCurve(adj.curves.rgb, rr);
  gg = sampleCurve(adj.curves.rgb, gg);
  bb = sampleCurve(adj.curves.rgb, bb);
  rr = sampleCurve(adj.curves.r, rr);
  gg = sampleCurve(adj.curves.g, gg);
  bb = sampleCurve(adj.curves.b, bb);

  return [clamp01(rr), clamp01(gg), clamp01(bb)];
}

/** 参数 → LUT。enabled=false 时直接返回恒等表，调用方不用分支。 */
export function lutFromAdjust(input, size = LUT_SIZE) {
  const adj = normalizeAdjust(input);
  if (!adj.enabled) return identityLut(size);
  const n = Math.max(2, Math.round(size));
  const lut = { size: n, data: new Float32Array(n * n * n * 3) };
  let i = 0;
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const [rr, gg, bb] = shade(r / (n - 1), g / (n - 1), b / (n - 1), adj);
        lut.data[i++] = rr;
        lut.data[i++] = gg;
        lut.data[i++] = bb;
      }
    }
  }
  return lut;
}

/** 三线性采样，输入输出都是 0~1 的浮点。 */
export function sampleLut(lut, r, g, b) {
  const n = lut.size;
  const x = clamp01(r) * (n - 1);
  const y = clamp01(g) * (n - 1);
  const z = clamp01(b) * (n - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const z1 = Math.min(n - 1, z0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const data = lut.data;

  const at = (ri, gi, bi, c) => data[((bi * n + gi) * n + ri) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const c00 = at(x0, y0, z0, c) * (1 - fx) + at(x1, y0, z0, c) * fx;
    const c10 = at(x0, y1, z0, c) * (1 - fx) + at(x1, y1, z0, c) * fx;
    const c01 = at(x0, y0, z1, c) * (1 - fx) + at(x1, y0, z1, c) * fx;
    const c11 = at(x0, y1, z1, c) * (1 - fx) + at(x1, y1, z1, c) * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[c] = c0 * (1 - fz) + c1 * fz;
  }
  return out;
}

/**
 * 把 LUT 应用到 RGBA（原地）。strength 0~1 用于「强度」混合，0 完全不改。
 * 透明像素跳过，避免给透明底染上颜色。
 */
export function applyLutToRgba(imageData, lut, strength = 1) {
  if (!imageData || !lut) return imageData;
  const s = Math.max(0, Math.min(1, Number(strength)));
  if (s === 0) return imageData;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const [rr, gg, bb] = sampleLut(lut, r, g, b);
    data[i] = data[i] + (rr * 255 - data[i]) * s;
    data[i + 1] = data[i + 1] + (gg * 255 - data[i + 1]) * s;
    data[i + 2] = data[i + 2] + (bb * 255 - data[i + 2]) * s;
  }
  return imageData;
}

/**
 * 解析 Adobe .cube 3D LUT。
 * 只认 3D（1D LUT 直接报错，避免静默给出错误颜色）。
 */
export function parseCube(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let size = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]) || 0;
      continue;
    }
    if (line.startsWith('LUT_1D_SIZE')) throw new Error('暂不支持 1D LUT，请导出 3D LUT');
    if (line.startsWith('DOMAIN_MIN')) {
      domainMin = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (line.startsWith('DOMAIN_MAX')) {
      domainMax = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) values.push(parts[0], parts[1], parts[2]);
  }
  if (!size || size < 2) throw new Error('.cube 缺少有效的 LUT_3D_SIZE');
  if (values.length !== size * size * size * 3) {
    throw new Error(`.cube 数据量不符：期望 ${size ** 3} 行，实际 ${values.length / 3} 行`);
  }
  const span = [domainMax[0] - domainMin[0], domainMax[1] - domainMin[1], domainMax[2] - domainMin[2]];
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    data[i] = span[0] ? (values[i] - domainMin[0]) / span[0] : 0;
    data[i + 1] = span[1] ? (values[i + 1] - domainMin[1]) / span[1] : 0;
    data[i + 2] = span[2] ? (values[i + 2] - domainMin[2]) / span[2] : 0;
  }
  return { size, data };
}

/** 导出 .cube 文本（方便把调好的参数带进 ffmpeg / 引擎）。 */
export function encodeCube(lut, title = 'image-clip') {
  const n = lut.size;
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const i = ((b * n + g) * n + r) * 3;
        lines.push(
          `${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`,
        );
      }
    }
  }
  return lines.join('\n');
}

/** 调色参数是否真的会改变画面（面板用来决定是否需要重算预览）。 */
export function isAdjustActive(input) {
  const adj = normalizeAdjust(input);
  if (!adj.enabled) return false;
  return (
    ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows', 'whites', 'blacks'].some(
      (key) => adj[key] !== 0,
    ) || hasCustomCurve(adj.curves)
  );
}

function hasCustomCurve(curves) {
  for (const key of ['rgb', 'r', 'g', 'b']) {
    const points = curves?.[key];
    if (!Array.isArray(points) || points.length !== 2) return true;
    if (points[0][0] !== 0 || points[0][1] !== 0 || points[1][0] !== 1 || points[1][1] !== 1) return true;
  }
  return false;
}
