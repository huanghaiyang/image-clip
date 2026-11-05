/**
 * 视频工作区状态（单例）
 * ----------------------
 * 播放本身交给 `<video>` 元素（Stage 里创建），这里只维护：
 *   - 当前视频与 ffprobe 元信息；
 *   - 完整时间轴所需的胶片帧（服务端 FFmpeg 均匀抽帧）；
 *   - 手动打点 / 间隔 / 数量三种关键帧截取模式；
 *   - 音频提取参数与最近一次输出。
 *
 * 视频必须先进入资源库：播放地址直接使用 `/api/library/file`（支持 Range），
 * 截取出来的 PNG 也默认写回 `关键帧/<视频名>/`，符合“统一资源管理”的定位。
 */
import { computed, markRaw, reactive, readonly, shallowRef } from 'vue';

import {
  cutVideo as cutVideoFile,
  detectVideoWatermark,
  extractVideoAudio,
  extractVideoFrames,
  fetchFilmstrip,
  fetchVideoHealth,
  formatDuration,
  probeLibraryVideo,
  removeVideoWatermark,
} from '../lib/library.js';
import { refreshLibrary, setDir as setLibraryDir } from './useLibrary.js';
import { onLibraryPathsMoved, remapLibraryPath } from '../lib/pathMoves.js';

const state = reactive({
  initialized: false,
  health: { checked: false, ok: false, ffmpeg: null, error: '' },
  activePath: null,
  meta: null,
  loading: false,
  filmstripLoading: false,
  busy: false,
  error: '',
  status: '',
  progress: '',
  currentTime: 0,
  playing: false,
  playbackRate: 1,
  volume: 0.9,
  muted: false,
  filmstrip: [],
  marks: [],
  lastExtract: null,
  options: {
    mode: 'interval', // interval | count | times
    interval: 2,
    count: 10,
    format: 'png',
    width: 0, // 0 = 原始分辨率
    prefix: '',
    dir: '', // 空 = 关键帧/<视频名>
  },
  audio: { format: 'mp3', name: '', dir: '音频' },
  /**
   * 视频裁剪 / 切断 / 水印去除。
   * 裁剪框用 0..1 的归一化坐标（与 Concat 的 Crop 参数一致），
   * 真正发给服务端时才换算成像素，这样窗口尺寸变化不会改变裁剪范围。
   */
  edit: {
    trimStart: 0,
    // 0 = 到结尾；UI 改结束时间时换算成 duration
    trimDuration: 0,
    cropEnabled: false,
    crop: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 },
    watermark: {
      status: 'idle', // idle | detecting | ready | removing
      time: 0,
      preview: null,
      mask: null,
      coverage: 0,
      engineHint: 'unblend',
      params: null,
      engine: 'auto',
      error: '',
      result: null,
    },
    output: { dir: '视频处理', cutName: '', watermarkName: '' },
  },
});

/** <video> 元素用 shallowRef 保存，避免 Vue 深度代理 DOM。 */
const player = shallowRef(null);

/**
 * 资源库改名 / 移动后同步正在打开的视频。
 * 内容没有变化，只更新路径与显示名：不重新探测，时间轴上的关键帧标记也保持不变。
 */
onLibraryPathsMoved((moves) => {
  const next = remapLibraryPath(state.activePath, moves);
  if (next === state.activePath) return;
  state.activePath = next;
  if (state.meta) state.meta = { ...state.meta, name: next.split('/').pop() || state.meta.name };
});

const duration = computed(() => Number(state.meta?.duration) || 0);
const fps = computed(() => Number(state.meta?.fps) || 0);
const videoName = computed(() => state.meta?.name ?? state.activePath?.split('/').pop() ?? '');
const videoBase = computed(() => {
  const name = videoName.value;
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name;
});
const defaultTargetDir = computed(() => `关键帧/${videoBase.value}`);
const targetDir = computed(() => state.options.dir || defaultTargetDir.value);
const hasVideo = computed(() => Boolean(state.activePath && state.meta));
const ffmpegReady = computed(() => Boolean(state.health.ffmpeg?.available));
const manualTimes = computed(() => [...state.marks].sort((a, b) => a - b));
const frameStep = computed(() => (fps.value > 0 ? 1 / fps.value : 1 / 25));
const canExtract = computed(() => ffmpegReady.value && hasVideo.value && !state.busy && Number(state.meta?.duration) > 0);

