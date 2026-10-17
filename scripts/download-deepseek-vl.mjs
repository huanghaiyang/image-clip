/**
 * 下载本地 DeepSeek 视觉模型（deepseek-vl2-tiny）到 models/ 下。
 *
 * 为什么是它
 * ----------
 * DeepSeek 的视觉模型里：
 *   - `deepseek-vl-1.3b` 在 HF 镜像上被 401 挡住（拿不到）；
 *   - `deepseek-vl-7b-chat`、`vl2-small` 是 14GB+，CPU 跑不动；
 *   - **`deepseek-vl2-tiny`（6.4GB 单分片）是能拿到的最小 VL 对话模型** ——
 *     本机只有 CPU，这已经是"小"的下限；
 *   - `DeepSeek-OCR` 同为 6.4GB，但它是 OCR 专用模型，不适合"任意图片操作对话"。
 *
 * 部署形态
 * --------
 * 权重只放本机 `models/`（已 gitignore），由 `models/deepseek-vl2-tiny/serve.py`
 * 起一个 **OpenAI 兼容**的本地端点（127.0.0.1），Node 服务把它当成一个 provider。
 * 这样图片只在环回地址上流转，不出本机 —— 与"离线、图片不外发"的约束一致。
 *
 * 用法：
 *   node scripts/download-deepseek-vl.mjs                # 下 VL2-tiny（约 6.4GB）
 *   node scripts/download-deepseek-vl.mjs --repo deepseek-ai/DeepSeek-OCR --dir models/deepseek-ocr
 */
import fs from 'node:fs';
import path from 'node:path';

const MIRROR = process.env.HF_MIRROR || 'https://hf-mirror.com';
/**
 * 下载源（按顺序回退）。实测同一文件：hf-mirror ≈1.4MB/s（6.4GB 需 ~75min），
 * modelscope ≈3.9MB/s（~27min），所以 modelscope 放前面。
 */
const SOURCES = [
  (repo, file) =>
    `https://www.modelscope.cn/api/v1/models/${repo}/repo?Revision=master&FilePath=${file.split('/').map(encodeURIComponent).join('/')}`,
  (repo, file) => `${MIRROR}/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`,
];
const ROOT = path.resolve(import.meta.dirname, '..');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const REPO = argValue('--repo', 'deepseek-ai/deepseek-vl2-tiny');
const DEST = path.resolve(ROOT, argValue('--dir', 'models/deepseek-vl2-tiny'));

function human(bytes) {
  return bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)}GB` : `${(bytes / 1048576).toFixed(0)}MB`;
}

async function listFiles() {
  const res = await fetch(`${MIRROR}/api/models/${REPO}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`列出仓库文件失败 HTTP ${res.status}`);
  const json = await res.json();
  return (json.siblings ?? [])
    .map((s) => s.rfilename)
    .filter((f) => !f.startsWith('.') && !f.includes('.ipynb_checkpoints') && f !== '.gitattributes');
}

async function downloadFile(file) {
  const dest = path.join(DEST, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // 先问一下总大小（用第一个可用源），用于续传与校验
  let expected = 0;
  for (const source of SOURCES) {
    try {
      const head = await fetch(source(REPO, file), { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (head.ok) {
        expected = Number(head.headers.get('content-length') || 0);
        if (expected) break;
      }
    } catch {
      /* 换下一个源 */
    }
  }

  let have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  if (expected && have === expected) {
    console.log(`✓ 已存在 ${file}（${human(have)}）`);
    return;
  }
  if (have > expected && expected) {
    console.log(`… ${file} 比预期大，重下`);
    fs.unlinkSync(dest);
    have = 0;
  }

  for (const source of SOURCES) {
    const url = source(REPO, file);
    try {
      const res = await fetch(url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        redirect: 'follow',
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
      if (!res.ok && res.status !== 206) {
        console.log(`  [跳过] HTTP ${res.status} ${url}`);
        continue;
      }
      const total = have + Number(res.headers.get('content-length') || 0);
      console.log(`↓ ${file} 从 ${have > 0 ? human(have) : '0'} 续传（总计 ${total ? human(total) : '未知'}）`);
      const stream = fs.createWriteStream(dest, { flags: have > 0 ? 'a' : 'w' });
      let received = have;
      let lastLog = Date.now();
      const startedAt = Date.now();
      for await (const chunk of res.body) {
        if (!stream.write(chunk)) await new Promise((r) => stream.once('drain', r));
        received += chunk.length;
        if (Date.now() - lastLog > 5000) {
          lastLog = Date.now();
          const speed = (received - have) / 1048576 / ((Date.now() - startedAt) / 1000);
          const pct = total ? ` ${((received / total) * 100).toFixed(1)}%` : '';
          console.log(`  … ${human(received)}${total ? `/${human(total)}` : ''}${pct}  ${speed.toFixed(1)}MB/s`);
        }
      }
      await new Promise((resolve) => stream.end(resolve));
      const size = fs.statSync(dest).size;
      if (expected && size !== expected) {
        console.log(`  [不完整] ${human(size)}/${human(expected)}，保留以便下次续传`);
        continue;
      }
      console.log(`✓ ${file}（${human(size)}）`);
      return;
    } catch (err) {
      console.log(`  [源失败] ${err.message}（保留已下部分，稍后可续传）`);
    }
  }
  throw new Error(`所有下载源都失败：${file}`);
}

fs.mkdirSync(DEST, { recursive: true });
console.log(`仓库：${REPO}\n目标：${DEST}\n镜像：${MIRROR}\n`);
const files = await listFiles();
console.log(`共 ${files.length} 个文件：${files.join(', ')}\n`);
let total = 0;
for (const file of files) {
  await downloadFile(file);
  total += fs.statSync(path.join(DEST, file)).size;
}
console.log(`\n完成，合计 ${human(total)}`);
console.log('下一步：models\\venv\\Scripts\\pip install transformers accelerate timm einops attrdict sentencepiece');
console.log('然后：npm run llm:serve   # 起本地 OpenAI 兼容端点（127.0.0.1:11500）');
