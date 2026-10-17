/**
 * ONNX Runtime 执行器（EP）选择：让本地 ONNX 模型默认走 GPU，并安全回退。
 *
 * 背景（实测数据，用户机器 RTX 3060 Laptop 6GB）：
 *   · YOLO 水印框推理：cpu 537ms → dml **59ms（9.1×）**
 *   · LaMa 去水印、α-map 检测几乎无提升 —— 因为它们的瓶颈在 OpenCV/WASM 与
 *     JS 侧的预处理/融合，不在 ONNX 推理本身。
 *
 * 为什么用 DirectML 而不是 CUDA：
 *   onnxruntime-node 自带 `dml` 后端（Windows 上用 D3D12 直接吃显卡），**零额外下载**；
 *   而 CUDA EP 需要专门的 onnxruntime-gpu 包与匹配的 CUDA/cuDNN，对本项目不值得。
 *
 * 默认策略：
 *   - `ORT_PROVIDERS` 环境变量可显式指定（如 `cpu` 或 `dml,cpu`）；
 *   - 未指定时先试 `dml,cpu`，**创建失败自动退回 `cpu`** —— 这样在没有 GPU / 显存被占满 /
 *     驱动不支持 DML 的机器上行为与以前完全一致，不会因为"默认开 GPU"而挂掉。
 */

const cache = new Map();

function parseProviders(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 实际生效的 EP 列表（用于 health 报告/诊断）。 */
export function ortProviderPreference() {
  if (process.env.ORT_PROVIDERS) return parseProviders(process.env.ORT_PROVIDERS);
  return ['dml', 'cpu'];
}

/**
 * 创建 ONNX 会话：按偏好顺序尝试，失败逐级回退。
 * @param {object} ort onnxruntime-node 模块
 * @param {string} modelPath
 * @param {object} extra 其他 session 选项
 * @returns {Promise<{session:object, providers:string[]}>}
 */
export async function createSession(ort, modelPath, extra = {}) {
  const key = `${modelPath}`;
  if (cache.has(key)) return cache.get(key);

  const preference = ortProviderPreference();
  const attempts = [];
  // 先按给定顺序整体尝试；若首选项失败，再退化到纯 cpu
  if (preference.length > 1 && preference[0] !== 'cpu') {
    attempts.push(preference, ['cpu']);
  } else {
    attempts.push(preference.length ? preference : ['cpu']);
  }

  let lastError = null;
  for (const providers of attempts) {
    try {
      const session = await ort.InferenceSession.create(modelPath, { ...extra, executionProviders: providers });
      const result = { session, providers };
      cache.set(key, result);
      if (providers[0] !== 'cpu' && providers !== preference) {
        console.warn(`[ort] ${modelPath.split(/[\\/]/).pop()} 回退到 CPU（原偏好 ${preference.join(',')}）`);
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`ONNX 会话创建失败（${modelPath}）：${lastError?.message ?? '未知错误'}`);
}

/** 释放缓存（测试/重载模型用）。 */
export function resetOrtSessions() {
  cache.clear();
}

/** health 报告用：是否至少有一个非 CPU 执行器可用（不实际创建会话，只报偏好与平台信息）。 */
export function ortGpuStatus() {
  return {
    preference: ortProviderPreference(),
    platform: process.platform,
    // onnxruntime-node 的 dml 只在 Windows 上可用
    gpuSupported: process.platform === 'win32',
  };
}