/** 旋转后用户看到的画面尺寸：裁剪框、水印掩膜都以它为准。 */
const displaySize = computed(() => {
  const meta = state.meta;
  if (!meta) return { width: 0, height: 0 };
  const rotation = Math.abs(Number(meta.rotation) || 0) % 360;
  const swap = rotation === 90 || rotation === 270;
  return { width: Number(swap ? meta.height : meta.width) || 0, height: Number(swap ? meta.width : meta.height) || 0 };
});

/** 切断区间：起止都在 [0, duration] 内，duration=0 表示保留到结尾。 */
const trimRange = computed(() => {
  const total = Number(state.meta?.duration) || 0;
  if (!total) return { start: 0, end: 0, duration: 0 };
  const start = Math.min(Math.max(0, Number(state.edit.trimStart) || 0), Math.max(0, total - 0.05));
  const wanted = Number(state.edit.trimDuration) || 0;
  const end = wanted > 0 ? Math.min(total, start + wanted) : total;
  return { start, end: Math.max(start, end), duration: Math.max(0, end - start) };
});

/** 归一化裁剪框 → 像素；未启用时返回 null。 */
const cropRect = computed(() => {
  if (!state.edit.cropEnabled) return null;
  const size = displaySize.value;
  if (!size.width || !size.height) return null;
  const crop = state.edit.crop;
  return {
    x: Math.round(crop.x * size.width),
    y: Math.round(crop.y * size.height),
    width: Math.round(crop.width * size.width),
    height: Math.round(crop.height * size.height),
  };
});

const editBusy = computed(
  () => state.busy || ['detecting', 'removing'].includes(state.edit.watermark.status),
);
const canEdit = computed(() => ffmpegReady.value && hasVideo.value && !editBusy.value);

function defaultWatermarkState() {
  return {
    status: 'idle',
    time: 0,
    preview: null,
    mask: null,
    coverage: 0,
    engineHint: 'unblend',
    params: null,
    engine: 'auto',
    error: '',
    result: null,
  };
}

/** 切换视频时清空裁剪/水印现场，避免把上一个视频的掩膜用到新视频上。 */
function resetEditState() {
  state.edit.trimStart = 0;
  state.edit.trimDuration = 0;
  state.edit.cropEnabled = false;
  state.edit.crop = { x: 0.08, y: 0.08, width: 0.84, height: 0.84 };
  state.edit.watermark = defaultWatermarkState();
  state.edit.output = { dir: '视频处理', cutName: '', watermarkName: '' };
}

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
  state.status = '';
}

export function setPlayer(element) {
  player.value = element ? markRaw(element) : null;
}

/** 丢弃临时会话时清空视频现场（包括元素上的 src，避免已移除文件继续占用）。 */
export function resetSession() {
  pause();
  const element = player.value;
  if (element) {
    try {
      element.removeAttribute('src');
      element.load();
    } catch {
      /* 元素可能已卸载，忽略 */
    }
  }
  state.activePath = null;
  state.meta = null;
  state.loading = false;
  state.currentTime = 0;
  state.playing = false;
  state.filmstrip = [];
  state.marks = [];
  state.lastExtract = null;
  state.error = '';
  state.status = '';
  state.progress = '';
  resetEditState();
  resetMarkHistory();
}

export function getPlayer() {
  return player.value;
}

export async function checkVideoHealth({ force = false } = {}) {
  if (state.health.checked && !force) return state.health;
  try {
    const payload = await fetchVideoHealth();
    state.health = {
      checked: true,
      ok: Boolean(payload?.ffmpeg?.available),
      ffmpeg: payload?.ffmpeg ?? null,
      error: payload?.ffmpeg?.available ? '' : payload?.ffmpeg?.hint || 'FFmpeg 不可用',
    };
  } catch (err) {
    state.health = {
      checked: true,
      ok: false,
      ffmpeg: null,
      error: `无法连接服务端：${err.message}`,
    };
  }
  return state.health;
}

