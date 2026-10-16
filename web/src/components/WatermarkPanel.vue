<script setup>
/**
 * 水印模式的右侧检查器：检测参数 → 掩膜编辑 → 引擎 → 结果/导出。
 *
 * 与 InspectorPanel 保持同一套版式与 class（.panel/.panel-title/.section/.kv/.chip…），
 * 这样切换模式时右侧面板不会“换一套视觉语言”。
 */
import { computed } from 'vue';
import RangeField from './ui/RangeField.vue';
import SwitchField from './ui/SwitchField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import { useWorkspace } from '../composables/useWorkspace.js';
import { useWatermark } from '../composables/useWatermark.js';
import { SERVER_HINT } from '../lib/watermark.js';
import { formatBytes, formatRatio } from '../lib/imaging.js';

const { state: workspaceState, selected, stats, actions: workspaceActions } = useWorkspace();
const { state, selectedEntry, hasMask, coverage, actions } = useWatermark();

const METHOD_LABELS = {
  auto: { label: '自动', hint: '后端依次尝试叠加/周期/模板策略，取最可信的结果' },
  overlay: { label: '叠加', hint: '适合固定在某个位置的半透明叠加水印' },
  periodic: { label: '周期', hint: '适合平铺/重复出现的水印（时间戳、网点）' },
  template: { label: '模板', hint: '需要提供水印模板图，当前前端尚未提供模板上传入口' },
};

const ENGINE_LABELS = {
  auto: { label: '自动' },
  unblend: { label: 'Unblend' },
  opencv: { label: 'OpenCV' },
  lama: { label: 'LaMa' },
};

const COLOR_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'white', label: '白' },
  { value: 'black', label: '黑' },
  { value: 'custom', label: '自定义' },
];

/** 自定义色时取色器落在这个默认值上（契约要的是 #rrggbb）。 */
const CUSTOM_COLOR_FALLBACK = '#ffffff';

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'webp', label: 'WebP' },
  { value: 'jpeg', label: 'JPEG' },
];

const TOOLS = [
  { value: 'paint', label: '涂抹', hint: '把像素加入掩膜（会被去除）' },
  { value: 'erase', label: '擦除', hint: '把像素移出掩膜（保留原样）' },
];

const item = computed(() => selected.value);
const entry = computed(() => selectedEntry.value);
const detect = computed(() => entry.value?.detect ?? null);
const result = computed(() => entry.value?.result ?? null);
const qualityVisible = computed(() => state.options.format !== 'png');

const methods = computed(() => {
  const list = state.health.checked ? state.health.detectMethods : [];
  const usable = list.length ? list : Object.keys(METHOD_LABELS);
  return usable.map((value) => ({ value, ...(METHOD_LABELS[value] ?? { label: value }) }));
});

const engines = computed(() => {
  const list = state.health.checked ? state.health.engines : [];
  const usable = list.length ? list : Object.keys(ENGINE_LABELS);
  return usable.map((value) => ({ value, ...(ENGINE_LABELS[value] ?? { label: value }) }));
});

const engineText = computed(() => result.value?.engine ?? '—');

/** 当前选的是自定义色（#rrggbb）还是 auto/white/black。 */
const isCustomColor = computed(() => String(state.options.watermarkColor).startsWith('#'));

/** 分段控件的取值：自定义色在控件里没有对应项，用 'custom' 占位保持高亮。 */
const colorChoice = computed(() => (isCustomColor.value ? 'custom' : state.options.watermarkColor));

function setColorChoice(value) {
  actions.setOption('watermarkColor', value === 'custom' ? CUSTOM_COLOR_FALLBACK : value);
}

/** 服务端能力提示：把 health 里的可用性翻译成人话，避免用户选了不可用的引擎。 */
const capability = computed(() => {
  if (!state.health.checked) return { text: '正在检查水印服务…', tone: 'muted' };
  if (!state.health.ok) return { text: SERVER_HINT, tone: 'danger' };
  const parts = [];
  parts.push(`OpenCV ${state.health.opencv ? '可用' : '不可用'}`);
  if (state.health.lama) {
    const size = state.health.lamaBytes ? `（模型 ${formatBytes(state.health.lamaBytes)}）` : '';
    parts.push(`LaMa 可用${size}`);
  } else {
    parts.push('LaMa 不可用');
  }
  return { text: parts.join(' · '), tone: state.health.lama || state.health.opencv ? 'ok' : 'danger' };
});

const removable = computed(() =>
  workspaceState.items.filter((candidate) => state.entries[candidate.id]?.maskState.mask),
);

const exportable = computed(() =>
  workspaceState.items.filter((candidate) => state.entries[candidate.id]?.result?.blob),
);

const busyText = computed(() => {
  const { done, total, label } = state.progress;
  if (!total) return label || '处理中…';
  return `${label || '处理中'}（${done + 1}/${total}）`;
});

/** 画笔/橡皮切换：分段控件只需要这两个取值，其余状态交给画布的 Alt/右键临时切换。 */
function setTool(value) {
  actions.setBrush('tool', value);
}

