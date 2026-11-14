<script setup>
/** 右侧检查器：检测参数 / 当前结果 / 导出（对应 Figma 的右侧属性面板）。 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import RangeField from './ui/RangeField.vue';
import SwitchField from './ui/SwitchField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspace, ATLAS_NOISE_ALPHA } from '../composables/useWorkspace.js';
import { formatBytes, formatRatio } from '../lib/imaging.js';

const { state, selected, checkedItems, trimAtlas, spriteGroup, actions, meta } = useWorkspace();

const atlasSaveToLibrary = ref(true);
// 精灵图：列数 0 表示自动方阵，间距单位为像素
const spriteColumns = ref(0);
const spriteGap = ref(0);

const items = computed(() => state.items);
const exportable = computed(() => items.value.filter((item) => item.bounds && !item.resultEmpty));

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'jpeg', label: 'JPEG' },
];

const keepRatio = computed(() => {
  const item = selected.value;
  if (!item?.bounds || item.resultEmpty) return null;
  return (item.bounds.width * item.bounds.height) / Math.max(1, item.width * item.height);
});

const shrunkBytesHint = computed(() => {
  const item = selected.value;
  if (!item) return '';
  return `${formatBytes(item.bytes)} · ${item.type || '未知类型'}`;
});

const qualityVisible = computed(() => state.output.format !== 'png');

const atlasSummary = computed(() => {
  const atlas = trimAtlas.value;
  if (!atlas) return '';
  const { norm } = atlas;
  return `${(norm.x * 100).toFixed(1)}% , ${(norm.y * 100).toFixed(1)}% · ${(norm.width * 100).toFixed(1)}% × ${(
    norm.height * 100
  ).toFixed(1)}%`;
});

// 图集透明裁剪预览：全部勾选素材，按当前并集取景框**裁切后**的结果渐进展示
const atlasPreview = ref(null);
const atlasPreviewBusy = ref(false);
const atlasPreviewRows = computed(() =>
  [...(atlasPreview.value?.results ?? [])].sort((a, b) => a.index - b.index),
);

async function openAtlasPreview() {
  if (atlasPreviewBusy.value || !trimAtlas.value) return;
  closeAtlasPreview();
  atlasPreviewBusy.value = true;
  const session = reactive({
    count: trimAtlas.value.count,
    total: trimAtlas.value.items.length,
    done: 0,
    results: [],
    cancelled: false,
  });
  atlasPreview.value = session;
  window.addEventListener('keydown', onAtlasPreviewKey);
  try {
    await actions.previewAtlasCrop({
      onResult: (row) => {
        // 生成过程中用户可能已经关掉面板：把已经建好的 object URL 立刻回收
        if (session.cancelled) {
          URL.revokeObjectURL(row.url);
          return;
        }
        session.results.push(row);
      },
      onProgress: ({ done, total }) => {
        if (session.cancelled) return;
        session.done = done;
        session.total = total;
      },
    });
  } catch (err) {
    console.warn('[atlas] 预览生成失败:', err.message);
  } finally {
    atlasPreviewBusy.value = false;
  }
}

function closeAtlasPreview() {
  window.removeEventListener('keydown', onAtlasPreviewKey);
  const session = atlasPreview.value;
  if (session) {
    session.cancelled = true;
    for (const row of session.results ?? []) URL.revokeObjectURL(row.url);
  }
  atlasPreview.value = null;
}

function onAtlasPreviewKey(event) {
  if (event.key === 'Escape') closeAtlasPreview();
}

onBeforeUnmount(closeAtlasPreview);

const spriteMaxColumns = computed(() => Math.max(1, spriteGroup.value?.frames.length ?? 1));
watch(spriteMaxColumns, (max) => {
  if (spriteColumns.value > max) spriteColumns.value = max;
});
const spritePlan = computed(() => {
  const group = spriteGroup.value;
  if (!group) return null;
  const count = group.frames.length;
  const auto = Math.ceil(Math.sqrt(count));
  const cols = Math.max(1, Math.min(count, spriteColumns.value || auto));
  const gap = Math.max(0, Math.round(spriteGap.value) || 0);
  const rows = Math.ceil(count / cols);
  return {
    count,
    cols,
    rows,
    width: cols * group.width + (cols - 1) * gap,
    height: rows * group.height + (rows - 1) * gap,
  };
});
</script>

<template>
  <aside class="inspector panel">
    <div class="panel-title">
      <span>检查器</span>
      <span class="chip">{{ meta.ALGORITHM }}</span>
    </div>

    <div class="inspector-scroll">
      <!-- 检测参数 -->
      <section class="section">
        <h3 class="section-title">检测</h3>

        <SwitchField
          label="颜色背景模式"
          :model-value="state.options.matchColor"
          hint="把接近背景色的不透明像素也视为背景，适合白底 JPG/截图（无 alpha 的素材）。"
          @update:model-value="actions.setOption('matchColor', $event)"
        />

        <div v-if="state.options.matchColor" class="color-row">
          <label class="color-label">背景色</label>
          <div class="color-input">
            <input
              type="color"
              :value="state.options.backgroundColor"
              @input="actions.setOption('backgroundColor', $event.target.value)"
            />
            <span class="mono">{{ state.options.backgroundColor }}</span>
          </div>
        </div>

        <RangeField
          v-if="state.options.matchColor"
          label="颜色容差"
          :model-value="state.options.colorTolerance"
          :min="0"
          :max="255"
          suffix="/255"
          hint="RGB 三通道最大差值，越大抠掉的颜色范围越宽。"
          @update:model-value="actions.setOption('colorTolerance', $event)"
        />

        <RangeField
          label="透明阈值"
          :model-value="state.options.alphaThreshold"
          :min="0"
          :max="254"
          hint="alpha 大于该值的像素才算内容；调大可丢弃几乎不可见的阴影噪点。"
          @update:model-value="actions.setOption('alphaThreshold', $event)"
        />

        <RangeField
          label="边缘留白"
          :model-value="state.options.padding"
          :min="-40"
          :max="80"
          suffix="px"
          hint="正值在裁剪框外多留边距，负值向内收缩。"
          @update:model-value="actions.setOption('padding', $event)"
        />

        <button class="btn is-block is-ghost" type="button" @click="actions.resetOptions()">重置为默认值</button>
      </section>

      <!-- 结果 -->
      <section class="section">
        <h3 class="section-title">结果</h3>

        <p v-if="!selected" class="muted empty">选择左侧任意素材查看裁剪结果。</p>

        <template v-else>
          <dl class="kv">
            <div class="kv-row">
              <dt>原始尺寸</dt>
              <dd class="mono">{{ selected.width }} × {{ selected.height }}</dd>
            </div>
            <div class="kv-row">
              <dt>裁剪尺寸</dt>
              <dd class="mono accent">
                <template v-if="selected.bounds && !selected.resultEmpty">
                  {{ selected.bounds.width }} × {{ selected.bounds.height }}
                </template>
                <template v-else>—</template>
              </dd>
            </div>
            <div class="kv-row">
              <dt>裁剪框坐标</dt>
              <dd class="mono">
                <template v-if="selected.bounds && !selected.resultEmpty">
                  {{ selected.bounds.x }}, {{ selected.bounds.y }}
                </template>
                <template v-else>—</template>
              </dd>
            </div>
            <div class="kv-row">
              <dt>保留面积</dt>
              <dd class="mono">{{ keepRatio === null ? '—' : formatRatio(keepRatio) }}</dd>
            </div>
            <div class="kv-row">
              <dt>文件</dt>
              <dd class="mono">{{ shrunkBytesHint }}</dd>
            </div>
            <div class="kv-row">
              <dt>引擎 / 耗时</dt>
              <dd class="mono">
                {{ selected.engine || '—' }}
                <template v-if="selected.elapsedMs"> · {{ selected.elapsedMs }}ms</template>
              </dd>
            </div>
          </dl>

          <div v-if="selected.trimmed && !selected.resultEmpty" class="trim-grid">
            <div class="trim">
              <span class="trim-edge">左</span>
              <span class="mono">−{{ selected.trimmed.left }}</span>
            </div>
            <div class="trim">
              <span class="trim-edge">上</span>
              <span class="mono">−{{ selected.trimmed.top }}</span>
            </div>
            <div class="trim">
              <span class="trim-edge">右</span>
              <span class="mono">−{{ selected.trimmed.right }}</span>
            </div>
            <div class="trim">
              <span class="trim-edge">下</span>
              <span class="mono">−{{ selected.trimmed.bottom }}</span>
            </div>
          </div>

          <p v-if="selected.error" class="error">{{ selected.error }}</p>

          <div class="row-actions">
            <button class="btn" type="button" @click="actions.copyBounds(selected)">复制坐标</button>
            <button class="btn" type="button" @click="actions.recomputeAll()">重新检测</button>
          </div>
          <button
            class="btn is-block is-ghost mt-6"
            type="button"
            :disabled="state.busy || !selected.bounds || selected.resultEmpty"
            @click="actions.saveTrimmedItem(selected)"
          >
            存入资源库
          </button>
          <button
            class="btn is-block mt-6"
            type="button"
            :disabled="state.busy || !selected.bounds || selected.resultEmpty"
            @click="actions.saveTrimmedInPlace(selected)"
          >
            保存到当前素材（不新增）
          </button>
          <p class="muted note">「保存到当前素材」直接覆盖当前素材的资源库文件（旧内容自动存为历史版本），素材列表不会多出一项。</p>
        </template>
      </section>

      <!-- 图集透明裁剪 -->
      <section class="section">
        <h3 class="section-title">图集透明裁剪（最大 AABB）</h3>
        <p class="muted note">
          先在左侧「当前素材」勾选图片：各图的内容框换算成相对坐标后取并集，用同一个最大 AABB 裁切，序列帧的取景保持一致。
          并集计算会忽略 alpha ≤ {{ ATLAS_NOISE_ALPHA }} 的近透明噪点，避免个别帧的杂点把取景框撑大。
        </p>

        <template v-if="trimAtlas">
          <dl class="kv">
            <div class="kv-row">
              <dt>已勾选</dt>
              <dd class="mono">{{ trimAtlas.count }} 张</dd>
            </div>
            <div class="kv-row">
              <dt>相对取景</dt>
              <dd class="mono accent">{{ atlasSummary }}</dd>
            </div>
          </dl>
        </template>
        <p v-else class="muted empty">还没有勾选可裁剪的素材（勾选 {{ checkedItems.length }} 张）。</p>

        <label class="check-row">
          <input v-model="atlasSaveToLibrary" type="checkbox" />
          <span>保存到资源库/裁剪结果</span>
        </label>
        <button
          class="btn is-block is-ghost"
          type="button"
          :disabled="state.busy || !trimAtlas || atlasPreviewBusy"
          @click="openAtlasPreview"
        >
          {{ atlasPreviewBusy ? '正在生成预览…' : '预览裁剪效果' }}
        </button>
        <button
          class="btn is-primary is-block"
          type="button"
          :disabled="state.busy || !trimAtlas"
          @click="actions.trimAtlasBatch({ saveToLibrary: atlasSaveToLibrary })"
        >
          图集透明裁剪{{ trimAtlas ? ` ${trimAtlas.count} 张` : '' }}
        </button>
        <p class="muted note">结果会作为新素材加入左侧列表，原图保持不变。</p>
      </section>

      <!-- 精灵图 -->
      <section class="section">
        <h3 class="section-title">精灵图（Sprite）</h3>
        <p class="muted note">
          把勾选的同尺寸素材按方阵拼成一张 PNG（保留透明通道）。图集透明裁剪的结果天然同尺寸，勾选后可直接导出。
        </p>

        <template v-if="spriteGroup">
          <dl class="kv">
            <div class="kv-row">
              <dt>同尺寸帧</dt>
              <dd class="mono">{{ spriteGroup.frames.length }} 张 · {{ spriteGroup.width }} × {{ spriteGroup.height }}</dd>
            </div>
            <div class="kv-row" v-if="spritePlan">
              <dt>输出尺寸</dt>
              <dd class="mono accent">
                {{ spritePlan.width }} × {{ spritePlan.height }}（{{ spritePlan.cols }} 列 × {{ spritePlan.rows }} 行）
              </dd>
            </div>
          </dl>
          <p v-if="spriteGroup.skipped" class="muted note">
            另有 {{ spriteGroup.skipped }} 张素材尺寸不同，不会参与拼图。
          </p>

          <RangeField
            label="列数"
            :model-value="spriteColumns"
            :min="0"
            :max="spriteMaxColumns"
            suffix="列"
            :hint="`0 表示自动方阵（约 ${Math.ceil(Math.sqrt(spriteGroup.frames.length))} 列）。`"
            @update:model-value="spriteColumns = $event"
          />
          <RangeField
            label="帧间距"
            :model-value="spriteGap"
            :min="0"
            :max="32"
            suffix="px"
            hint="帧之间留出的透明间隙。"
            @update:model-value="spriteGap = $event"
          />

          <button
            class="btn is-primary is-block"
            type="button"
            :disabled="state.busy"
            @click="actions.exportSpriteSheet({ columns: spriteColumns, gap: spriteGap })"
          >
            导出精灵图（{{ spriteGroup.frames.length }} 帧）
          </button>
        </template>
        <p v-else class="muted empty">先在左侧勾选要拼成精灵图的素材。</p>
      </section>

      <!-- 导出 -->
      <section class="section is-last">
        <h3 class="section-title">导出</h3>

        <SegmentedControl
          block
          :model-value="state.output.format"
          :options="FORMATS"
          @update:model-value="actions.setOutput('format', $event)"
        />

        <RangeField
          v-if="qualityVisible"
          class="quality"
          label="质量"
          :model-value="state.output.quality"
          :min="10"
          :max="100"
          suffix="%"
          @update:model-value="actions.setOutput('quality', $event)"
        />
        <p v-else class="muted note">PNG 为无损输出，保留 alpha 通道。</p>
        <p v-if="state.output.format === 'jpeg'" class="muted note">JPEG 不支持透明，透明区域会填成白色。</p>

        <button
          class="btn is-primary is-block"
          type="button"
          :disabled="state.busy || !selected || !selected.bounds || selected.resultEmpty"
          @click="actions.exportItem(selected)"
        >
          导出当前图片
        </button>
        <button
          class="btn is-block"
          type="button"
          :disabled="state.busy || exportable.length === 0"
          @click="actions.exportAll()"
        >
          批量导出 ZIP（{{ exportable.length }} 张）
        </button>
      </section>
    </div>
  </aside>

  <!-- 图集透明裁剪预览：只读展示每张图的裁切结果 -->
  <Teleport to="body">
    <div v-if="atlasPreview" class="atlas-mask" @click.self="closeAtlasPreview">
      <div class="atlas-dialog" role="dialog" aria-modal="true" aria-label="图集透明裁剪预览">
        <header class="atlas-head">
          <div>
            <h2>图集透明裁剪预览</h2>
            <p class="atlas-sub">
              {{ atlasPreview.count }} 张共用同一取景框 · 已生成 {{ atlasPreviewRows.length }} / {{ atlasPreview.total }} 张 ·
              以下都是裁切后的实际效果（PNG，保留透明通道）
            </p>
          </div>
          <button class="atlas-close" type="button" title="关闭 (Esc)" @click="closeAtlasPreview">×</button>
        </header>

        <div v-if="atlasPreview.done < atlasPreview.total" class="atlas-progress">
          <span class="atlas-progress-bar">
            <span class="atlas-progress-fill" :style="{ width: `${(atlasPreview.done / Math.max(1, atlasPreview.total)) * 100}%` }"></span>
          </span>
          <span class="mono">正在裁切 {{ atlasPreview.done }} / {{ atlasPreview.total }}</span>
        </div>

        <div v-if="atlasPreviewRows.length" class="atlas-grid">
          <figure v-for="row in atlasPreviewRows" :key="row.id" class="atlas-item">
            <div class="atlas-thumb">
              <img :src="row.url" :alt="row.name" loading="lazy" />
            </div>
            <figcaption>
              <span class="atlas-name" :title="row.name">{{ row.name }}</span>
              <span class="atlas-size mono">{{ row.sourceWidth }}×{{ row.sourceHeight }} → {{ row.width }}×{{ row.height }}</span>
            </figcaption>
          </figure>
        </div>
        <p v-else-if="atlasPreview.done >= atlasPreview.total" class="atlas-empty">预览生成失败，请重新勾选素材后重试。</p>

        <footer class="atlas-foot">
          <span class="muted">预览按当前并集取景框实际裁切，不会改动素材，也不会写入资源库。</span>
          <button class="btn is-mini" type="button" @click="closeAtlasPreview">关闭</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  /* 与 WatermarkPanel 保持同一宽度：两种模式切换时右侧栏不应跳动 */
  width: 336px;
  flex: none;
  border-left: 1px solid var(--border);
}

