<script setup>
/**
 * 历史版本对比对话框
 * ----------------
 * 资源库覆盖上传 / 「保存到当前素材」会先把旧内容留成历史版本（服务端 .versions/）。
 * 这个对话框把「选中的历史版本」与「当前文件」放在一起比：
 *
 *  - 图片：中间滑块（左右擦除）+ 并排 + 差异图三种模式；
 *          两张同尺寸时逐像素求差，给出差异像素数 / 占比 / 平均差 / 最大差 / alpha 变化；
 *  - 视频：两个 <video> 同步播放，中间滑块擦除对比，支持逐帧步进（←/→）与时间码；
 *  - 音频：把两份音频解码成波形（每列 min/max/RMS），双泳道 + 差异泳道对照。
 *
 * 版本列表在左侧，点一行就切换对比对象；「互换左右」可以把当前文件放到左边。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { fetchLibraryBlob, formatDuration, formatSize, libraryFileUrl, probeLibraryVideo, videoFrameUrl } from '../lib/library.js';
import {
  buildAudioPeaks,
  comparePeaks,
  diffImageData,
  formatFrameTime,
  formatPercent,
  frameAt,
  frameTime,
} from '../lib/versionCompare.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  entry: { type: Object, default: null },
  versions: { type: Array, default: () => [] },
  initialVersionId: { type: String, default: '' },
});
const emit = defineEmits(['close']);

/** 逐像素统计的像素上限：再大就只给滑块/并排，避免主线程卡住（约 12M 像素）。 */
const MAX_DIFF_PIXELS = 12_000_000;
/** 波形列数：够细腻又不至于每帧画太多。 */
const WAVE_COLUMNS = 1600;

const rootEl = ref(null);
const stageEl = ref(null);
const splitEl = ref(null);
const diffCanvas = ref(null);
const waveCanvas = ref(null);
const frameElA = ref(null);
const frameElB = ref(null);

const selectedId = ref('');
const swap = ref(false);
const mode = ref('split'); // image: split | side | diff
const split = ref(0.5);
const dragging = ref(false);
const loading = ref(false);
const error = ref('');
const hint = ref('');

const image = ref({ a: null, b: null, urlA: '', urlB: '', stats: null, note: '', diffCanvas: null });
/**
 * 视频逐帧比对：不直接播放 <video>，而是让服务端把指定时刻解码成 JPEG，
 * 两张 <img> 叠在一起做滑块 / 并排，再在 canvas 上算这一帧的像素差。
 * 好处：HEVC / ProRes 等浏览器解不了的格式也能比，帧号也完全确定。
 */
const video = ref({
  fps: 0,
  duration: 0,
  time: 0,
  width: 640,
  metaA: null,
  metaB: null,
  note: '',
  urls: { a: '', b: '' },
  loaded: { a: false, b: false },
  sizeA: null,
  sizeB: null,
  stats: null,
  playing: false,
});
const audio = ref({
  peaksA: null,
  peaksB: null,
  stats: null,
  buffers: { a: null, b: null },
  durationA: 0,
  durationB: 0,
  sampleRate: 0,
  channelsA: 0,
  channelsB: 0,
  playhead: 0,
  playing: false,
  side: 'b',
});

const kind = computed(() => props.entry?.kind ?? '');
const kindLabel = computed(() => ({ image: '图片', video: '视频', audio: '音频' }[kind.value] ?? '文件'));
const hasVersions = computed(() => (props.versions ?? []).length > 0);

/** 左边永远放「选中的历史版本」，右边放「当前文件」；互换只影响展示顺序。 */
const currentRow = computed(() => ({
  id: 'current',
  label: '当前文件',
  at: props.entry?.mtime ?? 0,
  bytes: props.entry?.bytes ?? 0,
  url: props.entry ? libraryFileUrl(props.entry) : '',
  path: props.entry?.path ?? '',
}));
const rows = computed(() => {
  const list = [];
  for (const version of props.versions ?? []) {
    list.push({ id: version.id, label: '历史版本', at: version.at, bytes: version.bytes, url: version.url, path: version.path });
  }
  list.push(currentRow.value);
  return list;
});
const selectedRow = computed(() => rows.value.find((row) => row.id === selectedId.value) ?? rows.value[0] ?? null);
const leftRow = computed(() => (swap.value ? currentRow.value : selectedRow.value));
const rightRow = computed(() => (swap.value ? selectedRow.value : currentRow.value));
/** 左右两侧的显示标签（互换后跟着换，别让 badge 说反话）。 */
const leftLabel = computed(() => (leftRow.value?.id === 'current' ? '当前文件' : `历史版本 · ${prettyTime(leftRow.value?.at)}`));
const rightLabel = computed(() => (rightRow.value?.id === 'current' ? '当前文件' : `历史版本 · ${prettyTime(rightRow.value?.at)}`));
const sameSize = computed(() => image.value.a && image.value.b && image.value.a.width === image.value.b.width && image.value.a.height === image.value.b.height);

