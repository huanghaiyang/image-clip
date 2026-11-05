<script setup>
/**
 * 视频工作区右侧面板：FFmpeg 状态 → 视频元信息 → 关键帧截取 → 音频提取。
 *
 * 这里只负责“参数与结果展示”，真正的探测/截帧/抽音轨都交给 useVideo 的 actions：
 *   - 截帧结果默认写回资源库 `关键帧/<视频名>/`，面板提供“在资源库查看”的跳转；
 *   - 音频默认写回 `音频/`，便于和其他资源统一管理。
 */
import { computed, onMounted } from 'vue';

import RangeField from './ui/RangeField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchField from './ui/SwitchField.vue';
import { setMode } from '../composables/useAppMode.js';
import { useLibrary } from '../composables/useLibrary.js';
import { useVideo } from '../composables/useVideo.js';
import { formatDuration, formatSize } from '../lib/library.js';

const {
  state,
  duration,
  fps,
  videoBase,
  targetDir,
  hasVideo,
  ffmpegReady,
  displaySize,
  trimRange,
  cropRect,
  canEdit,
  manualTimes,
  canExtract,
  actions,
} = useVideo();
const { actions: libraryActions } = useLibrary();

const FRAME_MODES = [
  { value: 'interval', label: '按间隔', hint: '固定时间间隔抽帧，适合做预览条' },
  { value: 'count', label: '按数量', hint: '在整段视频上均匀采样指定帧数' },
  { value: 'times', label: '手动标记', hint: '只截取时间轴上手动添加的标记点' },
];

const FRAME_FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
];

const AUDIO_FORMATS = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A' },
  { value: 'wav', label: 'WAV' },
  { value: 'flac', label: 'FLAC' },
];

const meta = computed(() => state.meta);
const ffmpegInfo = computed(() => state.health.ffmpeg);

/**
 * 服务端 ffmpegStatus 把可执行文件路径放在 `ffmpeg` 字段（`ffprobe` 同理），
 * 这里同时兼容 `path`，避免不同版本字段名差异导致路径显示为空。
 */
const ffmpegPath = computed(() => ffmpegInfo.value?.path || ffmpegInfo.value?.ffmpeg || '');

/** 完整版本串太长，只取版本号主体；完整内容放 title。 */
const ffmpegVersion = computed(() => {
  const version = ffmpegInfo.value?.version || '';
  const matched = version.match(/version\s+([^\s]+)/i);
  return matched ? matched[1] : version;
});

const fpsText = computed(() => (Number(fps.value) > 0 ? Number(fps.value).toFixed(2) : '—'));

/** 码率按量级换算：>=1Mbps 用 Mbps，否则用 kbps，避免出现一长串数字。 */
const bitrateText = computed(() => {
  const bitrate = Number(meta.value?.bitrate) || 0;
  if (!bitrate) return '—';
  if (bitrate >= 1_000_000) return `${(bitrate / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(bitrate / 1000)} kbps`;
});

const audioText = computed(() => {
  if (!meta.value) return '—';
  if (meta.value.hasAudio === false) return '无音轨';
  return meta.value.audioCodec ? `有音轨 · ${meta.value.audioCodec}` : '有音轨';
});

const sizeText = computed(() => formatSize(Number(meta.value?.size ?? meta.value?.bytes ?? 0)));

const frameResult = computed(() => (state.lastExtract?.type === 'frames' ? state.lastExtract : null));
const audioResult = computed(() => (state.lastExtract?.type === 'audio' ? state.lastExtract : null));

const audioNamePlaceholder = computed(() => `${videoBase.value || '视频名'}.${state.audio.format}`);

const WATERMARK_ENGINES = [
  { value: 'auto', label: '自动', hint: '按检测结果自动选择反混合或空间修补' },
  { value: 'unblend', label: '反混合（半透明）', hint: '逐帧反算水印叠加，适合半透明角标或字幕' },
  { value: 'removelogo', label: '空间修补', hint: '用 FFmpeg 空间插值覆盖不透明水印' },
];

const wm = computed(() => state.edit.watermark);
const cutNamePlaceholder = computed(() => `${videoBase.value || '视频名'}-裁剪.mp4`);
const trimHint = computed(
  () => `保留 ${trimRange.value.duration.toFixed(2)}s / 共 ${duration.value.toFixed(2)}s`,
);

