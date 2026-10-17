/**
 * 启动本地 DeepSeek-VL2 侧车（OpenAI 兼容端点，默认 127.0.0.1:11500）。
 *
 * 用法：
 *   npm run llm:serve                 # 加载模型并起服务
 *   npm run llm:serve -- --no-load    # 只起服务验证协议（不加载 6.4GB 权重）
 *   npm run llm:serve -- --port 11600
 *
 * 说明：模型在 CPU 上加载/推理都慢，所以这里把 python 进程的 stdout 直接转发出来，
 * 用户能看到"加载权重…/推理完成 62s"这类进度；Ctrl+C 会一并结束 python 子进程。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODEL_DIR = path.join(ROOT, 'models', 'deepseek-vl2-tiny');
const SCRIPT = path.join(ROOT, 'scripts', 'llm-sidecar-deepseek-vl.py');

const venvPython = path.join(ROOT, 'models', 'venv', 'Scripts', 'python.exe');
const python = fs.existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';

if (!fs.existsSync(SCRIPT)) {
  console.error(`✗ 找不到侧车脚本：${SCRIPT}`);
  process.exit(1);
}
if (!fs.existsSync(MODEL_DIR)) {
  console.error(
    `✗ 找不到模型目录：${MODEL_DIR}\n` +
      '  先下载：node scripts/download-deepseek-vl.mjs（约 6.4GB，支持断点续传）',
  );
  process.exit(1);
}

const forward = process.argv.slice(2);
const args = [SCRIPT, '--model', MODEL_DIR, ...forward];
console.log(`启动本地 DeepSeek-VL2 侧车：\n  ${python}\n  ${args.join(' ')}\n`);
console.log('模型在 CPU 上加载约需 1~4 分钟；就绪后 Node 侧 /api/llm/health 会显示可达。\n');

const child = spawn(python, args, { cwd: ROOT, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