const imageStatsText = computed(() => {
  const stats = image.value.stats;
  if (!stats) return '';
  if (!stats.diffPixels) return `逐像素一致（阈值内 0 处不同）· ${stats.totalPixels.toLocaleString()} 像素`;
  return `差异 ${stats.diffPixels.toLocaleString()} 像素 · 占比 ${formatPercent(stats.ratio)} · 平均差 ${stats.meanDelta.toFixed(1)} · 最大差 ${stats.maxDelta}`;
});

const audioStatsText = computed(() => {
  const stats = audio.value.stats;
  if (!stats) return '';
  if (!stats.changedColumns) return '波形一致（各列能量相同）';
  const at = audio.value.durationB ? (stats.maxDeltaIndex / Math.max(1, stats.columns)) * audio.value.durationB : 0;
  return `变化列 ${stats.changedColumns}/${stats.columns} · 最大能量差 ${formatPercent(stats.maxDelta)} @ ${formatFrameTime(at)}`;
});

const videoStatsText = computed(() => {
  const v = video.value;
  if (!v.metaA || !v.metaB) return '';
  const parts = [
    `${v.fps ? `${v.fps.toFixed(2)} fps` : '帧率未知'}`,
    `${formatFrameTime(v.time, v.fps)} / 帧 ${frameAt(v.time, v.fps)}`,
  ];
  if (v.metaA.width && v.metaB.width) parts.push(`${v.metaA.width}×${v.metaA.height} vs ${v.metaB.width}×${v.metaB.height}`);
  if (v.stats) {
    parts.push(v.stats.diffPixels ? `本帧差异 ${v.stats.diffPixels.toLocaleString()} 像素（${formatPercent(v.stats.ratio)}）` : '本帧逐像素一致');
  } else if (v.sizeA && v.sizeB && (v.sizeA.width !== v.sizeB.width || v.sizeA.height !== v.sizeB.height)) {
    parts.push('帧尺寸不同，无法逐像素统计');
  }
  if (v.metaA.duration && v.metaB.duration && Math.abs(v.metaA.duration - v.metaB.duration) > 0.05) {
    parts.push(`时长差 ${Math.abs(v.metaA.duration - v.metaB.duration).toFixed(2)}s`);
  }
  return parts.join(' · ');
});

function prettyTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function close() {
  cleanup();
  emit('close');
}

function selectRow(id) {
  if (selectedId.value === id) return;
  selectedId.value = id;
  void load();
}

// --------------------------------------------------------------- 图片
async function loadImages() {
  image.value = { a: null, b: null, urlA: '', urlB: '', stats: null, note: '', diffCanvas: null };
  const [aBlob, bBlob] = await Promise.all([fetchLibraryBlob(leftRow.value.url), fetchLibraryBlob(rightRow.value.url)]);
  const [a, b] = await Promise.all([createImageBitmap(aBlob), createImageBitmap(bBlob)]);
  image.value = {
    a,
    b,
    urlA: URL.createObjectURL(aBlob),
    urlB: URL.createObjectURL(bBlob),
    stats: null,
    note: '',
    diffCanvas: null,
  };

  if (a.width !== b.width || a.height !== b.height) {
    image.value.note = `尺寸不同：历史版本 ${a.width}×${a.height}，当前 ${b.width}×${b.height}。无法逐像素对齐，只提供滑块 / 并排查看。`;
    mode.value = 'side';
    return;
  }
  if (a.width * a.height > MAX_DIFF_PIXELS) {
    image.value.note = `图片 ${a.width}×${a.height} 共 ${(a.width * a.height / 1e6).toFixed(1)}M 像素，超过逐像素统计上限，仅提供滑块 / 并排查看。`;
    return;
  }
  const stats = diffImageData(readPixels(a), readPixels(b), { width: a.width, height: a.height });
  const canvas = document.createElement('canvas');
  canvas.width = stats.width;
  canvas.height = stats.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(stats.diff), stats.width, stats.height), 0, 0);
  image.value = { ...image.value, stats, diffCanvas: canvas };
}

