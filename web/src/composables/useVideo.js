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
  extractVideoAudio,
  extractVideoFrames,
  fetchFilmstrip,
  fetchVideoHealth,
  formatDuration,
  probeLibraryVideo,
} from '../lib/library.js';
import { refreshLibrary, setDir as setLibraryDir } from './useLibrary.js';

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
});

/** <video> 元素用 shallowRef 保存，避免 Vue 深度代理 DOM。 */
const player = shallowRef(null);

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

export function addMark(time = state.currentTime) {
  const value = Math.max(0, Math.min(duration.value || 0, Number(time) || 0));
  if (state.marks.some((mark) => Math.abs(mark - value) < 0.02)) {
    setStatus('该时间点已经在标记列表中');
    return;
  }
  state.marks.push(value);
  state.marks.sort((a, b) => a - b);
  setStatus(`已添加标记 ${value.toFixed(2)}s（共 ${state.marks.length} 个）`);
}

export function removeMark(time) {
  const index = state.marks.findIndex((mark) => Math.abs(mark - time) < 0.001);
  if (index >= 0) state.marks.splice(index, 1);
}

export function clearMarks() {
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
      addMarkAtCurrentTime,
      extractFrames,
      extractAudio,
      setPlayer,
      getPlayer,
    },
  };
}
