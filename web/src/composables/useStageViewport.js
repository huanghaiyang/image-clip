/**
 * 图片编辑舞台的共享视口
 * ----------------------
 * 裁剪 / 背景去除 / 橡皮擦三个舞台的“看”这部分完全一致：
 * 居中显示、按容器自适应缩放、滚轮缩放、平移、屏幕坐标 → 图片像素坐标。
 * 抽到这里，三个 Stage 只关心自己的交互层。
 *
 * 约定：
 *  - `baseEl` 是**显示用**的 canvas（它的 CSS 尺寸 = 图片尺寸 × scale），
 *    所有鼠标坐标都以它为基准换算，天然兼容 zoom / pan；
 *  - 覆盖层 canvas 铺满整个舞台容器，用容器坐标绘制裁剪框、套索和笔刷光标，
 *    这样线宽与手柄大小是“屏幕像素”，不会随图片放大变成一根柱子。
 */
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef } from 'vue';

/** 舞台四周留白，避免图片贴边。 */
const PADDING = 56;

export function useStageViewport() {
  const container = shallowRef(null);
  const baseEl = shallowRef(null);

  /** 当前图片的自然尺寸（像素）。 */
  const image = reactive({ width: 0, height: 0 });
  const view = reactive({ containerWidth: 0, containerHeight: 0, fit: 1, zoom: 1, panX: 0, panY: 0 });

  let observer = null;

  const scale = computed(() => view.fit * Math.max(0.01, view.zoom));
  const displayWidth = computed(() => Math.max(1, image.width * scale.value));
  const displayHeight = computed(() => Math.max(1, image.height * scale.value));
  const zoomPercent = computed(() => Math.round(scale.value * 100));

  function computeFit() {
    if (!image.width || !image.height || !view.containerWidth || !view.containerHeight) {
      view.fit = 1;
      return;
    }
    const availWidth = Math.max(40, view.containerWidth - PADDING);
    const availHeight = Math.max(40, view.containerHeight - PADDING);
    // 上限 4 倍：小图标放大到 4 倍再大就只剩马赛克了
    view.fit = Math.min(availWidth / image.width, availHeight / image.height, 4);
  }

  function measure() {
    const el = container.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    view.containerWidth = rect.width;
    view.containerHeight = rect.height;
    computeFit();
  }

  onMounted(() => {
    measure();
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => measure());
      if (container.value) observer.observe(container.value);
    }
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  /** 切换素材时调用；resetView=true 会回到「适合窗口」。 */
  function setImage(width, height, { reset = true } = {}) {
    image.width = Math.max(0, Math.round(Number(width) || 0));
    image.height = Math.max(0, Math.round(Number(height) || 0));
    computeFit();
    if (reset) {
      view.zoom = 1;
      view.panX = 0;
      view.panY = 0;
    }
  }

  function setZoom(value) {
    view.zoom = Math.min(16, Math.max(0.05, Number(value) || 1));
    if (view.zoom <= 1.0001) {
      // 回到 100% 时顺手把平移归零，避免“图回到中间但视口还偏着”
      view.panX = 0;
      view.panY = 0;
    }
  }

  function zoomBy(factor) {
    setZoom(view.zoom * factor);
  }

  function zoomIn() {
    zoomBy(1.25);
  }

  function zoomOut() {
    zoomBy(0.8);
  }

  function resetView() {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
  }

  function panBy(dx, dy) {
    view.panX += dx;
    view.panY += dy;
  }

  /**
   * 屏幕坐标 → 图片像素坐标。
   * 用 baseEl 的 getBoundingClientRect 换算，缩放与平移自动生效。
   */
  function toImage(event) {
    const el = baseEl.value;
    if (!el || !image.width || !image.height) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * image.width,
      y: ((event.clientY - rect.top) / rect.height) * image.height,
    };
  }

  /** 覆盖层坐标：以舞台容器左上角为原点。 */
  function frameOrigin() {
    const c = container.value?.getBoundingClientRect();
    const b = baseEl.value?.getBoundingClientRect();
    if (!c || !b) return null;
    return { x: b.left - c.left, y: b.top - c.top, width: b.width, height: b.height };
  }

  const frameStyle = computed(() => ({
    width: `${displayWidth.value}px`,
    height: `${displayHeight.value}px`,
    transform: `translate(${view.panX}px, ${view.panY}px)`,
  }));

  return {
    container,
    baseEl,
    image,
    view,
    scale,
    displayWidth,
    displayHeight,
    zoomPercent,
    frameStyle,
    measure,
    setImage,
    setZoom,
    zoomIn,
    zoomOut,
    zoomBy,
    resetView,
    panBy,
    toImage,
    frameOrigin,
  };
}
