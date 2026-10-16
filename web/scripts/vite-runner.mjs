/**
 * 受限环境下的 Vite 启动器（不依赖 esbuild 子进程、不依赖 `net use`）。
 *
 * 背景：Vite 在 Windows 上会执行 `exec('net use')` 识别网络驱动器映射
 * （见 vite/dist/node/chunks/… 的 optimizeSafeRealPathSync）。在禁止派生进程的环境里，
 * `spawn` 会同步抛 EPERM，而该调用点没有 try/catch，Vite 会直接崩掉。
 *
 * 这里只替换 "net use" 这一条命令：返回空结果 ⇒ 按“没有网络映射盘”处理，
 * 于是 Vite 走标准 realpathSync.native 分支。其余命令原样交给 Node。
 *
 * 注意顺序：必须先用 CJS `require` 拿到模块对象并在 **任何 ESM 命名导入之前** 打补丁，
 * 否则 Node 会先给 `node:child_process` 建好命名导出快照，补丁就不生效了。
 *
 * 用法：
 *   node scripts/vite-runner.mjs build --configLoader runner --config vite.noesbuild.config.js
 *   node scripts/vite-runner.mjs            # 启动 dev server
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

const originalExec = childProcess.exec;
childProcess.exec = function exec(command, options, callback) {
  if (typeof command !== 'string' || command.trim() !== 'net use') {
    return originalExec.call(childProcess, command, options, callback);
  }
  const done = typeof options === 'function' ? options : callback;
  if (typeof done === 'function') queueMicrotask(() => done(null, '', ''));
  return { on() {}, once() {}, kill() {}, stdout: null, stderr: null, pid: 0 };
};

// vite 的 package.json exports 不含 ./bin/vite.js，因此按真实路径加载
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
await import(pathToFileURL(viteBin).href);
