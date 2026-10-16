/**
 * 图像质量指标（纯 JS）：PSNR 与 SSIM。
 *
 * 用途是**量化去水印效果**：把「干净原图」当作参考，
 * 比较「带水印图」与「去水印结果」分别与参考图的差距 —— 修补后应当明显更接近原图。
 * 这是验证脚本 scripts/verify-watermark.mjs 的核心依据。
 */

/** 逐像素 MSE（只比较前 3 个通道或指定通道数）。 */
export function mse(a, b, { channels = 3, region = null } = {}) {
  const width = a.width;
  const height = a.height;
  if (b.width !== width || b.height !== height) throw new Error('尺寸不一致，无法比较');

  const x0 = region ? Math.max(0, region.x) : 0;
  const y0 = region ? Math.max(0, region.y) : 0;
  const x1 = region ? Math.min(width, region.x + region.width) : width;
  const y1 = region ? Math.min(height, region.y + region.height) : height;

  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pa = (y * width + x) * 4;
      const pb = (y * width + x) * 4;
      for (let c = 0; c < channels; c += 1) {
        const d = a.data[pa + c] - b.data[pb + c];
        sum += d * d;
        count += 1;
      }
    }
  }
  return count ? sum / count : 0;
}

/** PSNR（dB）。完全相同返回 Infinity。 */
export function psnr(reference, test, options = {}) {
  const e = mse(reference, test, options);
  if (e === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / e);
}

/** 灰度化（只用于 SSIM 比较，符合常规做法）。 */
export function toGray(rgba, width = rgba.width, height = rgba.height) {
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = 0.299 * rgba.data[p] + 0.587 * rgba.data[p + 1] + 0.114 * rgba.data[p + 2];
  }
  return { width, height, data: out };
}

const SSIM_C1 = (0.01 * 255) ** 2;
const SSIM_C2 = (0.03 * 255) ** 2;

/**
 * 全局 SSIM（11×11 高斯窗，σ=1.5，与 Wang et al. 2004 的原始设置一致）。
 * 返回 [0,1]，1 表示完全一致。
 */
export function ssim(reference, test, { windowSize = 11, sigma = 1.5, region = null } = {}) {
  if (reference.width !== test.width || reference.height !== test.height) {
    throw new Error('尺寸不一致，无法比较');
  }
  const width = reference.width;
  const height = reference.height;
  const x = toGray(reference).data;
  const y = toGray(test).data;
  const kernel = gaussianKernel(windowSize, sigma);
  const radius = (windowSize - 1) / 2;

  const bounds = region
    ? {
        x0: Math.max(0, region.x),
        y0: Math.max(0, region.y),
        x1: Math.min(width, region.x + region.width),
        y1: Math.min(height, region.y + region.height),
      }
    : { x0: 0, y0: 0, x1: width, y1: height };

  let sum = 0;
  let n = 0;
  for (let cy = bounds.y0; cy < bounds.y1; cy += 1) {
    for (let cx = bounds.x0; cx < bounds.x1; cx += 1) {
      let muX = 0;
      let muY = 0;
      let xx = 0;
      let yy = 0;
      let xy = 0;
      let wsum = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const sy = Math.min(height - 1, Math.max(0, cy + dy));
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = Math.min(width - 1, Math.max(0, cx + dx));
          const k = kernel[dy + radius][dx + radius];
          const px = x[sy * width + sx];
          const py = y[sy * width + sx];
          muX += k * px;
          muY += k * py;
          xx += k * px * px;
          yy += k * py * py;
          xy += k * px * py;
          wsum += k;
        }
      }
      muX /= wsum;
      muY /= wsum;
      xx /= wsum;
      yy /= wsum;
      xy /= wsum;
      const varX = xx - muX * muX;
      const varY = yy - muY * muY;
      const cov = xy - muX * muY;
      const s = ((2 * muX * muY + SSIM_C1) * (2 * cov + SSIM_C2)) /
        ((muX * muX + muY * muY + SSIM_C1) * (varX + varY + SSIM_C2));
      sum += s;
      n += 1;
    }
  }
  return n ? sum / n : 1;
}

function gaussianKernel(size, sigma) {
  const kernel = [];
  const radius = (size - 1) / 2;
  let total = 0;
  for (let y = -radius; y <= radius; y += 1) {
    const row = [];
    for (let x = -radius; x <= radius; x += 1) {
      const v = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
      row.push(v);
      total += v;
    }
    kernel.push(row);
  }
  for (const row of kernel) for (let i = 0; i < row.length; i += 1) row[i] /= total;
  return kernel;
}