export async function selectVideo(pathOrEntry) {
  const path = typeof pathOrEntry === 'string' ? pathOrEntry : pathOrEntry?.path;
  if (!path) return null;
  if (state.activePath === path && state.meta) return state.meta;

  pause();
  state.activePath = path;
  state.meta = null;
  state.loading = true;
  state.error = '';
  state.status = '';
  state.currentTime = 0;
  state.playing = false;
  state.filmstrip = [];
  state.marks = [];
  state.lastExtract = null;
  resetEditState();
  resetMarkHistory();

  void checkVideoHealth();

  try {
    const meta = await probeLibraryVideo(path);
    state.meta = meta;
    setStatus(`已载入 ${meta.name} · ${formatDuration(meta.duration)} · ${meta.width || '?'}×${meta.height || '?'}`);
    void loadFilmstrip();
    return meta;
  } catch (err) {
    setError(`读取视频失败：${err.message}`);
    return null;
  } finally {
    state.loading = false;
  }
}

/** 请求服务端均匀抽帧，拼成时间轴缩略图带。 */
export async function loadFilmstrip({ count = 16, width = 160 } = {}) {
  if (!state.activePath || !ffmpegReady.value) return [];
  state.filmstripLoading = true;
  try {
    const payload = await fetchFilmstrip(state.activePath, { count, width });
    state.filmstrip = payload?.frames ?? [];
    return state.filmstrip;
  } catch (err) {
    state.filmstrip = [];
    // 时间轴缩略图失败不阻断播放，只在状态栏给出提示
    console.warn('[video] 时间轴缩略图生成失败:', err.message);
    return [];
  } finally {
    state.filmstripLoading = false;
  }
}

export function setOption(key, value) {
  if (!(key in state.options)) return;
  state.options[key] = value;
}

export function setAudioOption(key, value) {
  if (!(key in state.audio)) return;
  state.audio[key] = value;
}

// --------------------------------------------------------------- 播放控制

export function seekTo(seconds, { play = false } = {}) {
  const max = duration.value || 0;
  const target = Math.min(max, Math.max(0, Number(seconds) || 0));
  state.currentTime = target;
  const element = player.value;
  if (element) {
    try {
      element.currentTime = target;
    } catch {
      /* 元数据未就绪时浏览器会抛错，等 loadedmetadata 后会自动同步 */
    }
    if (play) void element.play().catch(() => {});
  }
}

export function play() {
  const element = player.value;
  if (!element) return;
  void element.play().catch((err) => setError(`播放失败：${err.message}`));
}

export function pause() {
  const element = player.value;
  if (element) element.pause();
  state.playing = false;
}

export function togglePlay() {
  const element = player.value;
  if (!element) return;
  if (element.paused) play();
  else pause();
}

export function stepFrame(direction) {
  pause();
  seekTo(state.currentTime + direction * frameStep.value);
}

export function setPlaybackRate(rate) {
  const value = Math.min(4, Math.max(0.25, Number(rate) || 1));
  state.playbackRate = value;
  if (player.value) player.value.playbackRate = value;
}

export function setVolume(volume) {
  const value = Math.min(1, Math.max(0, Number(volume) || 0));
  state.volume = value;
  state.muted = value === 0;
  if (player.value) {
    player.value.volume = value;
    player.value.muted = state.muted;
  }
}

export function toggleMute() {
  state.muted = !state.muted;
  if (player.value) player.value.muted = state.muted;
}

// --------------------------------------------------------------- 标记点

// --------------------------------------------------------------- 标记历史

const MARK_HISTORY_LIMIT = 40;
const markHistory = reactive([]);
const markRedo = reactive([]);

function pushMarkHistory() {
  markHistory.push([...state.marks]);
  if (markHistory.length > MARK_HISTORY_LIMIT) markHistory.shift();
  markRedo.splice(0, markRedo.length);
}

