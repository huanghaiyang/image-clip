/**
 * 音频工作区状态（单例）
 * ----------------------
 * 音频一律先进入资源库，再由这里用 fetch 取 Blob → Web Audio 解码成 AudioBuffer。
 * 这样播放、频谱、裁剪全部在前端完成，不依赖 FFmpeg，也不会改动原文件：
 *   - 裁剪只生成新的 WAV，保存到资源库 `音频/`；
 *   - 原文件保持不动，随时可以「还原原始音频」。
 *
 * 播放链路：AudioBufferSourceNode → GainNode → destination。
 * 播放头用 AudioContext.currentTime 推算，不依赖 requestAnimationFrame 的累计误差。
 */
import { computed, markRaw, reactive, readonly, shallowRef } from 'vue';

import {
  computeSpectrogram,
  computeWaveform,
  encodeWav,
  formatAudioClock,
  sliceBuffer,
} from '../lib/audio.js';
import { fetchLibraryBlob, libraryFileUrl } from '../lib/library.js';
import { saveBlobToLibrary } from './useLibrary.js';
import { onLibraryPathsMoved, remapLibraryPath } from '../lib/pathMoves.js';

const state = reactive({
  activePath: null,
  name: '',
  loading: false,
  busy: false,
  error: '',
  status: '',
  duration: 0,
  sampleRate: 0,
  channels: 0,
  selection: { start: 0, end: 0 }, // end <= start 表示没有选区
  playhead: 0,
  playing: false,
  loopSelection: false,
  volume: 1,
  waveform: null,
  spectrum: null,
  outputDir: '音频',
  lastExport: null,
});

/** AudioBuffer 体积大且不需要响应式，放 shallowRef。 */
const bufferRef = shallowRef(null);

/**
 * 资源库改名 / 移动后同步正在打开的音频。
 * 编辑缓冲仍在内存里，只改路径与显示名即可，避免重新解码打断试听。
 */
onLibraryPathsMoved((moves) => {
  const next = remapLibraryPath(state.activePath, moves);
  if (next === state.activePath) return;
  state.activePath = next;
  state.name = next.split('/').pop() || state.name;
});

let audioContext = null;
let gainNode = null;
let sourceNode = null;
let rafId = 0;
let startedAt = 0; // 本次播放开始时的 AudioContext 时间
let startOffset = 0; // 本次播放从 buffer 的哪个位置开始

const duration = computed(() => state.duration);
const hasAudio = computed(() => Boolean(state.activePath && bufferRef.value));
const hasSelection = computed(() => state.selection.end - state.selection.start > 0.001);
const selectionLength = computed(() => Math.max(0, state.selection.end - state.selection.start));
const audioBase = computed(() => {
  const name = state.name || '';
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name || 'audio';
});

function setStatus(message) {
  state.status = message;
  state.error = '';
}

function setError(message) {
  state.error = message;
  state.status = '';
}