const watermarkParamText = computed(() => {
  const params = wm.value.params;
  if (!params) return '';
  const color = (params.color || []).map((item) => Math.round(Number(item) || 0));
  return `α≈${(Number(params.alpha) || 0).toFixed(2)} · 水印色 rgb(${color.join(', ')})`;
});

const watermarkResultText = computed(() => {
  const result = wm.value.result;
  if (!result) return '';
  const engine = result.engine === 'unblend' ? '反混合' : result.engine === 'removelogo' ? '空间修补' : result.engine;
  const seconds = (Number(result.elapsedMs) || 0) / 1000;
  return `${engine} · ${seconds.toFixed(1)}s · ${result.entry?.path ?? '—'}`;
});

/** 裁剪参数按 0..1 存储，界面上按百分比显示与调整。 */
function cropPercent(key) {
  return Math.round((Number(state.edit.crop[key]) || 0) * 100);
}

function setCropPercent(key, value) {
  actions.setCropField(key, Number(value) / 100);
}

/** 无视频、FFmpeg 不可用、正在忙、无音轨时都不能提取音频。 */
const audioDisabled = computed(
  () => !hasVideo.value || !ffmpegReady.value || state.busy || state.meta?.hasAudio === false,
);

function onWidthChange(event) {
  const raw = Number(event.target.value);
  const width = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  actions.setOption('width', width);
  // 立刻回写输入框，避免用户输入负数/非数字后界面值与真实参数不一致
  event.target.value = String(width);
}

