/**
 * 应用级模式（工作区）切换
 * ------------------------
 * 这里只保存“当前在哪个工作区”，具体每个工作区的状态由各自的 composable 管理。
 * 这样 TopBar / App / 各 Stage 不需要重复传 props，也不会出现两份 mode 状态。
 *
 * 模式编号与键盘 1~9 对应：
 *   1 资源库 · 2 视频 · 3 透明裁剪 · 4 图片裁剪 · 5 背景去除 · 6 橡皮擦 · 7 水印去除 · 8 音频 · 9 像素笔绘
 */
import { computed, reactive, readonly } from 'vue';

import { checkHealth as checkWatermarkHealth } from './useWatermark.js';

export const MODES = [
  { value: 'library', label: '资源库', key: '1', hint: '统一管理图片与视频：子目录、批量改名、预览、一键转入编辑' },
  { value: 'video', label: '视频', key: '2', hint: '播放视频、查看完整时间轴、截取关键帧、提取音频' },
  { value: 'crop', label: '透明裁剪', key: '3', hint: '自动识别 AABB 透明区域并裁剪（原有功能）' },
  { value: 'cropimage', label: '图片裁剪', key: '4', hint: '常用比例 + 自定义尺寸 + 批量裁剪 + 尺寸预设' },
  { value: 'bgremove', label: '背景去除', key: '5', hint: '自动识别任意背景色，支持取色器与套索选区' },
  { value: 'eraser', label: '橡皮擦', key: '6', hint: '笔刷擦除为透明，可调硬度并恢复原图' },
  { value: 'watermark', label: '水印去除', key: '7', hint: '识别水印掩膜并做内容修复（原有功能）' },
  { value: 'audio', label: '音频', key: '8', hint: '音频时间轴 + 频谱可视化，框选区间裁剪并保存 WAV' },
  { value: 'pixel', label: '像素笔绘', key: '9', hint: '像素级画笔 / 橡皮 / 吸管，绘制后生成新素材或导出 PNG' },
];

const VALID = new Set(MODES.map((mode) => mode.value));

const state = reactive({
  mode: 'crop',
  lastImageMode: 'crop',
});

const currentMode = computed(() => MODES.find((mode) => mode.value === state.mode) ?? MODES[2]);

/** 所有“处理单张图片”的工作区，切换素材时它们都读取 workspace.selected。 */
export const IMAGE_MODES = new Set(['crop', 'cropimage', 'bgremove', 'eraser', 'watermark', 'pixel']);

export function setMode(mode) {
  const next = VALID.has(mode) ? mode : 'crop';
  state.mode = next;
  if (IMAGE_MODES.has(next)) state.lastImageMode = next;
  if (next === 'watermark') void checkWatermarkHealth();
}

export function cycleMode(direction = 1) {
  const index = MODES.findIndex((mode) => mode.value === state.mode);
  const next = (index + direction + MODES.length) % MODES.length;
  setMode(MODES[next].value);
}

export function useAppMode() {
  return {
    state: readonly(state),
    currentMode,
    actions: { setMode, cycleMode },
  };
}
