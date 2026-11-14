/**
 * 精灵图（Sprite）工作状态
 * ------------------------
 * 输入是当前选中的素材（一张整图 sprite sheet），输出是切好的帧列表。
 * 帧只保存矩形，不复制像素；预览与播放都直接用源 bitmap 按矩形裁绘，
 * 因此切换切法 / 帧数不会额外占内存。
 */
import { computed, markRaw, reactive, readonly, shallowRef, watch } from 'vue';

import { SPRITE_MAX_GRID, buildGridFrames, detectSpriteGrid } from '../lib/sprite.js';

const state = reactive({
  sourceId: null,
  name: '',
  width: 0,
  height: 0,
  /** 工作区的两个方向：split 拆分已有 sprite / merge 多图合并成 sprite */
  pane: 'split',
  /** auto：按透明分隔线切；grid：按列数 × 行数等分 */
  mode: 'auto',
  /** 自动分隔的检测结果；没有任何分隔线时为 false */
  detected: false,
  autoColumns: 0,
  autoRows: 0,
  columns: 1,
  rows: 1,
  selected: 0,
  playing: false,
  fps: 12,
  loop: true,
});

/** 源图 bitmap 单独用 shallowRef 存，避免 Vue 深度代理大对象 */
const source = shallowRef(null);
const autoFrames = shallowRef([]);

const frames = computed(() => {
  if (!state.width || !state.height) return [];
  if (state.mode === 'auto' && state.detected) return autoFrames.value;
  return buildGridFrames(state.width, state.height, state.columns, state.rows);
});

const currentFrame = computed(() => frames.value[state.selected] ?? null);
const hasSource = computed(() => Boolean(source.value));

// --------------------------------------------------------------- 播放

let timer = 0;

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = 0;
  }
}

function pause() {
  state.playing = false;
  stopTimer();
}

function play() {
  const total = frames.value.length;
  if (!total) return;
  // 停在最后一帧时，循环播放从第一帧重新开始
  if (!state.loop && state.selected >= total - 1) state.selected = 0;
  state.playing = true;
  stopTimer();
  timer = setInterval(() => {
    const count = frames.value.length;
    if (!count) {
      pause();
      return;
    }
    if (state.selected + 1 >= count) {
      if (state.loop) state.selected = 0;
      else {
        state.selected = count - 1;
        pause();
      }
    } else {
      state.selected += 1;
    }
  }, Math.max(16, 1000 / Math.max(1, state.fps)));
}

function togglePlay() {
  if (state.playing) pause();
  else play();
}

function step(delta) {
  const total = frames.value.length;
  if (!total) return;
  pause();
  state.selected = Math.min(total - 1, Math.max(0, state.selected + delta));
}

watch(
  () => state.fps,
  () => {
    if (state.playing) play();
  },
);

// 切法变化后，选中的帧号可能越界
watch(frames, (list) => {
  if (!list.length) {
    state.selected = 0;
    return;
  }
  if (state.selected > list.length - 1) state.selected = list.length - 1;
});

// --------------------------------------------------------------- 动作

function applyDetection(item) {
  const result = detectSpriteGrid(item.imageData?.data, item.width, item.height);
  autoFrames.value = result?.frames ?? [];
  state.autoColumns = result?.columns ?? 0;
  state.autoRows = result?.rows ?? 0;
  state.detected = Boolean(result && result.frames.length > 1);
  if (state.detected) {
    state.mode = 'auto';
    state.columns = result.columns;
    state.rows = result.rows;
  } else {
    state.mode = 'grid';
    state.columns = Math.max(1, result?.columns ?? 1);
    state.rows = Math.max(1, result?.rows ?? 1);
  }
  return state.detected;
}

/** 载入素材（同一张图重复调用是幂等的）。 */
export function loadSpriteItem(item) {
  if (!item || !item.bitmap) return false;
  if (state.sourceId === item.id) return false;

  state.sourceId = item.id;
  state.name = item.name;
  state.width = item.width;
  state.height = item.height;
  source.value = markRaw({ bitmap: item.bitmap, imageData: item.imageData });
  state.selected = 0;
  state.playing = false;
  stopTimer();
  applyDetection(item);
  return true;
}

/** 重新按当前源图跑一次透明分隔检测。 */
export function redetectSpriteGrid() {
  if (!state.sourceId || !source.value?.imageData) return false;
  return applyDetection({
    width: state.width,
    height: state.height,
    imageData: source.value.imageData,
  });
}

function setMode(mode) {
  state.mode = mode === 'grid' ? 'grid' : 'auto';
}

/** 切换「拆分 / 合并」：合并模式没有播放概念，顺手把动画停掉。 */
function setPane(pane) {
  state.pane = pane === 'merge' ? 'merge' : 'split';
  if (state.pane === 'merge') pause();
}

function setColumns(value) {
  state.columns = Math.max(1, Math.min(SPRITE_MAX_GRID, Math.round(Number(value) || 1)));
}

function setRows(value) {
  state.rows = Math.max(1, Math.min(SPRITE_MAX_GRID, Math.round(Number(value) || 1)));
}

function setFps(value) {
  state.fps = Math.max(1, Math.min(60, Math.round(Number(value) || 1)));
}

function setLoop(value) {
  state.loop = Boolean(value);
}

function select(index) {
  const total = frames.value.length;
  if (!total) return;
  state.selected = Math.max(0, Math.min(total - 1, Math.round(Number(index) || 0)));
}

export function useSprite() {
  return {
    state: readonly(state),
    source,
    frames,
    currentFrame,
    hasSource,
    actions: {
      loadItem: loadSpriteItem,
      redetect: redetectSpriteGrid,
      setMode,
      setPane,
      setColumns,
      setRows,
      setFps,
      setLoop,
      play,
      pause,
      togglePlay,
      step,
      select,
    },
  };
}