function readPixels(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

async function drawDiff() {
  const canvas = diffCanvas.value;
  const source = image.value.diffCanvas;
  if (!canvas || !source) return;
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
}

// --------------------------------------------------------------- 视频
/** 一帧的 URL：带 mtime 做缓存键变更，换宽度/版本都安全。 */
function frameSrc(row, time) {
  if (!row?.path) return '';
  return videoFrameUrl(row.path, time, { width: video.value.width, version: row.at });
}

let playTimer = 0;

async function loadVideo() {
  stopFramePlay();
  video.value = {
    fps: 0,
    duration: 0,
    time: 0,
    width: video.value.width || 640,
    metaA: null,
    metaB: null,
    note: '',
    urls: { a: '', b: '' },
    loaded: { a: false, b: false },
    sizeA: null,
    sizeB: null,
    stats: null,
    playing: false,
  };
  const probes = await Promise.all([
    probeLibraryVideo(leftRow.value.path).catch(() => null),
    probeLibraryVideo(rightRow.value.path).catch(() => null),
  ]);
  const fps = Number(probes[0]?.fps || probes[1]?.fps || 0);
  const durA = Number(probes[0]?.duration || 0);
  const durB = Number(probes[1]?.duration || 0);
  video.value.fps = fps;
  video.value.duration = Math.min(...[durA, durB].filter((value) => value > 0), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(video.value.duration)) video.value.duration = Math.max(durA, durB, 0);
  video.value.metaA = probes[0];
  video.value.metaB = probes[1];
  if (durA && durB && Math.abs(durA - durB) > 0.05) {
    video.value.note = `两个版本时长不同（${durA.toFixed(2)}s / ${durB.toFixed(2)}s），对比取较短的 ${video.value.duration.toFixed(2)}s。`;
  }
  applyFrame(0);
}

/** 切到某个时刻：两张帧图同时换源，预取相邻帧，加载齐了再算像素差。 */
function applyFrame(seconds) {
  const v = video.value;
  v.time = Math.max(0, Math.min(Number(seconds) || 0, v.duration || Number(seconds) || 0));
  v.loaded = { a: false, b: false };
  v.stats = null;
  v.urls = { a: frameSrc(leftRow.value, v.time), b: frameSrc(rightRow.value, v.time) };
}

/**
 * 预取相邻帧，让逐帧步进更顺。
 * 只在当前帧两张图都加载完之后才做：否则预取会跟可见帧抢抽帧并发槽，反而更慢。
 */
function prefetchFrame() {
  const v = video.value;
  if (!v.duration || v.playing) return;
  const step = 1 / (v.fps || 30);
  for (const delta of [step, -step]) {
    const target = v.time + delta;
    if (target < 0 || target > v.duration) continue;
    for (const row of [leftRow.value, rightRow.value]) {
      const img = new Image();
      img.src = frameSrc(row, target);
    }
  }
}

function onFrameLoad(side) {
  video.value.loaded = { ...video.value.loaded, [side]: true };
  const img = side === 'a' ? frameElA.value : frameElB.value;
  if (img?.naturalWidth) {
    const box = { width: img.naturalWidth, height: img.naturalHeight };
    if (side === 'a') video.value.sizeA = box;
    else video.value.sizeB = box;
  }
  if (video.value.loaded.a && video.value.loaded.b) {
    computeFrameStats();
    prefetchFrame();
  }
}

function onFrameError(side) {
  video.value.note = `取帧失败（${side === 'a' ? '历史版本' : '当前文件'}），请确认服务端 FFmpeg 可用。`;
}

/** 两帧尺寸一致时逐像素求差：逐帧比对除了看画面，也能看到这一帧改了多少。 */
function computeFrameStats() {
  const v = video.value;
  const a = frameElA.value;
  const b = frameElB.value;
  if (!a?.naturalWidth || !b?.naturalWidth) return;
  if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) {
    v.stats = null;
    return;
  }
  const width = a.naturalWidth;
  const height = a.naturalHeight;
  if (width * height > 2_000_000) {
    v.stats = null;
    return;
  }
  try {
    const pixelsA = readPixels(a);
    const pixelsB = readPixels(b);
    v.stats = diffImageData(pixelsA, pixelsB, { width, height });
  } catch {
    v.stats = null;
  }
}

function stepFrame(delta) {
  stopFramePlay();
  const fps = video.value.fps || 30;
  const index = frameAt(video.value.time, fps) + delta;
  applyFrame(frameTime(Math.max(0, index), fps));
}

function onTimelineInput(event) {
  stopFramePlay();
  applyFrame(Number(event.target.value));
}

/** 自动连播：按不超过 10 帧/秒的节奏逐帧取图，避免请求堆积。 */
function toggleFramePlay() {
  if (video.value.playing) {
    stopFramePlay();
    return;
  }
  const fps = Math.min(10, video.value.fps || 10);
  video.value.playing = true;
  const step = 1 / fps;
  playTimer = window.setInterval(() => {
    const next = video.value.time + step;
    if (next > video.value.duration) {
      stopFramePlay();
      return;
    }
    applyFrame(next);
  }, Math.max(80, 1000 / fps));
}

function stopFramePlay() {
  if (playTimer) {
    window.clearInterval(playTimer);
    playTimer = 0;
  }
  video.value.playing = false;
}

// --------------------------------------------------------------- 音频
let audioContext = null;
let audioSource = null;
let audioStartedAt = 0;
let audioOffset = 0;
let audioTimer = 0;

function ensureAudioContext() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

function channelList(buffer) {
  const list = [];
  for (let i = 0; i < buffer.numberOfChannels; i += 1) list.push(buffer.getChannelData(i));
  return list;
}