function resetMarkHistory() {
  markHistory.splice(0, markHistory.length);
  markRedo.splice(0, markRedo.length);
}

export function undoMarks() {
  if (!markHistory.length) return false;
  markRedo.push([...state.marks]);
  state.marks = [...markHistory.pop()];
  setStatus(`已撤销标记操作（共 ${state.marks.length} 个标记）`);
  return true;
}

export function redoMarks() {
  if (!markRedo.length) return false;
  markHistory.push([...state.marks]);
  state.marks = [...markRedo.pop()];
  setStatus(`已重做标记操作（共 ${state.marks.length} 个标记）`);
  return true;
}

const canUndoMarks = computed(() => markHistory.length > 0);
const canRedoMarks = computed(() => markRedo.length > 0);

export function addMark(time = state.currentTime) {
  const value = Math.max(0, Math.min(duration.value || 0, Number(time) || 0));
  if (state.marks.some((mark) => Math.abs(mark - value) < 0.02)) {
    setStatus('该时间点已经在标记列表中');
    return;
  }
  pushMarkHistory();
  state.marks.push(value);
  state.marks.sort((a, b) => a - b);
  setStatus(`已添加标记 ${value.toFixed(2)}s（共 ${state.marks.length} 个）`);
}

export function removeMark(time) {
  const index = state.marks.findIndex((mark) => Math.abs(mark - time) < 0.001);
  if (index < 0) return;
  pushMarkHistory();
  state.marks.splice(index, 1);
}

export function clearMarks() {
  if (!state.marks.length) return;
  pushMarkHistory();
  state.marks = [];
  setStatus('已清空标记点');
}

export function addMarkAtCurrentTime() {
  addMark(state.currentTime);
}

// --------------------------------------------------------------- 截取

