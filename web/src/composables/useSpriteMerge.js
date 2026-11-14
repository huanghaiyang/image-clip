/**
 * 精灵图工作区「合并」子模式的共享状态
 * ------------------------------------
 * 拆分 / 合并是同一个工作区的两个方向，共用一个面板和一个舞台：
 *  - 面板右侧改列数 / 间距 / 缩放口径；
 *  - 中间舞台实时显示合并后的整图预览。
 * 两边必须读同一份参数，所以放在模块级单例里（与其它 composable 一致）。
 */
import { computed, ref } from 'vue';

import { useWorkspace } from './useWorkspace.js';
import { planSpriteSheet } from '../lib/sprite.js';

/** 列数 0 = 自动方阵（⌈√N⌉） */
const columns = ref(0);
/** 帧间距（像素，透明） */
const gap = ref(0);
/** contain：等比缩放到单元格；original：原始像素只居中 */
const fit = ref('contain');
/** 合并时用的源：勾选的素材（列表面板里可勾选任意张，尺寸可不同） */
const mergeSource = computed(() => useWorkspace().spriteMerge.value);
const maxColumns = computed(() => Math.max(1, mergeSource.value?.count ?? 1));
const autoColumns = computed(() => Math.max(1, Math.ceil(Math.sqrt(mergeSource.value?.count ?? 1))));
const plan = computed(() => {
  const merge = mergeSource.value;
  if (!merge) return null;
  return planSpriteSheet({
    sizes: merge.frames.map((item) => ({ width: item.width, height: item.height })),
    columns: columns.value,
    gap: gap.value,
  });
});

/** 生成合并预览（maxSide 限制输出长边，避免每次改参数都拼整张大图）。 */
async function buildPreview({ maxSide = 480 } = {}) {
  return useWorkspace().actions.buildSpriteSheet({
    columns: columns.value,
    gap: gap.value,
    fit: fit.value,
    maxSide,
  });
}

/** 合并并输出：target = download | asset | library。 */
async function exportSheet(target = 'download') {
  return useWorkspace().actions.exportSpriteSheet({
    columns: columns.value,
    gap: gap.value,
    target,
    fit: fit.value,
  });
}

export function useSpriteMerge() {
  return { columns, gap, fit, mergeSource, plan, maxColumns, autoColumns, buildPreview, exportSheet };
}