async function loadAudio() {
  audio.value = {
    peaksA: null,
    peaksB: null,
    stats: null,
    buffers: { a: null, b: null },
    durationA: 0,
    durationB: 0,
    sampleRate: 0,
    channelsA: 0,
    channelsB: 0,
    playhead: 0,
    playing: false,
    side: 'b',
  };
  const ctx = ensureAudioContext();
  const [aBytes, bBytes] = await Promise.all([
    fetchLibraryBlob(leftRow.value.url).then((blob) => blob.arrayBuffer()),
    fetchLibraryBlob(rightRow.value.url).then((blob) => blob.arrayBuffer()),
  ]);
  const [bufA, bufB] = await Promise.all([ctx.decodeAudioData(aBytes.slice(0)), ctx.decodeAudioData(bBytes.slice(0))]);
  const peaksA = buildAudioPeaks(channelList(bufA), { columns: WAVE_COLUMNS, sampleRate: bufA.sampleRate, duration: bufA.duration });
  const peaksB = buildAudioPeaks(channelList(bufB), { columns: WAVE_COLUMNS, sampleRate: bufB.sampleRate, duration: bufB.duration });
  audio.value = {
    ...audio.value,
    buffers: { a: bufA, b: bufB },
    peaksA,
    peaksB,
    stats: comparePeaks(peaksA, peaksB),
    durationA: bufA.duration,
    durationB: bufB.duration,
    sampleRate: bufB.sampleRate,
    channelsA: peaksA.channels,
    channelsB: peaksB.channels,
  };
  await nextTick();
  drawWaveform();
}

function drawWaveform() {
  const canvas = waveCanvas.value;
  const wrap = stageEl.value;
  if (!canvas || !wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(220, wrap.clientWidth - 24);
  const cssH = Math.max(180, wrap.clientHeight - 24);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const peaksA = audio.value.peaksA;
  const peaksB = audio.value.peaksB;
  if (!peaksA || !peaksB) return;

  const padX = 12;
  const padY = 10;
  const gap = 10;
  // 差异泳道 + 时间刻度先占位，剩下的高度才给两条波形泳道，避免它们被画到画布外面
  const axisH = 22;
  const diffH = Math.max(40, Math.min(96, Math.round(cssH * 0.16)));
  const laneH = Math.max(40, Math.floor((cssH - padY * 2 - gap * 2 - diffH - axisH) / 2));
  const width = cssW - padX * 2;
  const total = Math.max(audio.value.durationA, audio.value.durationB, 0.001);
  const colors = {
    a: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0d99ff',
    b: getComputedStyle(document.documentElement).getPropertyValue('--ok').trim() || '#14ae5c',
    diff: getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#f24822',
    muted: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#a0a0a0',
    border: getComputedStyle(document.documentElement).getPropertyValue('--border-strong').trim() || '#4a4a4a',
  };

  const lanes = [
    { key: 'a', peaks: peaksA, y: padY, color: colors.a, label: leftLabel.value },
    { key: 'b', peaks: peaksB, y: padY + laneH + gap, color: colors.b, label: rightLabel.value },
  ];

  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'top';
  for (const lane of lanes) {
    const center = lane.y + laneH / 2;
    // 背景 + 中线
    ctx.fillStyle = 'rgba(127,127,127,0.10)';
    ctx.fillRect(padX, lane.y, width, laneH);
    ctx.strokeStyle = colors.border;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(padX, center);
    ctx.lineTo(padX + width, center);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const drawn = Math.min(lane.peaks.columns, Math.floor((width / total) * (lane.peaks.duration || total)));
    const scaleX = width / total;
    ctx.fillStyle = lane.color;
    ctx.globalAlpha = 0.85;
    for (let column = 0; column < lane.peaks.columns; column += 1) {
      const x = padX + (column / lane.peaks.columns) * (lane.peaks.duration || total) * scaleX;
      if (x > padX + width) break;
      const min = lane.peaks.min[column];
      const max = lane.peaks.max[column];
      const top = center - Math.max(0.02, max) * (laneH / 2 - 2);
      const bottom = center - Math.min(-0.02, min) * (laneH / 2 - 2);
      ctx.fillRect(x, top, Math.max(1, width / lane.peaks.columns), Math.max(1, bottom - top));
    }
    ctx.globalAlpha = 1;
    const labelWidth = ctx.measureText(lane.label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(padX + 1, lane.y + 1, labelWidth + 6, 14);
    ctx.fillStyle = colors.muted;
    ctx.fillText(lane.label, padX + 3, lane.y + 2);
    void drawn;
  }

  // 差异泳道：两列 RMS 差的绝对值（紧接两条泳道之后）
  const diffY = padY + laneH * 2 + gap * 2;
  ctx.fillStyle = 'rgba(127,127,127,0.08)';
  ctx.fillRect(padX, diffY, width, diffH);
  ctx.strokeStyle = colors.border;
  ctx.globalAlpha = 0.4;
  ctx.strokeRect(padX, diffY, width, diffH);
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.diff;
  const stats = audio.value.stats;
  const columns = Math.min(peaksA.columns, peaksB.columns);
  for (let column = 0; column < columns; column += 1) {
    const delta = Math.abs((peaksA.rms[column] ?? 0) - (peaksB.rms[column] ?? 0));
    const h = Math.min(1, delta / 0.5) * (diffH - 2);
    const x = padX + (column / columns) * width;
    ctx.fillRect(x, diffY + diffH - 1 - h, Math.max(1, width / columns), Math.max(1, h));
  }
  ctx.fillStyle = colors.muted;
  ctx.fillText('差异（RMS 能量）', padX + 2, diffY + diffH + 2);
  void stats;

  // 时间刻度
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i += 1) {
    const t = (total * i) / 4;
    const x = padX + (i / 4) * width;
    ctx.fillText(formatFrameTime(t), x, diffY + diffH + 14);
  }
  ctx.textAlign = 'left';

  // 播放头
  const playheadX = padX + (audio.value.playhead / total) * width;
  ctx.strokeStyle = colors.a;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(playheadX, padY);
  ctx.lineTo(playheadX, diffY + diffH);
  ctx.stroke();
}

function onWavePointer(event) {
  const canvas = waveCanvas.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - 12) / Math.max(1, rect.width - 24)));
  const total = Math.max(audio.value.durationA, audio.value.durationB, 0.001);
  audio.value.playhead = ratio * total;
  if (audio.value.playing) {
    stopAudio();
    playAudio();
  }
  drawWaveform();
}