async function pickTemplate() {  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    actions.setOption('templateDataUrl', dataUrl);
    actions.setOption('templateName', file.name);
  };
  input.click();
}
</script>

<template>
  <aside class="inspector panel">
    <div class="panel-title">
      <span>水印检查器</span>
      <span class="chip">{{ detect?.method ?? state.options.method }}</span>
    </div>

    <div class="inspector-scroll">
      <!-- 检测参数 -->
      <section class="section">
        <h3 class="section-title">检测</h3>

        <SegmentedControl
          block
          :model-value="state.options.method"
          :options="methods"
          @update:model-value="actions.setOption('method', $event)"
        />
        <p class="muted note">{{ methods.find((m) => m.value === state.options.method)?.hint }}</p>

        <div v-if="state.options.method === 'template'" class="template-row">
          <button class="btn is-block" type="button" @click="pickTemplate">
            {{ state.options.templateName || '选择水印模板图…' }}
          </button>
          <p class="muted note">
            模板模式需要模板图；当前后端契约未开放该入口，选择后仍会用当前素材自身作为模板占位。
          </p>
        </div>

        <RangeField
          label="灵敏度"
          :model-value="state.options.sensitivity"
          :min="0"
          :max="100"
          hint="越高越容易把接近背景的像素判为水印，误检也会变多。"
          @update:model-value="actions.setOption('sensitivity', $event)"
        />

        <RangeField
          label="膨胀"
          :model-value="state.options.dilate"
          :min="0"
          :max="64"
          suffix="px"
          hint="把检测到的水印区域向外扩张，避免去除后留下半透明残边。"
          @update:model-value="actions.setOption('dilate', $event)"
        />

        <RangeField
          label="最小面积"
          :model-value="state.options.minArea"
          :min="1"
          :max="4096"
          suffix="px"
          hint="小于该面积的连通区域会被丢弃，用来滤掉噪点。"
          @update:model-value="actions.setOption('minArea', $event)"
        />

        <RangeField
          label="覆盖率上限"
          :model-value="Math.round(state.options.maxCoverage * 100)"
          :min="0"
          :max="100"
          suffix="%"
          hint="掩膜超过该比例时视为检测失败，防止把整张图都当水印涂掉。"
          @update:model-value="actions.setOption('maxCoverage', $event / 100)"
        />

        <button
          class="btn is-primary is-block"
          type="button"
          :disabled="state.busy || !item"
          @click="actions.detectFor(item)"
        >
          自动检测水印
        </button>
      </section>

      <!-- 掩膜编辑 -->
      <section class="section">
        <h3 class="section-title">掩膜</h3>

        <p v-if="!item" class="muted empty">选择左侧任意素材后即可检测与编辑掩膜。</p>
        <p v-else-if="!hasMask" class="muted empty">还没有掩膜：先点上面的「自动检测水印」。</p>

        <template v-else>
          <SegmentedControl block :model-value="state.brush.tool" :options="TOOLS" @update:model-value="setTool" />

          <RangeField
            label="画笔半径"
            :model-value="state.brush.radius"
            :min="1"
            :max="200"
            suffix="px"
            hint="在画布上按住左键涂抹；Alt 或右键临时切成橡皮。涂抹实时生效，不会请求后端。"
            @update:model-value="actions.setBrush('radius', $event)"
          />

          <RangeField
            label="羽化"
            :model-value="state.options.feather"
            :min="0"
            :max="20"
            suffix="px"
            hint="掩膜边缘做软过渡，去除后拼接更自然；编码时会一并做本地模糊。"
            @update:model-value="actions.setOption('feather', $event)"
          />

          <SwitchField
            label="显示掩膜叠加"
            :model-value="state.brush.showOverlay"
            hint="关掉可以只看源图，方便判断水印是否已经清理干净。"
            @update:model-value="actions.setBrush('showOverlay', $event)"
          />

          <div class="row-actions">
            <button class="btn" type="button" @click="actions.undoMask()">撤销涂抹</button>
            <button class="btn" type="button" @click="actions.invertMask()">反选</button>
            <button class="btn" type="button" @click="actions.clearMask()">清空</button>
          </div>

          <dl class="kv is-tight">
            <div class="kv-row">
              <dt>掩膜尺寸</dt>
              <dd class="mono">{{ entry.maskState.width }} × {{ entry.maskState.height }}</dd>
            </div>
            <div class="kv-row">
              <dt>覆盖面积</dt>
              <dd class="mono accent">{{ formatRatio(coverage, 2) }}</dd>
            </div>
            <div class="kv-row">
              <dt>掩膜状态</dt>
              <dd class="mono">{{ entry.dirty ? '已本地修改' : '与服务端一致' }}</dd>
            </div>
          </dl>
        </template>
      </section>

      <!-- 去除引擎 -->
      <section class="section">
        <h3 class="section-title">去除</h3>

        <SegmentedControl
          block
          :model-value="state.options.engine"
          :options="engines"
          @update:model-value="actions.setOption('engine', $event)"
        />
        <p class="muted note" :class="{ 'is-danger': capability.tone === 'danger', 'is-ok': capability.tone === 'ok' }">
          {{ capability.text }}
        </p>

        <div class="color-row">
          <label class="color-label">水印颜色</label>
          <div class="color-input">
            <input
              v-if="isCustomColor"
              type="color"
              :value="state.options.watermarkColor"
              @input="actions.setOption('watermarkColor', $event.target.value)"
            />
            <span class="mono">{{ state.options.watermarkColor }}</span>
          </div>
        </div>
        <SegmentedControl block :model-value="colorChoice" :options="COLOR_OPTIONS" @update:model-value="setColorChoice" />
        <p class="muted note">水印本身是纯色（白/黑/透明）时选自动，能显著提升还原质量。</p>

        <RangeField
          label="内画半径"
          :model-value="state.options.inpaintRadius"
          :min="1"
          :max="20"
          suffix="px"
          hint="修复时参考的邻域半径，越大越平滑，也越容易糊掉细节。"
          @update:model-value="actions.setOption('inpaintRadius', $event)"
        />

        <button
          class="btn is-primary is-block"
          type="button"
          :disabled="state.busy || !hasMask"
          @click="actions.removeFor(item)"
        >
          执行去除
        </button>
        <button
          class="btn is-block"
          type="button"
          :disabled="state.busy || removable.length === 0"
          @click="actions.removeBatch()"
        >
          批量去除（{{ removable.length }} 张）
        </button>
        <p v-if="state.busy && state.progress.total" class="muted note">{{ busyText }}</p>
      </section>

      <!-- 结果与导出 -->
      <section class="section is-last">
        <h3 class="section-title">结果</h3>

        <p v-if="!item" class="muted empty">尚未选择素材。</p>

        <template v-else>
          <dl class="kv">
            <div class="kv-row">
              <dt>检测方式</dt>
              <dd class="mono">
                {{ detect ? detect.usedMethods.join(' + ') || detect.method : '—' }}
              </dd>
            </div>
            <div class="kv-row">
              <dt>置信度</dt>
              <dd class="mono">{{ detect ? formatRatio(detect.confidence, 1) : '—' }}</dd>
            </div>
            <div class="kv-row">
              <dt>覆盖面积</dt>
              <dd class="mono accent">{{ hasMask ? formatRatio(coverage, 2) : '—' }}</dd>
            </div>
            <div class="kv-row">
              <dt>候选区域</dt>
              <dd class="mono">{{ detect?.boxes?.length ?? 0 }} 个</dd>
            </div>
            <div class="kv-row">
              <dt>引擎 / 耗时</dt>
              <dd class="mono">
                {{ engineText }}
                <template v-if="detect?.elapsedMs || result?.elapsedMs">
                  · {{ result?.elapsedMs || detect?.elapsedMs }}ms
                </template>
              </dd>
            </div>
            <div class="kv-row">
              <dt>原图</dt>
              <dd class="mono">{{ item.width }} × {{ item.height }} · {{ formatBytes(item.bytes) }}</dd>
            </div>
            <div v-if="result" class="kv-row">
              <dt>输出</dt>
              <dd class="mono">{{ formatBytes(result.blob?.size ?? 0) }}</dd>
            </div>
          </dl>

          <p v-if="entry?.error" class="error">{{ entry.error }}</p>

          <SegmentedControl
            block
            :model-value="state.options.format"
            :options="FORMATS"
            @update:model-value="actions.setOption('format', $event)"
          />
          <RangeField
            v-if="qualityVisible"
            class="quality"
            label="质量"
            :model-value="state.options.quality"
            :min="10"
            :max="100"
            suffix="%"
            @update:model-value="actions.setOption('quality', $event)"
          />
          <p v-else class="muted note">PNG 为无损输出，保留 alpha 通道。</p>

          <button class="btn is-primary is-block" type="button" :disabled="!result" @click="actions.downloadResult(item)">
            下载去除结果
          </button>
          <button
            class="btn is-block"
            type="button"
            :disabled="exportable.length === 0"
            @click="actions.exportBatchZip()"
          >
            打包下载 ZIP（{{ exportable.length }} 张）
          </button>
          <button class="btn is-block is-ghost" type="button" :disabled="state.busy" @click="actions.checkHealth()">
            重新检查水印服务
          </button>
        </template>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  width: 288px;
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
  line-height: 1.7;
}

.note {
  margin: 6px 0 10px;
  font-size: 10px;
  line-height: 1.6;
}

.note.is-danger {
  color: var(--danger);
}

.note.is-ok {
  color: var(--ok);
}

.kv {
  margin: 0 0 10px;
}

.kv.is-tight {
  margin-top: 10px;
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

.row-actions {
  display: flex;
  gap: 6px;
}

.row-actions .btn {
  flex: 1;
}

.color-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 10px 0 6px;
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

.template-row {
  margin-bottom: 12px;
}

.quality {
  margin-top: 12px;
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
</style>
