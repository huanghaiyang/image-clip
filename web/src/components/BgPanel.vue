<script setup>
/**
 * 背景去除右侧面板
 * ----------------
 * 参数修改后由 useBgRemoval 做 140ms 防抖重算（预览分辨率），
 * 因此拖动滑块的反馈是实时的；这里只负责把控件和状态接起来。
 */
import { computed, onMounted, ref, watch } from 'vue';

import { CUTOUT_MODELS } from '@shared/cutout.js';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useBgRemoval } from '../composables/useBgRemoval.js';
import RangeField from './ui/RangeField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchField from './ui/SwitchField.vue';

const { selected, checkedItems } = useWorkspace();
const { state, activeEntry, cutoutModels, actions } = useBgRemoval();

const entry = computed(() => activeEntry.value);
const item = computed(() => selected.value ?? null);
const customColor = ref('#ffffff');
const saveToLibrary = ref(false);
const batchSaveToLibrary = ref(false);
const itemCount = computed(() => checkedItems.value.length);

const modeTabs = [
  { value: 'ai', label: 'AI 抠图', hint: '用浏览器内模型自动识别主体' },
  { value: 'color', label: '参数抠图', hint: '按背景色与容差去除' },
];

const toolOptions = [
  { value: 'lasso', label: '套索', hint: '手绘或智能选区，限定去除范围或保护内容' },
  { value: 'pick', label: '取色器', hint: '点击画面取背景色' },
  { value: 'hole', label: '噪点', hint: '点选画面上的孔洞将其移除' },
  { value: 'pan', label: '平移', hint: '拖动查看大图' },
];

const lassoModeOptions = [
  { value: 'smart', label: '智能套索', hint: '落点自动吸附到图像边缘，松开后自动简化顶点' },
  { value: 'free', label: '手绘套索', hint: '完全按拖动轨迹生成选区' },
];

const selectionModeOptions = [
  { value: 'inside', label: '仅选区内', hint: '只去除套索范围内的背景色' },
  { value: 'outside', label: '保护选区', hint: '套索内保持不变，只处理外部' },
  { value: 'all', label: '忽略选区', hint: '全图按颜色去除' },
];

const coverageText = computed(() => {
  const e = entry.value;
  if (!e) return '—';
  return `${(e.coverage * 100).toFixed(2)}%`;
});

const topHoles = computed(() => {
  const e = entry.value;
  if (!e?.holes?.length) return [];
  return e.holes.slice(0, 8); // 面积已按降序排列
});

/** 孔洞列表默认只列前 8 个，点「其余 N 个」展开全部；切换素材时收起。 */
const showAllHoles = ref(false);
const holesToShow = computed(() => (showAllHoles.value ? entry.value?.holes ?? [] : topHoles.value));
watch(entry, () => {
  showAllHoles.value = false;
});

// ------------------------------------------------------------ AI 精准抠像
const aiModelOptions = CUTOUT_MODELS.map((model) => ({ value: model.id, label: model.label, hint: model.hint }));
const aiModel = computed(() => CUTOUT_MODELS.find((model) => model.id === entry.value?.ai.model) ?? null);
const aiModelState = computed(() => cutoutModels.models.find((model) => model.id === entry.value?.ai.model) ?? null);
const aiBusy = computed(() => entry.value?.ai.status === 'running' || state.busy);
const aiProgressText = computed(() => {
  const progress = entry.value?.ai.progress;
  if (!progress) return '';
  if (progress.phase === 'download') {
    const percent = progress.total ? `${Math.round((progress.loaded / progress.total) * 100)}%` : '';
    return `首次使用，下载模型 ${percent}`;
  }
  return progress.message ?? '';
});

onMounted(() => actions.loadCutoutStatus());

function runAi() {
  if (!entry.value || aiBusy.value) return;
  actions.runAiCutout(entry.value.ai.model);
}

function addCustomColor() {
  actions.useColor(customColor.value);
}