function playAudio() {
  const buffer = audio.value.side === 'a' ? audio.value.buffers.a : audio.value.buffers.b;
  if (!buffer) return;
  const ctx = ensureAudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  stopAudio();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const offset = Math.min(audio.value.playhead, Math.max(0, buffer.duration - 0.01));
  audioOffset = offset;
  audioStartedAt = ctx.currentTime;
  audioSource = source;
  source.start(0, offset);
  audio.value.playing = true;
  source.onended = () => {
    if (audioSource !== source) return;
    audio.value.playing = false;
    audioSource = null;
    audio.value.playhead = 0;
    drawWaveform();
  };
  const tick = () => {
    if (!audio.value.playing || audioSource !== source) return;
    const position = Math.min(buffer.duration, audioOffset + (ctx.currentTime - audioStartedAt));
    audio.value.playhead = position;
    drawWaveform();
    if (position >= buffer.duration - 0.01) {
      audio.value.playing = false;
      return;
    }
    audioTimer = requestAnimationFrame(tick);
  };
  audioTimer = requestAnimationFrame(tick);
}

function stopAudio() {
  cancelAnimationFrame(audioTimer);
  if (audioSource) {
    try {
      audioSource.onended = null;
      audioSource.stop();
    } catch {
      /* 已经结束 */
    }
    audioSource.disconnect?.();
    audioSource = null;
  }
  audio.value.playing = false;
}

function toggleAudioPlay() {
  if (audio.value.playing) {
    audioOffset = audio.value.playhead;
    stopAudio();
    return;
  }
  playAudio();
}

function setAudioSide(side) {
  const wasPlaying = audio.value.playing;
  stopAudio();
  audio.value.side = side;
  if (wasPlaying) playAudio();
}

// --------------------------------------------------------------- 滑块
function onSplitPointerDown(event) {
  dragging.value = true;
  updateSplitFromEvent(event);
  window.addEventListener('pointermove', onSplitPointerMove);
  window.addEventListener('pointerup', onSplitPointerUp, { once: true });
}

function onSplitPointerMove(event) {
  if (!dragging.value) return;
  updateSplitFromEvent(event);
}

function onSplitPointerUp() {
  dragging.value = false;
  window.removeEventListener('pointermove', onSplitPointerMove);
}

function updateSplitFromEvent(event) {
  const el = splitEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return;
  split.value = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
}

// --------------------------------------------------------------- 加载 / 清理
let loadSeq = 0;

async function load() {
  // 连点版本行时可能有多个加载在飞：只让最后一次的结果生效
  const seq = ++loadSeq;
  cleanup();
  const target = selectedRow.value;
  if (!props.entry || !target) return;
  loading.value = true;
  error.value = '';
  hint.value = '';
  try {
    if (kind.value === 'image') await loadImages();
    else if (kind.value === 'video') await loadVideo();
    else if (kind.value === 'audio') await loadAudio();
    else error.value = '该类型暂不支持历史版本对比。';
    if (seq !== loadSeq) return;
    if (kind.value === 'image') {
      mode.value = image.value.stats || sameSize.value ? mode.value || 'split' : 'side';
      await nextTick();
      if (seq !== loadSeq) return;
      void drawDiff();
    }
  } catch (err) {
    if (seq === loadSeq) error.value = err?.message ? `加载对比失败：${err.message}` : '加载对比失败';
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

function cleanup(revoke = true) {
  stopAudio();
  stopFramePlay();
  if (revoke) {
    for (const url of [image.value.urlA, image.value.urlB]) if (url) URL.revokeObjectURL(url);
  }
  for (const bitmap of [image.value.a, image.value.b]) bitmap?.close?.();
  image.value = { a: null, b: null, urlA: '', urlB: '', stats: null, note: '', diffCanvas: null };
  video.value = { ...video.value, urls: { a: '', b: '' }, loaded: { a: false, b: false }, sizeA: null, sizeB: null, stats: null, playing: false, time: 0 };
  audio.value = { ...audio.value, peaksA: null, peaksB: null, stats: null, buffers: { a: null, b: null }, playing: false, playhead: 0 };
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      cleanup();
      return;
    }
    const next = props.initialVersionId || props.versions?.[0]?.id || 'current';
    const changed = selectedId.value !== next;
    selectedId.value = next;
    mode.value = 'split';
    split.value = 0.5;
    swap.value = false;
    // selectedId 变了会由下面的 watch 触发加载，这里不重复触发（否则两次加载互相覆盖）
    if (!changed) void load();
    void nextTick(() => rootEl.value?.focus());
  },
  { immediate: true },
);