export async function extractFrames() {
  if (!state.activePath) {
    setError('请先在左侧选择视频');
    return null;
  }
  if (!ffmpegReady.value) {
    setError(state.health.error || 'FFmpeg 不可用，无法截取关键帧');
    return null;
  }

  const mode = state.options.mode;
  if (mode === 'times' && !state.marks.length) {
    setError('手动截帧模式需要先在时间轴上添加标记点');
    return null;
  }

  state.busy = true;
  state.progress = '正在截取关键帧…';
  setStatus(`正在截取关键帧（${mode === 'times' ? `${state.marks.length} 个时间点` : mode === 'count' ? `${state.options.count} 帧` : `每 ${state.options.interval}s 一帧`}）`);
  try {
    const payload = {
      path: state.activePath,
      mode,
      interval: state.options.interval,
      count: state.options.count,
      times: manualTimes.value,
      format: state.options.format,
      width: state.options.width,
      prefix: state.options.prefix || videoBase.value,
      dir: targetDir.value,
    };
    const result = await extractVideoFrames(payload);
    state.lastExtract = {
      type: 'frames',
      ...result,
      at: Date.now(),
    };
    await refreshLibrary({ quiet: true });
    setLibraryDir(result.folder);
    setStatus(`已截取 ${result.extracted}/${result.requested} 帧 → 资源库/${result.folder}${result.failed ? `（${result.failed} 帧失败）` : ''}`);
    return result;
  } catch (err) {
    setError(`截取关键帧失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
    state.progress = '';
  }
}

export async function extractAudio() {
  if (!state.activePath) {
    setError('请先在左侧选择视频');
    return null;
  }
  if (!ffmpegReady.value) {
    setError(state.health.error || 'FFmpeg 不可用，无法提取音频');
    return null;
  }
  if (state.meta && state.meta.hasAudio === false) {
    setError('该视频没有音轨');
    return null;
  }

  state.busy = true;
  state.progress = '正在提取音频…';
  setStatus(`正在提取音频（${state.audio.format.toUpperCase()}）`);
  try {
    const result = await extractVideoAudio({
      path: state.activePath,
      format: state.audio.format,
      name: state.audio.name || undefined,
      dir: state.audio.dir || '音频',
    });
    state.lastExtract = { type: 'audio', ...result, at: Date.now() };
    await refreshLibrary({ quiet: true });
    setLibraryDir(state.audio.dir || '音频');
    setStatus(`已提取音频 → 资源库/${result.entry?.path ?? ''}`);
    return result;
  } catch (err) {
    setError(`提取音频失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
    state.progress = '';
  }
}

// --------------------------------------------------------------- 裁剪 / 切断 / 水印

export function setEditOption(key, value) {
  if (key === 'trimStart' || key === 'trimDuration') {
    state.edit[key] = Math.max(0, Number(value) || 0);
    return;
  }
  if (key === 'cropEnabled') {
    state.edit.cropEnabled = Boolean(value);
    return;
  }
  if (key in state.edit) state.edit[key] = value;
}

/** 裁剪框按比例设置；保证框在画面内且不小于 5%。 */
export function setCropField(key, value) {
  if (!['x', 'y', 'width', 'height'].includes(key)) return;
  const next = { ...state.edit.crop, [key]: Math.min(1, Math.max(0, Number(value) || 0)) };
  const x = next.x;
  const y = next.y;
  state.edit.crop = {
    x,
    y,
    width: Math.min(1 - x, Math.max(0.05, next.width)),
    height: Math.min(1 - y, Math.max(0.05, next.height)),
  };
}

/** 时间轴上直接指定结束点，内部换算成 duration（0 表示到结尾）。 */
export function setTrimEnd(seconds) {
  const end = Math.max(0, Number(seconds) || 0);
  const total = Number(state.meta?.duration) || 0;
  const start = trimRange.value.start;
  if (!total || end >= total - 0.001) {
    state.edit.trimDuration = 0;
    return;
  }
  state.edit.trimDuration = Math.max(0.05, end - start);
}

export function setOutputOption(key, value) {
  if (!(key in state.edit.output)) return;
  state.edit.output[key] = value;
}

export function setWatermarkEngine(engine) {
  if (!['auto', 'unblend', 'removelogo'].includes(engine)) return;
  state.edit.watermark.engine = engine;
}

export function clearWatermark() {
  state.edit.watermark = defaultWatermarkState();
  if (!state.busy) setStatus('已清除水印检测结果');
}

/** 在当前播放位置（或指定秒数）检测水印。 */
export async function detectWatermark({ time } = {}) {
  if (!state.activePath) {
    setError('请先在左侧选择视频');
    return null;
  }
  if (!ffmpegReady.value) {
    setError(state.health.error || 'FFmpeg 不可用，无法抽帧检测');
    return null;
  }

  const raw = Number.isFinite(Number(time)) ? Number(time) : state.currentTime;
  const at = Math.max(0, Math.min(duration.value || 0, raw));
  const wm = state.edit.watermark;
  wm.status = 'detecting';
  wm.error = '';
  wm.result = null;
  wm.preview = null;
  wm.mask = null;
  pause();
  setStatus(`正在第 ${at.toFixed(2)}s 检测水印…`);
  try {
    const result = await detectVideoWatermark({ path: state.activePath, time: at, analyze: {} });
    wm.time = result.time;
    wm.preview = markRaw(result.preview);
    wm.mask = markRaw(result.mask);
    wm.coverage = result.coverage;
    wm.engineHint = result.engineHint;
    wm.params = markRaw(result.params);
    wm.engine = result.engineHint;
    wm.status = 'ready';
    seekTo(result.time);
    setStatus(
      result.coverage > 0
        ? `检测到水印：覆盖 ${(result.coverage * 100).toFixed(2)}%，建议 ${result.engineHint}`
        : '没有检测到水印：可以换一个时间点重试，或手动调整掩膜',
    );
    return result;
  } catch (err) {
    wm.status = 'idle';
    wm.error = err.message;
    setError(`水印检测失败：${err.message}`);
    return null;
  }
}

/** 按当前掩膜去除整段视频的水印，结果写入资源库。 */
export async function removeWatermark() {
  const wm = state.edit.watermark;
  if (!state.activePath) {
    setError('请先在左侧选择视频');
    return null;
  }
  if (!wm.mask) {
    setError('请先检测水印区域');
    return null;
  }
  if (!ffmpegReady.value) {
    setError(state.health.error || 'FFmpeg 不可用，无法导出视频');
    return null;
  }
  if (editBusy.value) return null;

  state.busy = true;
  wm.status = 'removing';
  wm.error = '';
  setStatus(`正在去除水印（${wm.engine === 'auto' ? '自动选择引擎' : wm.engine}）…`);
  try {
    const result = await removeVideoWatermark({
      path: state.activePath,
      mask: wm.mask,
      engine: wm.engine,
      params: wm.params,
      time: wm.time,
      start: 0,
      duration: 0,
      crop: cropRect.value,
      dir: state.edit.output.dir || '视频处理',
      name: state.edit.output.watermarkName || undefined,
    });
    wm.status = 'ready';
    wm.result = result;
    state.lastExtract = { type: 'watermark', ...result, at: Date.now() };
    await refreshLibrary({ quiet: true });
    setLibraryDir(result.entry?.dir || state.edit.output.dir || '视频处理');
    setStatus(
      `已输出去水印视频（${result.engine}）→ 资源库/${result.entry?.path ?? ''}`,
    );
    return result;
  } catch (err) {
    wm.status = 'ready';
    wm.error = err.message;
    setError(`去除水印失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
    state.progress = '';
  }
}

/** 按切断区间 + 裁剪框导出新视频。 */
export async function cutVideo() {
  if (!state.activePath) {
    setError('请先在左侧选择视频');
    return null;
  }
  if (!ffmpegReady.value) {
    setError(state.health.error || 'FFmpeg 不可用，无法导出视频');
    return null;
  }
  if (editBusy.value) return null;

  const range = trimRange.value;
  const hasTrim = range.start > 0.01 || range.duration < (duration.value || 0) - 0.01;
  if (!hasTrim && !cropRect.value) {
    setError('请先设置切断区间或启用裁剪');
    return null;
  }

  state.busy = true;
  setStatus(`正在导出${hasTrim ? `切断 ${range.start.toFixed(2)}s → ${range.end.toFixed(2)}s` : '裁剪'}…`);
  try {
    const result = await cutVideoFile({
      path: state.activePath,
      start: range.start,
      duration: range.duration,
      crop: cropRect.value,
      dir: state.edit.output.dir || '视频处理',
      name: state.edit.output.cutName || undefined,
    });
    state.lastExtract = { type: 'cut', ...result, at: Date.now() };
    await refreshLibrary({ quiet: true });
    setLibraryDir(result.entry?.dir || state.edit.output.dir || '视频处理');
    setStatus(`已导出裁剪视频 → 资源库/${result.entry?.path ?? ''}`);
    return result;
  } catch (err) {
    setError(`导出视频失败：${err.message}`);
    return null;
  } finally {
    state.busy = false;
    state.progress = '';
  }
}

export function useVideo() {
  return {
    state: readonly(state),
    player,
    duration,
    fps,
    videoName,
    videoBase,
    defaultTargetDir,
    targetDir,
    hasVideo,
    ffmpegReady,
    manualTimes,
    frameStep,
    canExtract,
    displaySize,
    trimRange,
    cropRect,
    editBusy,
    canEdit,
    canUndoMarks,
    canRedoMarks,
    actions: {
      checkHealth: checkVideoHealth,
      selectVideo,
      loadFilmstrip,
      setOption,
      setAudioOption,
      seekTo,
      play,
      pause,
      togglePlay,
      stepFrame,
      setPlaybackRate,
      setVolume,
      toggleMute,
      addMark,
      removeMark,
      clearMarks,
      undoMarks,
      redoMarks,
      resetMarkHistory,
      addMarkAtCurrentTime,
      extractFrames,
      extractAudio,
      setPlayer,
      getPlayer,
      resetSession,
      setEditOption,
      setCropField,
      setTrimEnd,
      setOutputOption,
      setWatermarkEngine,
      clearWatermark,
      detectWatermark,
      removeWatermark,
      cutVideo,
    },
  };
}
