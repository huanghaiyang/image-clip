/**
 * 背景替代引擎：用「形态学背景」替换掩膜内的像素，平坦处直接替换、有内容处交给修补。
 *
 * 为什么需要它
 * ------------
 * 反混合要解 `B = (I − αW) / (1 − α)`，其中 α 与 W 靠**边界接缝能量**估计。
 * 掩膜只覆盖部分笔画时这个判据会崩：实测用户那张「豆包AI生成」角标，
 * 无论把颜色固定成黑/白/灰，估计都返回 α≈0.02~0.05，结果水印纹丝不动。
 *
 * 而薄描边水印的局部背景可以直接算：形态学开/闭运算（结构元比笔画宽）把细笔画抹掉，
 * 剩下的就是「没有水印时的底色」。但**只在背景平坦处成立**：
 * 实测水印压在蝴蝶翅膀上时，闭运算取到的邻域最大值是翅膀自己 → 会往白底上涂青色块。
 * 所以这里分两步：
 *   1. 背景平坦（梯度小）的掩膜像素 → 直接用形态学背景替换（白底上就是纯白）；
 *   2. 其余（压在内容上的）掩膜像素 → 交给 OpenCV Telea 修补，
 *      以第 1 步的结果为输入，从周围已经干净的像素往外填。
 *
 * 两个工程要点（都是实测出来的）：
 *  - 背景在 1/4 分辨率上算：2720×1520 三通道 + 椭圆核在 wasm 上要 55s，降到 1/4 后 ~1.5s；
 *  - 用矩形结构元：OpenCV 的矩形核可分离，椭圆核不可分离。
 */
import sharp from 'sharp';

import { oddSize } from '../../shared/watermark/index.js';
import { getOpenCv } from './opencv.js';

/** 背景估计用的降采样系数（背景是低频信号，1/4 足够）。 */
const BG_DOWNSCALE = 4;
/** 背景梯度超过该值就认为"不是平坦底色"，改用修补。 */
const FLAT_GRADIENT = 14;

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {{width:number,height:number,data:Uint8Array}} mask
 * @param {{polarity?:'bright'|'dark', radius?:number}} [options]
 */
