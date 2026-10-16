/**
 * 下载离线语义检测模型（文本检测 DBNet；可选 YOLOv5 水印检测器）。
 *
 * 为什么需要"语义"模型
 * --------------------
 * 纯统计的 α-map 检测没有"水印"这个概念。实测用户那张 20 只蝴蝶的插画：亮极性把
 * 浅色蝴蝶读成 α≈0.48~0.55 的叠加物（掩膜 99.6% 是画面内容），周期性路径更把蝴蝶
 * 网格判成"平铺水印"（22%）。这类错误不是调参能解决的，需要模型给出语义判断。
 *
 * 而**绝大多数可见水印是文字**，所以主模型选了 PP-OCRv4 的文本检测（DBNet）：
 *   - 只有 4.5MB，纯 ONNX，运行期无需 Python/torch（onnxruntime-node 已是依赖）；
 *   - 输出文本区域概率图 → 把水印检测限制在文字区域内，
 *     插画里的非文字内容**从结构上**不可能再被当成水印；
 *   - 文字区域只当种子，像素级掩膜仍由本地 α-map 精修。
 *
 * 备选（默认不下载）：Eugeoter/yolov5-watermark-detection 的 YOLOv5 水印检测器（165MB）
 * 能给出水印**边界框**，对图形类（非文字）水印更有用；但它没有现成 ONNX，需要在构建机
 * 上用 PyTorch 导出（见 scripts/export-wm-yolov5.py）。
 *
 * 下载源（这台机器上 github.com/raw.githubusercontent 不可达，下面这些可达）：
 *   - 模型：hf-mirror.com（HuggingFace 镜像）
 *   - YOLOv5 源码：codeload.github.com（GitHub zip 端点；PowerShell 的
 *     Invoke-WebRequest 在此会报 TLS 鉴权错，必须用 Node 的 fetch）
 *
 * 用法：
 *   node scripts/download-wm-model.mjs             # 文本检测模型（推荐，4.5MB）
 *   node scripts/download-wm-model.mjs --yolov5    # 额外下 YOLOv5 权重 + 源码（导出用）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODELS = path.join(ROOT, 'models');

/** 主模型：PP-OCRv4 文本检测（DBNet）。 */
const TEXT_MODEL = {
  url: 'https://hf-mirror.com/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
  file: 'ppocrv4-det.onnx',
  note: 'PP-OCRv4 文本检测（DBNet）ONNX —— 离线，4.5MB，运行期零 Python 依赖',
  minBytes: 3 * 1024 * 1024,
};

const YOLOV5_SOURCE = {
  url: 'https://codeload.github.com/ultralytics/yolov5/zip/refs/tags/v7.0',
  file: 'yolov5-v7.0.zip',
  note: 'YOLOv5 v7.0 源码（导出 ONNX 需要它的模型定义）',
};

const YOLOV5_WEIGHTS = {
  url: 'https://hf-mirror.com/Eugeoter/yolov5-watermark-detection/resolve/main/watermark-detection-73.pt',
  file: 'watermark-yolov5.pt',
  note: 'YOLOv5 水印检测器权重（约 165MB，输出水印边界框）',
  minBytes: 100 * 1024 * 1024,
};

function human(bytes) {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

async function download({ url, file, note, minBytes = 1024 }, { force = false } = {}) {
  const dest = path.join(MODELS, file);
  if (!force && fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    if (size >= minBytes) {
      console.log(`✓ 已存在：${file}（${human(size)}）`);
      return dest;
    }
    console.log(`… 已存在但过小（${human(size)}），重新下载`);
  }
  console.log(`↓ ${note}\n  ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let received = 0;
  let lastLog = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (Date.now() - lastLog > 2000) {
      lastLog = Date.now();
      const pct = total ? ` ${((received / total) * 100).toFixed(1)}%` : '';
      console.log(`  … ${human(received)}${total ? ` / ${human(total)}` : ''}${pct}`);
    }
  }
  const buffer = Buffer.concat(chunks);
  if (total && buffer.length !== total) {
    throw new Error(`下载不完整：期望 ${total} 字节，实得 ${buffer.length}`);
  }
  fs.writeFileSync(dest, buffer);
  console.log(`✓ 已保存 ${file}（${human(buffer.length)}）`);
  return dest;
}

const args = new Set(process.argv.slice(2));
const wantYolov5 = args.has('--yolov5');

fs.mkdirSync(MODELS, { recursive: true });

// 主模型：文本检测（门控用），默认就下
await download(TEXT_MODEL);
if (wantYolov5) {
  await download(YOLOV5_SOURCE);
  await download(YOLOV5_WEIGHTS);
}

console.log('\n完成。检测门控默认关闭，开启方式：POST /api/watermark/detect?...&textGate=1');
console.log('（YOLOv5 路线是备选：需 --yolov5 下权重与源码，再用 scripts/export-wm-yolov5.py 导出 ONNX）');