watch(selectedId, () => {
  if (props.open) void load();
});

watch(swap, () => {
  if (props.open) void load();
});

// 历史版本列表可能被外部刷新（恢复版本会新增一版）：选中的那版没了就退到最新一版
watch(
  () => props.versions,
  () => {
    if (!props.open) return;
    if (!rows.value.some((row) => row.id === selectedId.value)) {
      const next = props.versions?.[0]?.id ?? 'current';
      const changed = selectedId.value !== next;
      selectedId.value = next;
      if (!changed) void load();
    }
  },
  { deep: false },
);

watch(mode, async (value) => {
  if (!props.open || kind.value !== 'image') return;
  if (value === 'diff') {
    await nextTick();
    void drawDiff();
  }
});

function onResize() {
  if (!props.open) return;
  if (kind.value === 'audio') drawWaveform();
}

window.addEventListener('resize', onResize);

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (kind.value === 'audio' && event.key === ' ') {
    event.preventDefault();
    toggleAudioPlay();
    return;
  }
  if (kind.value === 'video') {
    if (event.key === ' ') {
      event.preventDefault();
      toggleFramePlay();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      stepFrame(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    split.value = Math.max(0, Math.min(1, split.value + (event.key === 'ArrowLeft' ? -0.02 : 0.02)));
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  window.removeEventListener('pointermove', onSplitPointerMove);
  cleanup();
  if (audioContext) {
    void audioContext.close().catch(() => {});
    audioContext = null;
  }
});
</script>

<template>
  <Teleport to="body">
    <Transition name="vc-modal">
      <div v-if="open" ref="rootEl" class="vc-mask" tabindex="-1" @click.self="close" @keydown="onKeydown">
        <div class="vc-dialog" role="dialog" aria-modal="true" :aria-label="`历史版本对比：${entry?.name ?? ''}`">
          <header class="vc-head">
            <div class="vc-heading">
              <span class="vc-kind">{{ kindLabel }}</span>
              <h2 :title="entry?.name">{{ entry?.name ?? '历史版本对比' }}</h2>
              <span v-if="selectedRow && selectedRow.id !== 'current'" class="chip">{{ prettyTime(selectedRow.at) }}</span>
            </div>
            <div class="vc-head-actions">
              <span v-if="image.stats || imageStatsText" class="vc-stat mono">{{ imageStatsText }}</span>
              <button class="btn is-mini" type="button" title="把当前文件放到左侧" @click="swap = !swap">互换左右</button>
              <button class="vc-close" type="button" title="关闭 (Esc)" @click="close">×</button>
            </div>
          </header>

          <div class="vc-body">
            <aside class="vc-side">
              <div class="vc-side-title">对比版本 <span class="muted mono">{{ versions.length }}</span></div>
              <button
                v-for="row in rows"
                :key="row.id"
                class="vc-row"
                :class="{ 'is-active': row.id === selectedId }"
                type="button"
                @click="selectRow(row.id)"
              >
                <span class="vc-row-tag" :class="row.id === 'current' ? 'is-current' : ''">{{ row.id === 'current' ? '当前' : '历史' }}</span>
                <span class="vc-row-time mono">{{ prettyTime(row.at) }}</span>
                <span class="vc-row-size mono">{{ formatSize(row.bytes) }}</span>
              </button>
              <p v-if="!hasVersions" class="vc-hint">还没有历史版本。覆盖上传或「保存到当前素材」时会自动留档。</p>
              <p v-else class="vc-hint">左：选中的历史版本 · 右：当前文件。视频可用 ←/→ 逐帧步进。</p>
            </aside>

            <section ref="stageEl" class="vc-stage">
              <div v-if="loading" class="vc-loading">正在加载两份文件…</div>
              <div v-else-if="error" class="vc-error">{{ error }}</div>

              <!-- 图片 -->
              <template v-else-if="kind === 'image'">
                <div class="vc-toolbar">
                  <div class="vc-tabs">
                    <button class="vc-tab" :class="{ 'is-on': mode === 'split' }" type="button" @click="mode = 'split'">中间滑块</button>
                    <button class="vc-tab" :class="{ 'is-on': mode === 'side' }" type="button" @click="mode = 'side'">并排</button>
                    <button class="vc-tab" :class="{ 'is-on': mode === 'diff' }" type="button" :disabled="!image.stats" @click="mode = 'diff'">差异图</button>
                  </div>
                  <span class="vc-meta mono">
                    {{ image.a?.width }}×{{ image.a?.height }} vs {{ image.b?.width }}×{{ image.b?.height }}
                  </span>
                </div>

                <div v-if="mode === 'diff'" class="vc-diff-wrap">
                  <canvas ref="diffCanvas" class="vc-diff-canvas"></canvas>
                  <p class="vc-legend">白色越亮表示该像素差异越大（差值 ×4）。无差异像素为黑色。</p>
                </div>

                <div v-else-if="mode === 'side'" class="vc-pair">
                  <figure class="vc-pane">
                    <figcaption class="vc-caption"><span class="vc-dot is-a"></span>{{ leftLabel }}</figcaption>
                    <img :src="image.urlA" alt="左侧版本" draggable="false" />
                  </figure>
                  <figure class="vc-pane">
                    <figcaption class="vc-caption"><span class="vc-dot is-b"></span>{{ rightLabel }}</figcaption>
                    <img :src="image.urlB" alt="右侧版本" draggable="false" />
                  </figure>
                </div>

                <div v-else ref="splitEl" class="vc-split" @pointerdown="onSplitPointerDown">
                  <img class="vc-split-base" :src="image.urlB" alt="右侧版本" draggable="false" />
                  <img
                    class="vc-split-top"
                    :src="image.urlA"
                    alt="左侧版本"
                    draggable="false"
                    :style="{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }"
                  />
                  <div class="vc-split-line" :style="{ left: `${split * 100}%` }"><span class="vc-split-handle">⇔</span></div>
                  <span class="vc-badge is-left">{{ leftLabel }}</span>
                  <span class="vc-badge is-right">{{ rightLabel }}</span>
                </div>

                <p v-if="image.note" class="vc-note">{{ image.note }}</p>
              </template>

              <!-- 视频：逐帧比对（服务端取帧，浏览器只负责显示两张 JPEG） -->
              <template v-else-if="kind === 'video'">
                <div class="vc-toolbar">
                  <button class="btn is-mini" type="button" @click="toggleFramePlay">{{ video.playing ? '暂停' : '连播' }}</button>
                  <button class="btn is-mini" type="button" title="上一帧 (←)" @click="stepFrame(-1)">◀ 帧</button>
                  <button class="btn is-mini" type="button" title="下一帧 (→)" @click="stepFrame(1)">帧 ▶</button>
                  <div class="vc-tabs">
                    <button class="vc-tab" :class="{ 'is-on': mode === 'split' }" type="button" @click="mode = 'split'">中间滑块</button>
                    <button class="vc-tab" :class="{ 'is-on': mode === 'side' }" type="button" @click="mode = 'side'">并排</button>
                  </div>
                  <span class="vc-meta mono">{{ videoStatsText }}</span>
                </div>

                <div v-if="mode === 'side'" class="vc-pair">
                  <figure class="vc-pane">
                    <figcaption class="vc-caption"><span class="vc-dot is-a"></span>{{ leftLabel }}</figcaption>
                    <img :src="video.urls.a" alt="左侧帧" draggable="false" @load="onFrameLoad('a')" @error="onFrameError('a')" />
                  </figure>
                  <figure class="vc-pane">
                    <figcaption class="vc-caption"><span class="vc-dot is-b"></span>{{ rightLabel }}</figcaption>
                    <img :src="video.urls.b" alt="右侧帧" draggable="false" @load="onFrameLoad('b')" @error="onFrameError('b')" />
                  </figure>
                </div>

                <div v-else ref="splitEl" class="vc-split" @pointerdown="onSplitPointerDown">
                  <img
                    ref="frameElB"
                    class="vc-split-base"
                    :src="video.urls.b"
                    alt="右侧帧"
                    draggable="false"
                    @load="onFrameLoad('b')"
                    @error="onFrameError('b')"
                  />
                  <img
                    ref="frameElA"
                    class="vc-split-top"
                    :src="video.urls.a"
                    alt="左侧帧"
                    draggable="false"
                    :style="{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }"
                    @load="onFrameLoad('a')"
                    @error="onFrameError('a')"
                  />
                  <div class="vc-split-line" :style="{ left: `${split * 100}%` }"><span class="vc-split-handle">⇔</span></div>
                  <span class="vc-badge is-left">{{ leftLabel }}</span>
                  <span class="vc-badge is-right">{{ rightLabel }}</span>
                </div>

                <div class="vc-timeline">
                  <input
                    class="vc-range"
                    type="range"
                    min="0"
                    :max="video.duration || 0"
                    step="0.001"
                    :value="video.time"
                    @input="onTimelineInput"
                  />
                  <span class="vc-meta mono">{{ formatFrameTime(video.time, video.fps) }} · 帧 {{ frameAt(video.time, video.fps) }}</span>
                </div>
                <p v-if="video.note" class="vc-note">{{ video.note }}</p>
              </template>

              <!-- 音频 -->
              <template v-else-if="kind === 'audio'">
                <div class="vc-toolbar">
                  <button class="btn is-mini" type="button" @click="toggleAudioPlay">{{ audio.playing ? '暂停' : '试听' }}</button>
                  <div class="vc-tabs">
                    <button class="vc-tab" :class="{ 'is-on': audio.side === 'b' }" type="button" @click="setAudioSide('b')">当前</button>
                    <button class="vc-tab" :class="{ 'is-on': audio.side === 'a' }" type="button" @click="setAudioSide('a')">历史版本</button>
                  </div>
                  <span class="vc-meta mono">{{ audioStatsText }}</span>
                </div>
                <div class="vc-wave-wrap">
                  <canvas ref="waveCanvas" class="vc-wave" @pointerdown="onWavePointer"></canvas>
                </div>
                <p class="vc-note">
                  时长 {{ formatDuration(audio.durationA) }} / {{ formatDuration(audio.durationB) }} · 解码采样率
                  {{ audio.sampleRate ? `${audio.sampleRate} Hz` : '—' }} · 声道 {{ audio.channelsA }} / {{ audio.channelsB }}
                  <span v-if="Math.abs(audio.durationA - audio.durationB) > 0.02"> · 时长不同，波形按各自时长对齐</span>
                </p>
              </template>

              <p v-else class="vc-hint">该类型暂不支持历史版本对比。</p>
            </section>
          </div>

          <footer class="vc-foot">
            <span class="muted">{{ hint || 'Esc 关闭 · 图片 ←/→ 移动滑块 · 视频 ←/→ 逐帧 · 音频空格试听' }}</span>
            <button class="btn is-mini" type="button" @click="close">关闭</button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.vc-mask {
  position: fixed;
  inset: 0;
  z-index: 84;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.vc-dialog {
  display: flex;
  flex-direction: column;
  width: min(1180px, 100%);
  height: min(88vh, 860px);
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.46);
  outline: none;
}

.vc-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid var(--border);
}

