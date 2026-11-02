/**
 * 应用级模式（工作区）切换
 * ------------------------
 * 这里只保存“当前在哪个工作区”，具体每个工作区的状态由各自的 composable 管理。
 * 这样 TopBar / App / 各 Stage 不需要重复传 props，也不会出现两份 mode 状态。
 *
 * 工作区编号与键盘 1~4 对应：
 *   1 资源库 · 2 视频 · 3 图片处理 · 4 音频
 *
 * 「图片处理」是聚合工作区：右侧属性面板用 tab 切换具体工具。
 * 工具值沿用原来的工作区名（crop / cropimage / …），这样各 Stage、Panel
 * 与导入路由都不需要改名；传入旧工作区名时 setMode 会自动落到对应工具。
 */
import { computed, reactive, readonly } from 'vue';

import { checkHealth as checkWatermarkHealth } from './useWatermark.js';

export const MODES = [
  { value: 'library', label: '资源库', key: '1', hint: '统一管理图片与视频：子目录、批量改名、预览、一键转入编辑' },
  { value: 'video', label: '视频', key: '2', hint: '播放视频、查看完整时间轴、截取关键帧、提取音频' },
  { value: 'image', label: '图片处理', key: '3', hint: '透明裁剪 / 图片裁剪 / 背景去除 / 橡皮擦 / 水印去除 / 像素笔绘' },
  { value: 'audio', label: '音频', key: '4', hint: '音频时间轴 + 频谱可视化，框选区间裁剪并保存 WAV' },
];

/** 图片处理工作区里的工具 tab，数组顺序即右侧 tab 顺序。 */
export const IMAGE_TOOLS = [
  { value: 'crop', label: '透明裁剪', hint: '自动识别 AABB 透明区域并裁剪（原有功能）' },
  { value: 'cropimage', label: '图片裁剪', hint: '常用比例 + 自定义尺寸 + 批量裁剪 + 尺寸预设' },
  { value: 'bgremove', label: '背景去除', hint: '自动识别任意背景色，支持取色器与套索选区' },
  { value: 'eraser', label: '橡皮擦', hint: '笔刷擦除为透明，可调硬度并恢复原图' },
  { value: 'watermark', label: '水印去除', hint: '识别水印掩膜并做内容修复（原有功能）' },
  { value: 'pixel', label: '像素笔绘', hint: '像素级画笔 / 橡皮 / 吸管，绘制后生成新素材或导出 PNG' },
];

const VALID = new Set(MODES.map((mode) => mode.value));

const state = reactive({
  mode: 'image',
  imageTool: 'crop',
});

const currentMode = computed(() => MODES.find((mode) => mode.value === state.mode) ?? MODES[2]);
const currentTool = computed(
  () => IMAGE_TOOLS.find((tool) => tool.value === state.imageTool) ?? IMAGE_TOOLS[0],
);
/** 仅图片处理工作区才有值，其他工作区为 null；快捷键与顶栏按它分派。 */
const activeTool = computed(() => (state.mode === 'image' ? state.imageTool : null));

/** 所有“处理单张图片”的工具；也用于把旧工作区名（如 'cropimage'）兼容成工具值。 */
export const IMAGE_MODES = new Set(IMAGE_TOOLS.map((tool) => tool.value));

function activateTool(tool) {
  state.imageTool = tool;
  if (tool === 'watermark') void checkWatermarkHealth();
}

/** 切换工作区；传入旧图片工作区名时等价于「进入图片处理并切到该工具」。 */
export function setMode(mode) {
  const next = String(mode ?? '');
  if (IMAGE_MODES.has(next)) {
    state.mode = 'image';
    activateTool(next);
    return;
  }
  state.mode = VALID.has(next) ? next : 'image';
  if (state.mode === 'image') activateTool(state.imageTool);
}

/** 图片处理工作区内切换工具 tab。 */
export function setImageTool(tool) {
  if (!IMAGE_MODES.has(tool)) return;
  state.mode = 'image';
  activateTool(tool);
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
    currentTool,
    activeTool,
    actions: { setMode, setImageTool, cycleMode },
  };
}