function ensureContext() {
  if (!audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audioContext = markRaw(new Ctor());
    gainNode = audioContext.createGain();
    gainNode.gain.value = state.volume;
    gainNode.connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') void audioContext.resume();
  return audioContext;
}

function stopSource() {
  if (!sourceNode) return;
  try {
    sourceNode.onended = null;
    sourceNode.stop();
    sourceNode.disconnect();
  } catch {
    /* 已经停止或已断开，忽略 */
  }
  sourceNode = null;
}

function cancelTick() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/** 播放位置推进：按 AudioContext 时钟计算，并在选区循环时跳回起点。 */
function tick() {
  cancelTick();
  const step = () => {
    rafId = 0;
    if (!state.playing) return;
    const buffer = bufferRef.value;
    if (!buffer) return;
    const elapsed = audioContext.currentTime - startedAt;
    const position = startOffset + elapsed;
    const loop = state.loopSelection && hasSelection.value;
    const loopStart = loop ? state.selection.start : 0;
    const loopEnd = loop ? state.selection.end : buffer.duration;

    if (position >= loopEnd) {
      if (loop) {
        startSource(loopStart);
        return;
      }
      state.playhead = buffer.duration;
      pause();
      return;
    }
    state.playhead = position;
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function startSource(at) {
  const buffer = bufferRef.value;
  if (!buffer) return;
  const ctx = ensureContext();
  stopSource();
  // 选区循环时如果从选区外开始，直接落到选区起点
  let offset = Math.max(0, Math.min(Number(at) || 0, buffer.duration));
  if (state.loopSelection && hasSelection.value && (offset < state.selection.start || offset >= state.selection.end)) {
    offset = state.selection.start;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gainNode);
  source.start(0, offset);
  sourceNode = source;
  startedAt = ctx.currentTime;
  startOffset = offset;
  state.playing = true;
  tick();
}

export function pause() {
  if (!state.playing && !sourceNode) return;
  cancelTick();
  stopSource();
  state.playing = false;
}

export function play() {
  const buffer = bufferRef.value;
  if (!buffer) return;
  const at = state.playhead >= buffer.duration - 0.01 ? 0 : state.playhead;
  startSource(at);
}

export function togglePlay() {
  if (state.playing) pause();
  else play();
}

export function stop() {
  pause();
  state.playhead = 0;
}

export function seek(seconds) {
  const total = bufferRef.value?.duration ?? 0;
  const value = Math.max(0, Math.min(Number(seconds) || 0, total));
  state.playhead = value;
  if (state.playing) startSource(value);
}

export function stepTime(delta) {
  seek(state.playhead + Number(delta || 0));
}

export function setVolume(value) {
  const volume = Math.max(0, Math.min(1, Number(value)));
  state.volume = Number.isFinite(volume) ? volume : 1;
  if (gainNode) gainNode.gain.value = state.volume;
}

export function setLoopSelection(value) {
  state.loopSelection = Boolean(value);
  if (state.loopSelection && state.playing) startSource(state.playhead);
}

/** 设置选区：会自动排序并夹在 [0, duration] 内。 */
export function setSelection(start, end) {
  const total = state.duration || 0;
  const a = Math.max(0, Math.min(Number(start) || 0, total));
  const b = Math.max(0, Math.min(Number(end) || 0, total));
  state.selection = { start: Math.min(a, b), end: Math.max(a, b) };
}

export function clearSelection() {
  state.selection = { start: 0, end: 0 };
}

export function selectAll() {
  state.selection = { start: 0, end: state.duration };
}

/** 解码后重建波形与频谱；裁剪后也要重新计算。 */
function rebuildVisuals() {
  const buffer = bufferRef.value;
  if (!buffer) {
    state.waveform = null;
    state.spectrum = null;
    return;
  }
  state.waveform = computeWaveform(buffer);
  state.spectrum = computeSpectrogram(buffer);
}

/**
 * 选中并解码一份资源库音频。
 * @param {object|string} entryOrPath 资源库条目或相对路径
 * @param {{force?: boolean}} [options] force=true 时重新从磁盘读取（还原原文件）
 */
export async function selectAudio(entryOrPath, options = {}) {
  const path = typeof entryOrPath === 'string' ? entryOrPath : entryOrPath?.path;
  if (!path) return null;
  if (!options.force && state.activePath === path && bufferRef.value) return bufferRef.value;

  pause();
  cancelTick();
  state.activePath = path;
  state.name = entryOrPath?.name ?? decodeURIComponent(path.split('/').pop() || path);
  state.loading = true;
  state.error = '';
  state.status = '';
  state.playing = false;
  state.playhead = 0;
  state.duration = 0;
  state.sampleRate = 0;
  state.channels = 0;
  state.selection = { start: 0, end: 0 };
  state.lastExport = null;
  bufferRef.value = null;
  rebuildVisuals();

  try {
    // 条目可能还没出现在资源库列表里，这里按路径拼 Range 地址兜底
    const url = typeof entryOrPath === 'string' ? `/api/library/file?path=${encodeURIComponent(path)}` : libraryFileUrl(entryOrPath);
    const blob = await fetchLibraryBlob(url);
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = ensureContext();
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

    bufferRef.value = buffer;
    state.duration = buffer.duration;
    state.sampleRate = buffer.sampleRate;
    state.channels = buffer.numberOfChannels;
    state.selection = { start: 0, end: buffer.duration };
    state.playhead = 0;
    rebuildVisuals();
    setStatus(`已载入 ${state.name} · ${formatAudioClock(buffer.duration)} · ${(buffer.sampleRate / 1000).toFixed(1)}kHz`);
    return buffer;
  } catch (err) {
    const hint = err?.name === 'EncodingError' ? '浏览器无法解码该格式，请换成 WAV/MP3/M4A' : err.message;
    setError(`读取音频失败：${hint}`);
    return null;
  } finally {
    state.loading = false;
  }
}

/** 还原原始音频：重新从资源库读取当前文件。 */
export function reloadOriginal() {
  if (!state.activePath) return null;
  return selectAudio(state.activePath, { force: true });
}

/**
 * 裁剪当前音频。
 * save=true 时同时把 PCM16 WAV 写入资源库（默认 `音频/`），并把编辑缓冲替换为裁剪结果；
 * save=false 只在内存中裁剪，方便先试听后保存。
 */
export async function applyTrim({ save = true } = {}) {
  const buffer = bufferRef.value;
  if (!buffer) {
    setError('请先从左侧选择音频');
    return false;
  }
  if (!hasSelection.value || selectionLength.value < 0.05) {
    setError('选区太短：请先在时间轴上拖出要保留的区间');
    return false;
  }

  const start = state.selection.start;
  const end = state.selection.end;
  state.busy = true;
  state.error = '';
  try {
    const clipped = sliceBuffer(buffer, start, end);

    if (save) {
      const blob = encodeWav(clipped);
      const dir = state.outputDir?.trim() || '音频';
      const name = `${audioBase.value}-clip.wav`;
      const entry = await saveBlobToLibrary(blob, name, dir);
      state.lastExport = { path: entry?.path ?? `${dir}/${name}`, name, bytes: blob.size, dir };
    }

    pause();
    bufferRef.value = clipped;
    state.duration = clipped.duration;
    state.sampleRate = clipped.sampleRate;
    state.channels = clipped.numberOfChannels;
    state.playhead = 0;
    state.selection = { start: 0, end: clipped.duration };
    rebuildVisuals();

    const range = `${formatAudioClock(start)} – ${formatAudioClock(end)}`;
    setStatus(
      save
        ? `已裁剪 ${range} 并保存到资源库/${state.lastExport?.dir ?? '音频'}`
        : `已裁剪 ${range}（未保存，可继续试听后保存）`,
    );
    return true;
  } catch (err) {
    setError(`裁剪失败：${err.message}`);
    return false;
  } finally {
    state.busy = false;
  }
}

/** 导出当前编辑中的音频为 WAV，走浏览器下载。 */
export function exportWav() {
  const buffer = bufferRef.value;
  if (!buffer) {
    setError('请先从左侧选择音频');
    return null;
  }
  const blob = encodeWav(buffer);
  return { blob, name: `${audioBase.value}.wav` };
}

export function useAudio() {
  return {
    state: readonly(state),
    duration,
    hasAudio,
    hasSelection,
    selectionLength,
    audioBase,
    actions: {
      selectAudio,
      play,
      pause,
      togglePlay,
      stop,
      seek,
      stepTime,
      setVolume,
      setLoopSelection,
      setSelection,
      clearSelection,
      selectAll,
      applyTrim,
      exportWav,
      reloadOriginal,
      setOutputDir: (value) => {
        state.outputDir = String(value ?? '');
      },
    },
  };
}
