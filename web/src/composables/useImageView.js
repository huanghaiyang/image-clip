/**
 * 图片舞台的“实时查看”选项（单例）
 * --------------------------------
 * 只影响中间画布的显示效果，不修改素材像素，也不影响任何导出结果。
 * 灰度查看：把灰度色阶映射到任意颜色，强度 0-100% 可调。
 * 实现方式是一个 SVG feColorMatrix 滤镜（见 App.vue），矩阵按强度/颜色实时计算，
 * 因此拖动滑杆或换颜色时画布立刻变化，不需要重新处理像素。
 * 画布背景：棋盘格（识别透明区）或纯色（看边缘与明暗更干净）。
 */
import { computed, reactive, readonly } from 'vue';

const state = reactive({
  /** 灰度查看强度 0-100；0 表示关闭。 */
  grayscale: 0,
  /** 灰度映射到的颜色；白色 = 纯灰度。 */
  color: '#ffffff',
  /** 透明通道视图：把 alpha 渲染成灰度，黑 = 透明，白 = 不透明。 */
  alpha: false,
  /** 透明通道增益：显示时 alpha × 增益，放大后才能看见 alpha 只有个位数的残影。 */
  alphaGain: 10,
  /** 画布背景：checker = 棋盘格，solid = 纯色。 */
  backdrop: 'checker',
  /** 纯色背景颜色。 */
  backdropColor: '#808080',
});

function clamp(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function normalizeHex(value) {
  let text = String(value ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(text)) {
    text = text[0] + text[0] + text[1] + text[1] + text[2] + text[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return `#${text.toLowerCase()}`;
}

function parseRgb(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return { r: 1, g: 1, b: 1 };
  return {
    r: parseInt(normalized.slice(1, 3), 16) / 255,
    g: parseInt(normalized.slice(3, 5), 16) / 255,
    b: parseInt(normalized.slice(5, 7), 16) / 255,
  };
}

function clampGain(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 10;
  return Math.min(50, Math.max(1, n));
}

/**
 * 生成 feColorMatrix 的 4×5 矩阵：
 *  - 透明通道视图：R=G=B=alpha×增益，输出 alpha 固定 1（整块画布不透明，黑底最干净）；
 *  - 灰度查看：输出 = 原色 × (1 - s) + 亮度 × 颜色 × s。
 * 与灰度着色工具使用的 sRGB 亮度权重保持一致。
 */
const filterMatrix = computed(() => {
  if (state.alpha) {
    const g = Number(state.alphaGain.toFixed(4));
    const rows = [
      [0, 0, 0, g, 0],
      [0, 0, 0, g, 0],
      [0, 0, 0, g, 0],
      [0, 0, 0, 0, 1],
    ];
    return rows.map((row) => row.map((n) => Number(n.toFixed(4))).join(' ')).join('  ');
  }

  const s = state.grayscale / 100;
  const { r, g, b } = parseRgb(state.color);
  const wr = 0.2126;
  const wg = 0.7152;
  const wb = 0.0722;
  const keep = 1 - s;
  const rows = [
    [keep + s * wr * r, s * wg * r, s * wb * r, 0, 0],
    [s * wr * g, keep + s * wg * g, s * wb * g, 0, 0],
    [s * wr * b, s * wg * b, keep + s * wb * b, 0, 0],
    [0, 0, 0, 1, 0],
  ];
  return rows.map((row) => row.map((n) => Number(n.toFixed(4))).join(' ')).join('  ');
});

export function setGrayscale(value) {
  state.grayscale = clamp(value);
}

export function setColor(value) {
  const hex = normalizeHex(value);
  if (hex) state.color = hex;
}

export function setBackdrop(value) {
  if (value === 'checker' || value === 'solid') state.backdrop = value;
}

export function setAlpha(value) {
  state.alpha = Boolean(value);
}

export function setAlphaGain(value) {
  state.alphaGain = clampGain(value);
}

export function setBackdropColor(value) {
  const hex = normalizeHex(value);
  if (hex) state.backdropColor = hex;
}

export function useImageView() {
  return {
    state: readonly(state),
    filterMatrix,
    actions: { setGrayscale, setColor, setBackdrop, setBackdropColor, setAlpha, setAlphaGain },
  };
}