.inspector-scroll {
  flex: 1;
  overflow-y: auto;
}

.section.is-last {
  border-bottom: none;
}

.empty {
  margin: 0;
  font-size: 11px;
}

.kv {
  margin: 0 0 10px;
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
}

.kv-row dd {
  margin: 0;
  text-align: right;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.accent {
  color: var(--accent);
}

.trim-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  padding: 8px;
  margin-bottom: 10px;
  border-radius: var(--radius);
  background: var(--panel-2);
}

.trim {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.trim-edge {
  color: var(--text-muted);
  font-size: 10px;
}

.row-actions {
  display: flex;
  gap: 6px;
}

.row-actions .btn {
  flex: 1;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}

.check-row input {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
}

.mt-6 {
  margin-top: 6px;
}

.color-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.color-label {
  color: var(--text-2);
}

.color-input {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 10px;
}

.color-input input[type='color'] {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: none;
  cursor: pointer;
}

.quality {
  margin-top: 12px;
}

.note {
  margin: 6px 0 10px;
  font-size: 10px;
  line-height: 1.6;
}

.error {
  margin: 0 0 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
  font-size: 11px;
}

.is-last .btn + .btn {
  margin-top: 6px;
}

/* ---------- 图集透明裁剪预览 ---------- */
.atlas-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  background: rgba(8, 10, 14, 0.66);
  backdrop-filter: blur(3px);
}

.atlas-dialog {
  display: flex;
  flex-direction: column;
  width: min(960px, 100%);
  max-height: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 10px);
  background: var(--panel);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.atlas-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--border);
}

.atlas-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.atlas-sub {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.atlas-close {
  flex: none;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.atlas-close:hover {
  background: var(--panel-2);
  color: var(--text);
}

.atlas-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 0;
  font-size: 10px;
  color: var(--text-muted);
}

.atlas-progress-bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--panel-2);
  overflow: hidden;
}

.atlas-progress-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.15s linear;
}

.atlas-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  padding: 14px 16px;
  overflow: auto;
}

.atlas-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  min-width: 0;
}

.atlas-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  /* 棋盘格底：便于确认透明区域是否保留 */
  background-color: var(--panel-2);
  background-image: repeating-conic-gradient(rgba(255, 255, 255, 0.08) 0% 25%, transparent 0% 50%);
  background-size: 12px 12px;
  overflow: hidden;
}

.atlas-thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}

.atlas-item figcaption {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.atlas-name {
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.atlas-size {
  font-size: 10px;
  color: var(--text-muted);
}

.atlas-empty {
  margin: 0;
  padding: 40px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.atlas-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
</style>