function runBatch() {
  if (!entry.value || state.batch.running || state.busy) return;
  void actions.batchBackgroundRemoval({ saveToLibrary: batchSaveToLibrary.value });
}
</script>

<template>
  <aside class="panel bg-panel">
    <div class="panel-title">
      <span>背景去除</span>
      <span class="chip">{{ state.tool === 'lasso' ? '套索' : state.tool === 'pick' ? '取色器' : state.tool === 'hole' ? '噪点' : '平移' }}</span>
    </div>

    <div class="panel-body">
      <p v-if="!item || !entry" class="empty muted">请先在左侧选择一张图片。</p>

      <template v-else>
        <section class="section">
          <SegmentedControl
            :model-value="state.tab"
            :options="modeTabs"
            block
            @update:model-value="actions.setTab($event)"
          />
          <p v-if="entry.mode === 'none'" class="hint">
            当前未抠图：在「AI 抠图」运行模型，或在「参数抠图」开始抠图后才会生成掩膜。
          </p>
        </section>

        <section class="section">
          <h3 class="section-title">工具</h3>
          <SegmentedControl :model-value="state.tool" :options="toolOptions" size="sm" block @update:model-value="actions.setTool($event)" />
        </section>

        <section v-if="state.tab === 'color'" class="section">
          <div class="section-head">
            <h3 class="section-title">背景色</h3>
            <button class="btn is-ghost is-mini" type="button" @click="actions.autoDetectColors()">重新自动识别</button>
          </div>

          <div class="color-list">
            <div
              v-for="(color, index) in entry.colors"
              :key="`${color.hex}-${index}`"
              class="color-row"
              :class="{ 'is-off': !color.enabled }"
            >
              <button
                class="swatch"
                type="button"
                :style="{ background: color.hex }"
                :title="color.enabled ? '点击停用该颜色' : '点击启用该颜色'"
                @click="actions.toggleColor(index)"
              />
              <span class="color-hex mono">{{ color.hex.toUpperCase() }}</span>
              <span class="color-tag">{{
                color.source === 'custom' ? '自定义' : `${(color.ratio * 100).toFixed(1)}%`
              }}</span>
              <button class="color-remove" type="button" title="移除" @click="actions.removeColor(index)">×</button>
            </div>
          </div>

          <div class="color-add">
            <input v-model="customColor" type="color" class="color-input" />
            <button class="btn is-mini" type="button" @click="addCustomColor">添加颜色</button>
          </div>
          <p class="hint">
            默认从画面四边取样识别主色。勾选的颜色都会按容差去除；取色器会切换为「仅去除该颜色」。
          </p>
        </section>

        <section v-if="state.tab === 'ai'" class="section">
          <div class="section-head">
            <h3 class="section-title">AI 精准抠像</h3>
            <span v-if="entry.ai.alpha" class="chip">已接管掩膜</span>
          </div>
          <SegmentedControl
            :model-value="entry.ai.model"
            :options="aiModelOptions"
            size="sm"
            block
            @update:model-value="actions.setAiModel($event)"
          />
          <div class="ai-actions">
            <button class="btn is-primary is-mini" type="button" :disabled="aiBusy" @click="runAi">
              {{ entry.ai.status === 'running' ? '计算中…' : entry.ai.alpha ? '重新运行' : '运行 AI 抠像' }}
            </button>
            <button v-if="entry.ai.alpha" class="btn is-ghost is-mini" type="button" @click="actions.clearAiCutout()">
              清除结果
            </button>
          </div>
          <p v-if="aiProgressText" class="hint mono">{{ aiProgressText }}</p>
          <p v-if="entry.ai.error" class="hint is-warn">{{ entry.ai.error }}</p>
          <p v-if="aiModelState && !aiModelState.available" class="hint is-warn">
            该模型尚未下载：在项目根目录执行
            <code class="mono">npm run model:cutout -- --model {{ entry.ai.model }}</code>
            后刷新页面。
          </p>
          <p v-if="aiModel" class="hint">{{ aiModel.hint }}</p>
          <p class="hint">
            在浏览器内用 WASM 推理，模型只在本机下载一次；结果直接接管抠图掩膜，颜色容差 / 连通区域不再参与计算，羽化、向内收缩和套索选区仍然生效。
          </p>
        </section>

        <section v-if="state.tab === 'color'" class="section">
          <h3 class="section-title">去除参数</h3>
          <RangeField
            label="颜色容差"
            :model-value="entry.options.tolerance"
            :min="0"
            :max="120"
            :step="1"
            hint="越大去掉的背景越多，也越容易误伤与背景接近的主体颜色"
            @update:model-value="actions.setOption('tolerance', $event)"
          />
          <SwitchField
            label="只去除与边缘连通区域"
            :model-value="entry.options.connected"
            hint="关闭后，画面内部与背景同色的部分也会被抠掉"
            @update:model-value="actions.setOption('connected', $event)"
          />
          <RangeField
            label="边缘羽化"
            :model-value="entry.options.feather"
            :min="0"
            :max="20"
            suffix="px"
            hint="让抠图边缘过渡更自然，适合毛发或抗锯齿边缘"
            @update:model-value="actions.setOption('feather', $event)"
          />
          <RangeField
            label="向内收缩"
            :model-value="entry.options.erode"
            :min="0"
            :max="10"
            suffix="px"
            hint="先腐蚀再羽化，可去掉背景色残留的一圈描边"
            @update:model-value="actions.setOption('erode', $event)"
          />
          <SwitchField
            label="边缘颜色反混合"
            :model-value="entry.options.decontaminate"
            hint="按公式反算前景色，消除半透明边缘的底色污染"
            @update:model-value="actions.setOption('decontaminate', $event)"
          />
          <button
            v-if="entry.mode === 'none'"
            class="btn is-primary is-block mt-8"
            type="button"
            @click="actions.startColorRemoval()"
          >
            开始参数抠图
          </button>
        </section>

        <section v-if="state.tab === 'ai'" class="section">
          <h3 class="section-title">边缘处理</h3>
          <RangeField
            label="边缘羽化"
            :model-value="entry.options.feather"
            :min="0"
            :max="20"
            suffix="px"
            hint="让 AI 掩膜边缘过渡更自然，适合毛发或抗锯齿边缘"
            @update:model-value="actions.setOption('feather', $event)"
          />
          <RangeField
            label="向内收缩"
            :model-value="entry.options.erode"
            :min="0"
            :max="10"
            suffix="px"
            hint="先腐蚀再羽化，可去掉主体外沿残留的一圈背景色"
            @update:model-value="actions.setOption('erode', $event)"
          />
          <SwitchField
            label="边缘颜色反混合"
            :model-value="entry.options.decontaminate"
            hint="按公式反算前景色，消除半透明边缘的底色污染"
            @update:model-value="actions.setOption('decontaminate', $event)"
          />
        </section>

        <section v-if="entry.mode !== 'none'" class="section">
          <h3 class="section-title">噪点处理</h3>
          <SwitchField
            label="自动去噪"
            :model-value="entry.options.autoRemoveHoles"
            hint="预览实时生效：把面积 ≤ 阈值、被去除区域完全包围的小孔洞直接填掉"
            @update:model-value="actions.setOption('autoRemoveHoles', $event)"
          />
          <RangeField
            label="最小孔洞面积"
            :model-value="entry.options.maxHoleArea"
            :min="1"
            :max="200"
            :step="1"
            suffix="px"
            hint="面积 ≤ 该值 的孔会被自动填掉；默认 2"
            :disabled="!entry.options.autoRemoveHoles"
            @update:model-value="actions.setOption('maxHoleArea', $event)"
          />

          <div class="hole-status">
            <span class="muted">检测到</span>
            <span class="mono accent">{{ entry.holes.length }}</span>
            <span class="muted">个孔洞（预览分辨率像素）</span>
          </div>

          <template v-if="topHoles.length">
            <div class="hole-list" :class="{ 'is-expanded': showAllHoles }">
              <div v-for="hole in holesToShow" :key="hole.id" class="hole-row">
                <span class="mono">{{ hole.area }}px</span>
                <span class="hole-pos mono">@ {{ hole.bbox.x }},{{ hole.bbox.y }}</span>
                <button
                  class="btn is-ghost is-mini"
                  type="button"
                  title="移除此孔洞"
                  @click="actions.removeHole(entry, hole.id)"
                >
                  移除
                </button>
              </div>
              <button
                v-if="entry.holes.length > topHoles.length"
                class="hole-more muted"
                type="button"
                :title="showAllHoles ? '只显示面积最大的 8 个' : '展开全部孔洞'"
                @click="showAllHoles = !showAllHoles"
              >
                {{ showAllHoles ? '收起列表' : `其余 ${entry.holes.length - topHoles.length} 个略…` }}
              </button>
            </div>
            <button class="btn is-block mt-8" type="button" @click="actions.applyAllHoles(entry)">
              一键移除全部孔洞（{{ entry.holes.length }}）
            </button>
            <p class="hint">
              也可以切到右侧「噪点」工具直接在画面上点选；已移除的孔洞会跟随参数撤销/重做。
            </p>
          </template>
          <p v-else class="hint">
            没有检测到孔洞。参数抠图模式下确认「只去除与边缘连通区域」已开启，主体身上的残留杂点才会被识别为孔洞。
          </p>
        </section>

        <section class="section">
          <div class="section-head">
            <h3 class="section-title">套索选区</h3>
            <button class="btn is-ghost is-mini" type="button" :disabled="!entry.polygon.length" @click="actions.clearSelection()">
              清除
            </button>
          </div>
          <SegmentedControl
            v-if="state.tool === 'lasso'"
            :model-value="entry.options.lassoMode"
            :options="lassoModeOptions"
            size="sm"
            block
            @update:model-value="actions.setOption('lassoMode', $event)"
          />
          <template v-if="state.tool === 'lasso' && entry.options.lassoMode === 'smart'">
            <RangeField
              label="吸附半径"
              :model-value="entry.options.lassoRadius"
              :min="6"
              :max="28"
              :step="1"
              suffix="px"
              hint="鼠标离轮廓多远仍会被吸住：小一点更贴合，大一点更省力；改动会立即重算当前选区"
              @update:model-value="actions.setOption('lassoRadius', $event)"
            />
            <RangeField
              label="路径简化"
              :model-value="entry.options.lassoSimplify"
              :min="0"
              :max="6"
              :step="0.2"
              suffix="px"
              hint="越小折角越圆润、顶点越多；0 保留全部吸附点，越大越利落；改动会立即重算当前选区"
              @update:model-value="actions.setOption('lassoSimplify', $event)"
            />
          </template>
          <SegmentedControl
            :model-value="entry.options.selectionMode"
            :options="selectionModeOptions"
            size="sm"
            block
            @update:model-value="actions.setOption('selectionMode', $event)"
          />
          <p class="hint">
            <template v-if="entry.polygon.length">
              选区有 {{ entry.polygon.length }} 个顶点，当前模式生效中。
            </template>
            <template v-else-if="entry.options.lassoMode === 'smart'">
              还没有套索选区：切到「套索」后按住拖动，落点会自动吸附到图像边缘；折角偏硬时可调小「路径简化」。
            </template>
            <template v-else>还没有套索选区：切到「套索」后在画面上按住拖动即可。</template>
          </p>
          <SwitchField
            label="显示去除掩膜"
            :model-value="entry.options.showMask"
            hint="红色区域表示会被抠掉的像素"
            @update:model-value="actions.setOption('showMask', $event)"
          />
        </section>

        <section class="section">
          <h3 class="section-title">应用</h3>
          <div class="stat-row">
            <span class="muted">透明面积</span>
            <span class="mono">{{ coverageText }}</span>
          </div>
          <div class="stat-row">
            <span class="muted">去除像素</span>
            <span class="mono">{{ entry.removedPixels.toLocaleString() }}</span>
          </div>
          <div class="stat-row">
            <span class="muted">预览计算</span>
            <span class="mono">{{ entry.elapsedMs }}ms</span>
          </div>

          <button
            class="btn is-primary is-block mt-8"
            type="button"
            :disabled="state.busy"
            @click="actions.applyBackgroundRemoval({ saveToLibrary })"
          >
            {{ state.busy ? '正在处理…' : '按原图分辨率应用' }}
          </button>
          <label class="check-row">
            <input v-model="saveToLibrary" type="checkbox" />
            <span>同时保存到资源库/抠图结果</span>
          </label>
          <p class="hint">
            结果会作为新素材加入左侧列表（PNG，保留透明通道），原图不变；应用后仍停留在原图，可继续调参再应用。
          </p>

          <div class="batch-block">
            <div class="stat-row">
              <span class="muted">批量模板</span>
              <span class="mono">{{ state.tab === 'ai' ? 'AI 模型' : '颜色参数' }}</span>
            </div>
            <div class="stat-row">
              <span class="muted">已勾选素材</span>
              <span class="mono">{{ itemCount }} 张</span>
            </div>
            <button
              class="btn is-block mt-8"
              type="button"
              :disabled="state.batch.running || state.busy || !itemCount"
              @click="runBatch"
            >
              {{ state.batch.running ? `正在批量抠图 ${state.batch.done}/${state.batch.total}` : `批量抠图（${itemCount} 张）` }}
            </button>
            <label class="check-row">
              <input v-model="batchSaveToLibrary" type="checkbox" />
              <span>批量结果同时保存到资源库/抠图结果</span>
            </label>
            <p class="hint">
              参考裁剪的图集模式：只处理左侧「当前素材」中勾选的图片；以当前{{ state.tab === 'ai' ? ' AI 模型' : ' 颜色参数与容差' }}为统一模板，套索选区按图片比例换算。
            </p>
          </div>
        </section>

        <p v-if="entry.error" class="panel-error">{{ entry.error }}</p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.bg-panel {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex: none;
  border-left: 1px solid var(--border);
}