export async function removeByBackground(image, mask, options = {}) {
  const cv = await getOpenCv();
  const polarity = options.polarity === 'bright' ? 'bright' : 'dark';
  const { width, height } = image;
  const scale = Math.min(width, height);
  const fullRadius = oddSize(
    Number.isFinite(options.radius) ? options.radius : Math.max(15, Math.round(scale / 22)),
    15,
    201,
  );

  // 1) 降采样 RGB 并估计形态学背景
  const smallW = Math.max(1, Math.round(width / BG_DOWNSCALE));
  const smallH = Math.max(1, Math.round(height / BG_DOWNSCALE));
  const { data: smallRgb } = await sharp(Buffer.from(image.data), { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .resize(smallW, smallH, { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const src = new cv.Mat(smallH, smallW, cv.CV_8UC3);
  src.data.set(smallRgb);
  const radius = Math.max(3, oddSize(Math.round(fullRadius / BG_DOWNSCALE), 3, 61));
  const se = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(radius, radius));
  const bg = new cv.Mat();
  cv.morphologyEx(src, bg, polarity === 'bright' ? cv.MORPH_OPEN : cv.MORPH_CLOSE, se);

  // 背景平坦度：在降采样图上算梯度幅值。
  //
  // 注意这里算的是**原图**（src）的梯度，不是背景估计（bg）的梯度 —— 踩过的坑：
  // 水印压在画面内容上时（用户那张图里「豆包AI生成」横跨蝴蝶翅膀），
  // 背景估计本身就是翅膀自己的颜色、局部很平滑，于是"平坦"判据通过 →
  // 用错误的底色把翅膀替换掉，糊成一整块蓝色。改用**原图**梯度后，
  // 有结构的地方判为非平坦，交给 Telea 修补，不再做颜色替换。
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGB2GRAY);
  const gx = new cv.Mat();
  const gy = new cv.Mat();
  cv.Sobel(gray, gx, cv.CV_16S, 1, 0, 3);
  cv.Sobel(gray, gy, cv.CV_16S, 0, 1, 3);
  const fx = new cv.Mat();
  const fy = new cv.Mat();
  gx.convertTo(fx, cv.CV_32F);
  gy.convertTo(fy, cv.CV_32F);
  const mag = new cv.Mat();
  cv.magnitude(fx, fy, mag);
  const mag8 = new cv.Mat();
  mag.convertTo(mag8, cv.CV_8UC1, 0.25);
  const bgRgb = Buffer.from(bg.data);
  const gradSmall = Buffer.from(mag8.data);
  src.delete();
  bg.delete();
  gray.delete();
  gx.delete();
  gy.delete();
  fx.delete();
  fy.delete();
  mag.delete();
  mag8.delete();
  se.delete();

  // 2) 背景与平坦度都放大回原尺寸
  const [{ data: bgFull }, { data: gradFull }] = await Promise.all([
    sharp(bgRgb, { raw: { width: smallW, height: smallH, channels: 3 } })
      .resize(width, height, { kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(gradSmall, { raw: { width: smallW, height: smallH, channels: 1 } })
      .resize(width, height, { kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  // 3) 带 1px 软边的掩膜：平坦处直接替换
  const soft = softMask(mask, 1);
  const output = { width, height, data: new Uint8ClampedArray(image.data) };
  const roughMask = new Uint8Array(width * height); // 需要修补的部分（压在内容上的）
  let flatPixels = 0;
  let roughPixels = 0;
  for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
    const w = soft.data[i] / 255;
    if (w <= 0.002) continue;
    if (gradFull[i] < FLAT_GRADIENT) {
      const q = i * 3;
      for (let c = 0; c < 3; c += 1) {
        output.data[p + c] = image.data[p + c] * (1 - w) + bgFull[q + c] * w;
      }
      flatPixels += 1;
    } else {
      roughMask[i] = 255;
      roughPixels += 1;
    }
  }

  // 4) 压在内容上的部分：以"已清理过平坦区的图"为输入做 Telea 修补
  if (roughPixels > 0) {
    const rgb = new cv.Mat(height, width, cv.CV_8UC3);
    for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
      rgb.data[i * 3] = output.data[p];
      rgb.data[i * 3 + 1] = output.data[p + 1];
      rgb.data[i * 3 + 2] = output.data[p + 2];
    }
    const cvMask = new cv.Mat(height, width, cv.CV_8UC1);
    cvMask.data.set(roughMask);
    const dst = new cv.Mat();
    cv.inpaint(rgb, cvMask, dst, Math.max(2, Math.round(fullRadius / 12)), cv.INPAINT_TELEA);
    for (let i = 0, p = 0; i < width * height; i += 1, p += 4) {
      if (roughMask[i] <= 127) continue;
      output.data[p] = dst.data[i * 3];
      output.data[p + 1] = dst.data[i * 3 + 1];
      output.data[p + 2] = dst.data[i * 3 + 2];
    }
    rgb.delete();
    cvMask.delete();
    dst.delete();
  }

  // 允许改动的区域：软边掩膜（含修补进来的部分）
  for (let i = 0; i < roughMask.length; i += 1) {
    if (roughMask[i] > 127) soft.data[i] = 255;
  }
  return { output, backgroundRadius: radius * BG_DOWNSCALE, maskUsed: soft, flatPixels, roughPixels };
}

/**
 * 掩膜 → 1px 软边（3×3 盒式模糊）。
 *
 * 不直接复用 shared 的 `feather()`：那个是给"羽化"参数用的多次模糊，
 * 这里只需要抹掉一个像素的台阶；而且返回的掩膜还要交给完整性校验，
 * 它必须覆盖所有会被改动的像素（否则会被判成"改了掩膜外"）。
 */
export function softMask(mask, radiusPx = 1) {
  if (radiusPx <= 0) return { width: mask.width, height: mask.height, data: Uint8Array.from(mask.data) };
  const { width, height, data } = mask;
  const out = new Uint8Array(data.length);
  const r = Math.max(1, Math.round(radiusPx));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += data[yy * width + xx];
          n += 1;
        }
      }
      out[y * width + x] = n ? Math.round(sum / n) : data[y * width + x];
    }
  }
  return { width, height, data: out };
}
