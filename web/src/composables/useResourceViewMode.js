/**
 * 资源列表视图偏好（平铺 / 树形）
 * ------------------------------
 * 每个资源列表用独立的 key 记住自己的选择，刷新或切换工作区后保持一致。
 */
import { ref, watch } from 'vue';

const PREFIX = 'image-clip:resource-view:';

export function useResourceViewMode(key, fallback = 'flat') {
  let initial = fallback === 'tree' ? 'tree' : 'flat';
  try {
    const saved = localStorage.getItem(`${PREFIX}${key}`);
    if (saved === 'flat' || saved === 'tree') initial = saved;
  } catch {
    // 隐私模式下 localStorage 可能不可用，退回默认值
  }

  const mode = ref(initial);
  watch(mode, (value) => {
    try {
      localStorage.setItem(`${PREFIX}${key}`, value);
    } catch {
      // 存不下也不影响当前会话的切换
    }
  });
  return mode;
}