.panel-body {
  flex: 1;
  overflow-y: auto;
}

.empty {
  padding: 14px 12px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-head .section-title {
  margin: 0;
}

.ai-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.hint.is-warn {
  color: var(--warn);
}

.is-mini {
  height: 22px;
  padding: 0 6px;
  font-size: 10px;
}

.color-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.color-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.color-row.is-off {
  opacity: 0.45;
}

.swatch {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
}

.color-hex {
  font-size: 10px;
}

.color-tag {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 10px;
}

.color-remove {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
}

.color-remove:hover {
  color: var(--danger);
}

.color-add {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.color-input {
  width: 28px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.stat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0;
  font-size: 11px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: var(--text-2);
  font-size: 11px;
}

.check-row input {
  accent-color: var(--accent);
}

.mt-8 {
  margin-top: 8px;
}

.batch-block {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.panel-error {
  margin: 10px 12px;
  color: var(--danger);
  font-size: 11px;
}

.hole-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  margin: 6px 0;
}

.hole-status .accent {
  color: var(--accent);
  font-weight: 600;
}

.hole-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 4px;
}

/* 展开后限制高度，孔洞很多时在列表内部滚动，不把整个面板撑长 */
.hole-list.is-expanded {
  max-height: 220px;
  overflow-y: auto;
  padding-right: 2px;
}

.hole-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  font-size: 11px;
}

.hole-pos {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 10px;
}

.hole-more {
  align-self: flex-end;
  margin-top: 2px;
  font-size: 10px;
}
</style>
