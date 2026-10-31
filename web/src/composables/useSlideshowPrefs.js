/**
 * 资源库轮播偏好（单例）
 * ----------------------
 * 轮播是模态层，关闭后组件会卸载；把「播放间隔 / 是否自动播放 / 最后停留的图片」
 * 记到 localStorage，下次打开时接着上次的现场。
 *
 * 不放进临时会话文档：这些是跨会话的观看习惯，而不是一次工作中的临时操作。
 */
import { reactive, readonly } from 'vue';

const KEY = 'image-clip:slideshow:v1';
const MIN_INTERVAL_MS = 10;
const MAX_INTERVAL_MS = 600000;

function clampInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 3000;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(number)));
}

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      intervalMs: clampInterval(parsed?.intervalMs),
      playing: parsed?.playing !== false,
      lastPath: typeof parsed?.lastPath === 'string' ? parsed.lastPath : '',
    };
  } catch {
    return { intervalMs: 3000, playing: true, lastPath: '' };
  }
}

const state = reactive(load());
let timer = null;

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state }));
  } catch {
    // 隐私模式或存储已满时忽略
  }
}

/** 更新偏好；写入合并成一次，避免每换一张图都同步写 localStorage。 */
export function updateSlideshowPrefs(patch = {}) {
  if (patch.intervalMs !== undefined) state.intervalMs = clampInterval(patch.intervalMs);
  if (patch.playing !== undefined) state.playing = Boolean(patch.playing);
  if (patch.lastPath !== undefined) state.lastPath = String(patch.lastPath || '');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    persist();
  }, 400);
}

export function useSlideshowPrefs() {
  return { state: readonly(state), actions: { update: updateSlideshowPrefs } };
}