.vc-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.vc-heading h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vc-kind {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
}

.vc-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.vc-stat {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-muted);
}

.vc-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
}

.vc-close:hover {
  background: var(--hover);
  color: var(--text);
}

.vc-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.vc-side {
  flex: none;
  width: 232px;
  padding: 10px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.vc-side-title {
  padding: 2px 4px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.vc-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 6px 6px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  text-align: left;
}

.vc-row:hover {
  background: var(--hover);
}

.vc-row.is-active {
  background: var(--active);
  border-color: var(--border-strong);
}

.vc-row-tag {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-muted);
  font-size: 9px;
}

.vc-row-tag.is-current {
  background: var(--accent-soft);
  color: var(--accent);
}

.vc-row-time {
  font-size: 10px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vc-row-size {
  font-size: 9px;
  color: var(--text-muted);
}

.vc-hint {
  margin: 8px 4px 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-muted);
}

.vc-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--bg-canvas);
}

.vc-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.vc-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius);
  background: var(--panel-2);
  border: 1px solid var(--border);
}

.vc-tab {
  height: 22px;
  padding: 0 8px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.vc-tab.is-on {
  background: var(--panel);
  color: var(--text);
  box-shadow: var(--shadow-frame);
}

.vc-tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.vc-meta {
  font-size: 10px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vc-split {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--checker-a);
  cursor: col-resize;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vc-split-base,
.vc-split-top {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  pointer-events: none;
}

.vc-split-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.vc-split-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fff;
  color: #1e1e1e;
  font-size: 12px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}

.vc-badge {
  position: absolute;
  top: 8px;
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
  pointer-events: none;
}

.vc-badge.is-left {
  left: 8px;
}

.vc-badge.is-right {
  right: 8px;
}

.vc-pair {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.vc-pane {
  margin: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.vc-pane img {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
  background: var(--checker-a);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.vc-caption {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-muted);
}

.vc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.vc-dot.is-b {
  background: var(--ok);
}

.vc-diff-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.vc-diff-canvas {
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #000;
  image-rendering: pixelated;
}

.vc-legend {
  margin: 0;
  font-size: 10px;
  color: var(--text-muted);
}

.vc-timeline {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
}

.vc-range {
  flex: 1;
  accent-color: var(--accent);
}

.vc-wave-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  justify-content: center;
  overflow: hidden;
}

.vc-wave {
  cursor: crosshair;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
}

.vc-note {
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-muted);
}

.vc-loading,
.vc-error {
  flex: 1;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--text-muted);
}

.vc-error {
  color: var(--danger);
}

.vc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  font-size: 10px;
}

.vc-modal-enter-active,
.vc-modal-leave-active {
  transition: opacity 0.16s ease;
}

.vc-modal-enter-from,
.vc-modal-leave-to {
  opacity: 0;
}

.vc-modal-enter-active .vc-dialog {
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.vc-modal-enter-from .vc-dialog {
  transform: translateY(8px) scale(0.988);
}
</style>