function formatElapsed(milliseconds) {
  const value = Number(milliseconds) || 0;
  if (!value) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)} ms`;
}

/** 截帧结果落在资源库的某个子目录：直接切到资源库并定位过去。 */
function openFrameFolder() {
  const result = frameResult.value;
  if (!result?.folder) return;
  libraryActions.setDir(result.folder);
  setMode('library');
}

/** 音频条目自带 dir，空串代表资源库根目录。 */
function openAudioFolder() {
  const entry = audioResult.value?.entry;
  if (!entry) return;
  libraryActions.setDir(entry.dir ?? '');
  setMode('library');
}

onMounted(() => {
  // 与左栏共用缓存，重复调用不会发第二个请求
  void actions.checkHealth();
});
</script>

<template>
  <aside class="video-panel panel">
    <div class="panel-title">
      <span>视频 · 处理</span>
    </div>

    <div class="scroll">
      <!-- FFmpeg 状态 -->
      <section class="section">
        <h3 class="section-title">FFmpeg</h3>

        <template v-if="ffmpegReady">
          <div class="health-row">
            <span class="dot is-ok" />
            <span>已就绪</span>
            <span class="chip mono" :title="ffmpegInfo?.version || ''">{{ ffmpegVersion || 'unknown' }}</span>
          </div>
          <p class="path mono" :title="ffmpegPath">{{ ffmpegPath || '路径未知' }}</p>
        </template>

        <div v-else class="health-warn">
          <div class="health-row">
            <span class="dot is-warn" />
            <span>{{ state.health.checked ? 'FFmpeg 未就绪' : '正在检测 FFmpeg…' }}</span>
          </div>
          <p class="warn-note">{{ state.health.error || ffmpegInfo?.hint || '正在请求 /api/video/health' }}</p>
          <p class="note">
            安装方式：设置环境变量 <span class="mono">FFMPEG_PATH</span>，或把 ffmpeg.exe 与 ffprobe.exe 放到
            <span class="mono">D:\thirdparty\ffmpeg\bin</span>。
          </p>
        </div>
      </section>

      <!-- 视频信息 -->
      <section class="section">
        <h3 class="section-title">视频信息</h3>
        <p v-if="!meta" class="note">从左侧选择视频后显示元信息。</p>
        <dl v-else class="kv">
          <div class="kv-row">
            <dt>名称</dt>
            <dd class="mono" :title="meta.path">{{ meta.name }}</dd>
          </div>
          <div class="kv-row">
            <dt>尺寸</dt>
            <dd class="mono">{{ meta.width || '?' }} × {{ meta.height || '?' }}</dd>
          </div>
          <div class="kv-row">
            <dt>帧率</dt>
            <dd class="mono">{{ fpsText }}</dd>
          </div>
          <div class="kv-row">
            <dt>时长</dt>
            <dd class="mono">{{ formatDuration(duration) }}</dd>
          </div>
          <div class="kv-row">
            <dt>编码</dt>
            <dd class="mono">{{ meta.codec || '—' }}</dd>
          </div>
          <div class="kv-row">
            <dt>码率</dt>
            <dd class="mono">{{ bitrateText }}</dd>
          </div>
          <div class="kv-row">
            <dt>音轨</dt>
            <dd class="mono">{{ audioText }}</dd>
          </div>
          <div class="kv-row">
            <dt>文件大小</dt>
            <dd class="mono">{{ sizeText }}</dd>
          </div>
        </dl>
      </section>

      <!-- 关键帧截取 -->
      <section class="section">
        <h3 class="section-title">关键帧截取</h3>
        <p v-if="!hasVideo" class="note">先选择视频，才能截取关键帧。</p>

        <div class="segmented-wrap">
          <SegmentedControl
            block
            :model-value="state.options.mode"
            :options="FRAME_MODES"
            @update:model-value="actions.setOption('mode', $event)"
          />
        </div>

        <RangeField
          v-if="state.options.mode === 'interval'"
          label="间隔"
          :model-value="state.options.interval"
          :min="0.1"
          :max="60"
          :step="0.1"
          suffix="s"
          hint="每隔这么多秒截一张。"
          :disabled="!hasVideo"
          @update:model-value="actions.setOption('interval', $event)"
        />

        <RangeField
          v-else-if="state.options.mode === 'count'"
          label="帧数"
          :model-value="state.options.count"
          :min="1"
          :max="120"
          :step="1"
          hint="在整段视频上均匀采样，单次最多 120 帧。"
          :disabled="!hasVideo"
          @update:model-value="actions.setOption('count', $event)"
        />

        <div v-else class="marks-summary">
          <div class="health-row">
            <span class="dot is-ok" />
            <span>手动标记</span>
            <span class="chip mono">{{ manualTimes.length }} 个</span>
          </div>
          <p class="note">
            {{
              manualTimes.length
                ? '将按标记时间逐个截帧，可在舞台上继续增删标记。'
                : '还没有标记点：先在时间轴（舞台底部）添加标记，再回到这里截取。'
            }}
          </p>
        </div>

        <div class="field-row">
          <div class="field-head">
            <label class="field-label">输出格式</label>
          </div>
          <SegmentedControl
            block
            :model-value="state.options.format"
            :options="FRAME_FORMATS"
            @update:model-value="actions.setOption('format', $event)"
          />
        </div>

        <div class="field-row">
          <div class="field-head">
            <label class="field-label">宽度</label>
            <input
              class="text-input is-narrow mono"
              type="number"
              min="0"
              step="2"
              :value="state.options.width"
              :disabled="!hasVideo"
              @change="onWidthChange"
            />
          </div>
          <p class="note">0 = 保持原始分辨率；奇数宽度会自动取偶数，避免编码器报错。</p>
        </div>

        <div class="field-row">
          <div class="field-head">
            <label class="field-label">文件名前缀</label>
          </div>
          <input
            class="text-input"
            type="text"
            :value="state.options.prefix"
            :placeholder="videoBase || '帧前缀'"
            @input="actions.setOption('prefix', $event.target.value)"
          />
        </div>

        <div class="field-row">
          <label class="field-label">保存位置</label>
          <p class="readonly mono" :title="targetDir">{{ targetDir || '—' }}</p>
          <p class="note">默认写入资源库/关键帧/&lt;视频名&gt;，截取结果会立即出现在资源库。</p>
        </div>

        <button class="btn is-primary is-block" type="button" :disabled="!canExtract" @click="actions.extractFrames()">
          {{ state.busy ? state.progress || '处理中…' : '截取关键帧' }}
        </button>

        <div v-if="frameResult" class="result-box">
          <div class="result-head">
            <span>上次截帧</span>
            <span class="chip mono">{{ frameResult.extracted }} / {{ frameResult.requested }}</span>
          </div>
          <dl class="kv">
            <div class="kv-row">
              <dt>保存目录</dt>
              <dd class="mono">资源库/{{ frameResult.folder }}</dd>
            </div>
            <div class="kv-row">
              <dt>耗时</dt>
              <dd class="mono">{{ formatElapsed(frameResult.elapsedMs) }}</dd>
            </div>
            <div class="kv-row">
              <dt>失败</dt>
              <dd class="mono" :class="{ 'is-danger': frameResult.failed > 0 }">{{ frameResult.failed }} 帧</dd>
            </div>
          </dl>
          <button class="btn is-block" type="button" @click="openFrameFolder">在资源库查看</button>
        </div>
      </section>

      <!-- 音频提取 -->
      <section class="section">
        <h3 class="section-title">音频提取</h3>

        <p v-if="meta && meta.hasAudio === false" class="audio-empty">该视频没有音轨，无法提取音频。</p>

        <template v-else>
          <div class="segmented-wrap">
            <SegmentedControl
              block
              :model-value="state.audio.format"
              :options="AUDIO_FORMATS"
              @update:model-value="actions.setAudioOption('format', $event)"
            />
          </div>

          <div class="field-row">
            <div class="field-head">
              <label class="field-label">文件名</label>
            </div>
            <input
              class="text-input"
              type="text"
              :value="state.audio.name"
              :placeholder="audioNamePlaceholder"
              @input="actions.setAudioOption('name', $event.target.value)"
            />
          </div>

          <div class="field-row">
            <div class="field-head">
              <label class="field-label">保存目录</label>
            </div>
            <input
              class="text-input"
              type="text"
              :value="state.audio.dir"
              placeholder="音频"
              @input="actions.setAudioOption('dir', $event.target.value)"
            />
          </div>
        </template>

        <button class="btn is-block" type="button" :disabled="audioDisabled" @click="actions.extractAudio()">
          {{ state.busy ? state.progress || '处理中…' : '提取音频' }}
        </button>

        <div v-if="audioResult" class="result-box">
          <div class="result-head">
            <span>上次提取</span>
            <span class="chip mono">{{ (audioResult.format || '').toUpperCase() }}</span>
          </div>
          <p class="result-path mono" :title="audioResult.entry?.path || ''">{{ audioResult.entry?.path || '—' }}</p>
          <button class="btn is-block" type="button" @click="openAudioFolder">在资源库查看</button>
        </div>
      </section>

      <!-- 裁剪 / 切断 -->
      <section class="section">
        <h3 class="section-title">裁剪 / 切断</h3>

        <SwitchField
          label="启用裁剪"
          :model-value="state.edit.cropEnabled"
          hint="按占比裁掉画面四边，导出时与切断合并成一次重编码"
          @update:model-value="actions.setEditOption('cropEnabled', $event)"
        />

        <template v-if="state.edit.cropEnabled">
          <RangeField
            label="左边距 x"
            :model-value="cropPercent('x')"
            :min="0"
            :max="70"
            :step="1"
            suffix="%"
            @update:model-value="setCropPercent('x', $event)"
          />
          <RangeField
            label="上边距 y"
            :model-value="cropPercent('y')"
            :min="0"
            :max="70"
            :step="1"
            suffix="%"
            @update:model-value="setCropPercent('y', $event)"
          />
          <RangeField
            label="宽度 width"
            :model-value="cropPercent('width')"
            :min="5"
            :max="100"
            :step="1"
            suffix="%"
            @update:model-value="setCropPercent('width', $event)"
          />
          <RangeField
            label="高度 height"
            :model-value="cropPercent('height')"
            :min="5"
            :max="100"
            :step="1"
            suffix="%"
            @update:model-value="setCropPercent('height', $event)"
          />
          <p v-if="cropRect" class="hint">裁剪后实际尺寸 {{ cropRect.width }} × {{ cropRect.height }} px。</p>
          <p v-else class="hint">选择视频后即可看到裁剪后的实际像素尺寸。</p>
        </template>
        <p v-else class="hint">未启用裁剪：开启后可分别调整 x / y 与宽高占比。</p>

        <p class="field-label edit-subhead">切断</p>
        <RangeField
          label="起点"
          :model-value="state.edit.trimStart"
          :min="0"
          :max="duration"
          :step="0.05"
          suffix="s"
          hint="从这一秒开始保留。"
          :disabled="!hasVideo"
          @update:model-value="actions.setEditOption('trimStart', $event)"
        />
        <RangeField
          label="终点"
          :model-value="trimRange.end"
          :min="0"
          :max="duration"
          :step="0.05"
          suffix="s"
          :hint="trimHint"
          :disabled="!hasVideo"
          @update:model-value="actions.setTrimEnd($event)"
        />

        <div class="field-row">
          <div class="field-head">
            <label class="field-label">保存目录</label>
          </div>
          <input
            class="text-input"
            type="text"
            :value="state.edit.output.dir"
            placeholder="视频处理"
            @input="actions.setOutputOption('dir', $event.target.value)"
          />
        </div>

        <div class="field-row">
          <div class="field-head">
            <label class="field-label">文件名</label>
          </div>
          <input
            class="text-input"
            type="text"
            :value="state.edit.output.cutName"
            :placeholder="cutNamePlaceholder"
            @input="actions.setOutputOption('cutName', $event.target.value)"
          />
        </div>

        <button class="btn is-primary is-block" type="button" :disabled="!canEdit" @click="actions.cutVideo()">
          {{ state.busy ? '导出中…' : '导出裁剪 / 切断视频' }}
        </button>
        <p class="hint">一次 FFmpeg 重编码，切断与裁剪同时生效，保留原音轨。</p>
      </section>

      <!-- 视频水印去除 -->
      <section class="section is-last">
        <div class="section-head">
          <h3 class="section-title">视频水印去除</h3>
          <span v-if="wm.preview && wm.coverage > 0" class="chip mono">
            {{ (wm.coverage * 100).toFixed(2) }}%
          </span>
        </div>

        <div class="watermark-actions">
          <button class="btn is-primary" type="button" :disabled="!canEdit" @click="actions.detectWatermark()">
            {{ wm.status === 'detecting' ? '检测中…' : '检测水印' }}
          </button>
          <button v-if="wm.preview || wm.result" class="btn is-ghost" type="button" @click="actions.clearWatermark()">
            清除结果
          </button>
        </div>

        <p v-if="wm.preview" class="hint mono">
          检测帧 {{ wm.time.toFixed(2) }}s · {{ displaySize.width }}×{{ displaySize.height }}
        </p>
        <img v-if="wm.preview" class="watermark-preview" :src="wm.preview.dataUrl" alt="水印检测预览" />

        <div class="field-row">
          <div class="field-head">
            <label class="field-label">去除引擎</label>
          </div>
          <SegmentedControl
            block
            :model-value="wm.engine"
            :options="WATERMARK_ENGINES"
            @update:model-value="actions.setWatermarkEngine($event)"
          />
        </div>

        <p v-if="wm.params" class="hint mono">{{ watermarkParamText }}</p>
        <p v-else-if="wm.preview" class="hint">该水印不适合反混合，将用空间修补。</p>

        <button
          class="btn is-primary is-block"
          type="button"
          :disabled="!canEdit || !wm.mask"
          @click="actions.removeWatermark()"
        >
          {{ wm.status === 'removing' ? '正在逐帧处理…' : '去除水印并导出' }}
        </button>

        <p v-if="wm.result" class="hint mono">已完成 · {{ watermarkResultText }}</p>
        <p v-if="wm.error" class="hint is-warn">{{ wm.error }}</p>

        <p class="hint">
          静态水印只在样本帧检测一次，掩膜复用到整段视频（Concat 的遮罩网格思路）；半透明水印走逐帧反混合，不透明水印走
          FFmpeg 空间插值。
        </p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.video-panel {
  display: flex;
  flex-direction: column;
  width: 320px;
  flex: none;
  border-left: 1px solid var(--border);
}

.scroll {
  flex: 1;
  overflow-y: auto;
}

.section.is-last {
  border-bottom: none;
}

.health-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 11px;
}

.dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--text-muted);
}

.dot.is-ok {
  background: var(--ok);
}

.dot.is-warn {
  background: var(--warn);
}

.health-row .chip {
  margin-left: auto;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.health-warn {
  padding: 8px;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.warn-note {
  margin: 6px 0 0;
  color: var(--warn);
  font-size: 10px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.note {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.kv {
  margin: 0;
}

.kv-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 0;
}

.kv-row dt {
  color: var(--text-muted);
  white-space: nowrap;
}

.kv-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.segmented-wrap {
  margin-bottom: 10px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.section-head .section-title {
  margin: 0;
}

.hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.hint.is-warn {
  color: var(--warn);
}

.edit-subhead {
  margin: 4px 0 8px;
}

.watermark-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.watermark-preview {
  display: block;
  width: 100%;
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: #000;
}

.field-row {
  margin-bottom: 10px;
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.field-label {
  display: block;
  color: var(--text-2);
}

.text-input {
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text);
}

.text-input:focus {
  outline: none;
  border-color: var(--accent);
}

.text-input.is-narrow {
  width: 72px;
  text-align: right;
}

.readonly {
  margin: 6px 0 0;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.marks-summary {
  margin-bottom: 10px;
}

.audio-empty {
  margin: 0 0 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  color: var(--warn);
  font-size: 11px;
}

.result-box {
  margin-top: 10px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-2);
  font-size: 11px;
}

.result-path {
  margin: 0 0 6px;
  color: var(--text-muted);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.is-danger {
  color: var(--danger);
}
</style>
