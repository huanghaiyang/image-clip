<script setup>
/**
 * 合成工作室 · 右侧面板
 * ---------------------
 * 五个 tab：图层 / 变换与调色 / 选区 / 动画 / 导出。
 * 所有动作都走 useStudio，面板不直接碰像素；滑块只改参数，
 * 渲染由舞台按 state.version 重算。
 */
import { computed, ref } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useStudio, easingPresets, trackProperties } from '../composables/useStudio.js';
import { BLEND_MODES } from '@shared/compose/doc.js';
import { maskBounds } from '@shared/maskops.js';
import RangeField from './ui/RangeField.vue';

const { state, actions, computed: studioComputed } = useStudio();
const workspace = useWorkspace();

const doc = computed(() => state.doc);
const layers = computed(() => (state.doc ? [...state.doc.layers].reverse() : []));
const activeLayer = computed(() => (state.doc ? state.doc.layers.find((layer) => layer.id === state.activeLayerId) ?? null : null));
const selectedCount = computed(() =>
  workspace.checkedItems.value.length ? workspace.checkedItems.value.length : workspace.selected.value ? 1 : 0,
);
const adjustValues = computed(() => activeLayer.value?.adjust ?? null);
const coverage = computed(() => (state.selection.mask ? actions.selectionCoverage() * 100 : 0));
const selectionBox = computed(() => (state.selection.mask ? maskBounds(state.selection.mask) : null));
const activeTracks = studioComputed.activeTracks;

const cubeInput = ref(null);
const textContent = ref('文字');

const TS = [
  { value: 'layers', label: '图层' },
  { value: 'adjust', label: '变换/调色' },
  { value: 'select', label: '选区' },
  { value: 'anim', label: '动画' },
  { value: 'export', label: '导出' },
];

const ADJUST_FIELDS = [
  { key: 'exposure', label: '曝光', hint: '-100~100 等价 ±2 档' },
  { key: 'contrast', label: '对比度' },
  { key: 'saturation', label: '饱和度' },
  { key: 'temperature', label: '色温', hint: '负=偏蓝，正=偏黄' },
  { key: 'tint', label: '色调', hint: '负=偏绿，正=偏洋红' },
  { key: 'highlights', label: '高光' },
  { key: 'shadows', label: '阴影' },
  { key: 'whites', label: '白场' },
  { key: 'blacks', label: '黑场' },
];

function buildDoc() {
  const list = workspace.checkedItems.value.length ? workspace.checkedItems.value : [workspace.selected.value].filter(Boolean);
  actions.buildFromItems(list, { replace: true });
}

function addSelection() {
  const list = workspace.checkedItems.value.length ? workspace.checkedItems.value : [workspace.selected.value].filter(Boolean);
  actions.addItemsAsLayers(list);
}

function openCube() {
  cubeInput.value?.click();
}

async function onCubeFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  actions.loadCube(await file.text(), file.name);
  event.target.value = '';
}

function addText() {
  const layer = actions.addTextLayer(textContent.value || '文字');
  if (layer) textContent.value = layer.text.content;
}

function setTextContent(value) {
  if (!activeLayer.value) return;
  actions.setActiveLayerProp({ text: { content: value } });
}

function setOpacity(value) {
  actions.setActiveLayerProp({ opacity: Number(value) });
}

function toggleVisible(layer) {
  actions.selectLayer(layer.id);
  actions.setActiveLayerProp({ visible: !layer.visible });
}

function keyLabel(value) {
  return Number(value).toFixed(2);
}
</script>

<template>
  <aside class="panel studio-panel">
    <nav class="studio-tabs" role="tablist">
      <button
        v-for="tab in TS"
        :key="tab.value"
        class="studio-tab"
        type="button"
        :class="{ 'is-active': state.panelTab === tab.value }"
        @click="state.panelTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div class="panel-body">
      <p v-if="!doc" class="empty muted">还没有合成文档，先在左侧选素材再「建立合成」。</p>

      <template v-else>
        <!-- ------------------------------------------------------------ 图层 -->
        <section v-if="state.panelTab === 'layers'" class="section">
          <div class="row-2">
            <button class="btn is-mini" type="button" @click="buildDoc">用选中素材重建</button>
            <button class="btn is-mini" type="button" :disabled="selectedCount === 0" @click="addSelection">
              添加图层 ({{ selectedCount }})
            </button>
          </div>
          <div class="row-3 mt-6">
            <button class="btn is-mini" type="button" @click="actions.addAdjustLayer()">+ 调整层</button>
            <button class="btn is-mini" type="button" @click="actions.duplicateActiveLayer()">复制</button>
            <button class="btn is-mini" type="button" @click="actions.removeActiveLayer()">删除</button>
          </div>

          <div class="text-row mt-6">
            <input v-model="textContent" class="text-input" type="text" maxlength="80" placeholder="文字层内容" />
            <button class="btn is-mini" type="button" @click="addText">+ 文字</button>
          </div>

          <ul class="layer-list">
            <li
              v-for="layer in layers"
              :key="layer.id"
              class="layer-item"
              :class="{ 'is-active': layer.id === state.activeLayerId }"
              @click="actions.selectLayer(layer.id)"
            >
              <button class="eye" type="button" :title="layer.visible ? '隐藏' : '显示'" @click.stop="toggleVisible(layer)">
                {{ layer.visible ? '◉' : '○' }}
              </button>
              <img v-if="layer.kind !== 'adjust'" class="layer-thumb" :src="actions.layerThumb(layer)" alt="" />
              <span v-else class="layer-thumb is-adjust">ADJ</span>
              <div class="layer-meta">
                <span class="layer-name">{{ layer.name }}</span>
                <span class="layer-sub mono">
                  {{ layer.kind }}
                  <template v-if="layer.mask"> · 蒙版</template>
                  · {{ Math.round(layer.opacity) }}%
                </span>
              </div>
              <div class="layer-btns">
                <button class="mini" type="button" title="上移" @click.stop="actions.selectLayer(layer.id); actions.moveActiveLayer(1)">↑</button>
                <button class="mini" type="button" title="下移" @click.stop="actions.selectLayer(layer.id); actions.moveActiveLayer(-1)">↓</button>
              </div>
            </li>
          </ul>
          <p class="hint">图层顺序从下往上合成；调整层只影响它下面的图层（和 PS 一致）。</p>
        </section>

        <!-- ------------------------------------------------------------ 变换 / 调色 -->
        <section v-else-if="state.panelTab === 'adjust'" class="section">
          <p v-if="!activeLayer" class="empty muted">先在上面的图层列表选一个图层。</p>
          <template v-else>
            <h3 class="section-title">图层属性</h3>
            <div class="field-row">
              <input
                class="text-input"
                type="text"
                :value="activeLayer.name"
                maxlength="40"
                @change="actions.setActiveLayerProp({ name: $event.target.value || activeLayer.name })"
              />
            </div>
            <div class="field-row mt-6">
              <label class="mlabel">混合</label>
              <select
                class="text-input"
                :value="activeLayer.blend"
                @change="actions.setActiveLayerProp({ blend: $event.target.value })"
              >
                <option v-for="mode in BLEND_MODES" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
              </select>
            </div>
            <RangeField
              class="mt-6"
              label="不透明度"
              :model-value="activeLayer.opacity"
              :min="0"
              :max="100"
              :step="1"
              suffix="%"
              @update:model-value="setOpacity($event)"
            />

            <h3 class="section-title mt-10">变换</h3>
            <div class="grid-2">
              <label class="num-field"><span>X</span><input class="text-input mono" type="number" :value="Math.round(activeLayer.transform.x)" @change="actions.setTransform('x', $event.target.value)" /></label>
              <label class="num-field"><span>Y</span><input class="text-input mono" type="number" :value="Math.round(activeLayer.transform.y)" @change="actions.setTransform('y', $event.target.value)" /></label>
              <label class="num-field"><span>缩放 X</span><input class="text-input mono" type="number" step="0.01" :value="activeLayer.transform.scaleX" @change="actions.setTransform('scaleX', $event.target.value)" /></label>
              <label class="num-field"><span>缩放 Y</span><input class="text-input mono" type="number" step="0.01" :value="activeLayer.transform.scaleY" @change="actions.setTransform('scaleY', $event.target.value)" /></label>
              <label class="num-field"><span>旋转°</span><input class="text-input mono" type="number" step="1" :value="Math.round(activeLayer.transform.rotation)" @change="actions.setTransform('rotation', $event.target.value)" /></label>
              <label class="num-field"><span>尺寸</span><span class="mono readonly">{{ activeLayer.width }}×{{ activeLayer.height }}</span></label>
            </div>
            <div class="row-3 mt-6">
              <button class="btn is-mini" type="button" @click="actions.flipAxis('x')">水平翻转</button>
              <button class="btn is-mini" type="button" @click="actions.flipAxis('y')">垂直翻转</button>
              <button class="btn is-mini" type="button" @click="actions.resetTransform()">还原</button>
            </div>

            <h3 class="section-title mt-10">调色（曲线 / 色阶 / HSL 编译成 LUT）</h3>
            <p v-if="activeLayer.kind === 'adjust'" class="hint">调整层：作用于它下面的所有图层。</p>
            <p v-else class="hint">图片层：调色烘焙在本层像素上，非破坏性（可随时改）。</p>
            <template v-if="adjustValues">
              <RangeField
                v-for="field in ADJUST_FIELDS"
                :key="field.key"
                class="mt-4"
                :label="field.label"
                :hint="field.hint"
                :model-value="adjustValues[field.key]"
                :min="-100"
                :max="100"
                :step="1"
                @update:model-value="actions.setAdjust(field.key, $event)"
              />
              <div class="row-3 mt-6">
                <button class="btn is-mini" type="button" @click="actions.setAdjust('enabled', !adjustValues.enabled)">
                  {{ adjustValues.enabled ? '停用调整' : '启用调整' }}
                </button>
                <button class="btn is-mini" type="button" @click="openCube">导入 .cube</button>
                <button class="btn is-mini" type="button" @click="actions.resetAdjust()">重置</button>
              </div>
              <button class="btn is-block is-ghost mt-6" type="button" @click="actions.downloadCube()">导出当前调色为 .cube</button>
              <p v-if="activeLayer.cubeLut" class="hint">已叠加 LUT：{{ activeLayer.cubeLut.name }}（{{ activeLayer.cubeLut.size }}³）</p>
            </template>
            <button v-else class="btn is-block mt-6" type="button" @click="actions.setAdjust('contrast', 0)">启用调色</button>

            <input ref="cubeInput" type="file" accept=".cube,text/plain" hidden @change="onCubeFile" />

            <section v-if="activeLayer.kind === 'text'" class="mt-10">
              <h3 class="section-title">文字</h3>
              <textarea
                class="text-input text-area"
                rows="3"
                :value="activeLayer.text.content"
                @input="setTextContent($event.target.value)"
              />
              <div class="grid-2 mt-6">
                <label class="num-field"><span>字号</span><input class="text-input mono" type="number" :value="activeLayer.text.size" @change="actions.setActiveLayerProp({ text: { size: Number($event.target.value) } })" /></label>
                <label class="num-field"><span>颜色</span><input type="color" class="color-input" :value="activeLayer.text.color" @input="actions.setActiveLayerProp({ text: { color: $event.target.value } })" /></label>
                <label class="num-field"><span>描边</span><input class="text-input mono" type="number" :value="activeLayer.text.strokeWidth" @change="actions.setActiveLayerProp({ text: { strokeWidth: Number($event.target.value) } })" /></label>
                <label class="num-field"><span>对齐</span>
                  <select class="text-input" :value="activeLayer.text.align" @change="actions.setActiveLayerProp({ text: { align: $event.target.value } })">
                    <option value="left">左</option>
                    <option value="center">中</option>
                    <option value="right">右</option>
                  </select>
                </label>
              </div>
            </section>
          </template>
        </section>

        <!-- ------------------------------------------------------------ 选区 -->
        <section v-else-if="state.panelTab === 'select'" class="section">
          <p class="hint">在舞台上切到「魔棒」后点画布取色；选区属于当前图层。</p>
          <div class="grid-2 mt-6">
            <label class="num-field"><span>容差</span><input class="text-input mono" type="number" min="0" max="255" :value="state.selection.tolerance" @change="state.selection.tolerance = Math.max(0, Math.min(255, Number($event.target.value)))" /></label>
            <label class="num-field"><span>运算</span>
              <select class="text-input" :value="state.selection.op" @change="actions.selectionOp($event.target.value)">
                <option value="replace">替换</option>
                <option value="union">并集 (+)</option>
                <option value="subtract">减去 (-)</option>
                <option value="intersect">交集</option>
              </select>
            </label>
          </div>
          <label class="check-row mt-6">
            <input v-model="state.selection.contiguous" type="checkbox" />
            <span>只选连通区域（关掉 = 全图同色）</span>
          </label>

          <div class="stat-row mt-8">
            <span class="muted">选中比例</span>
            <span class="mono">{{ coverage.toFixed(1) }}%</span>
          </div>
          <div class="stat-row">
            <span class="muted">包围盒</span>
            <span class="mono">{{ selectionBox ? `${selectionBox.width}×${selectionBox.height}` : '—' }}</span>
          </div>

          <div class="row-3 mt-6">
            <button class="btn is-mini" type="button" :disabled="!state.selection.mask" @click="actions.selectionInvert()">反选</button>
            <button class="btn is-mini" type="button" :disabled="!state.selection.mask" @click="actions.selectionFeather(2)">羽化 2px</button>
            <button class="btn is-mini" type="button" :disabled="!state.selection.mask" @click="actions.selectionExpand(2)">扩展 2px</button>
            <button class="btn is-mini" type="button" :disabled="!state.selection.mask" @click="actions.selectionExpand(-2)">收缩 2px</button>
          </div>
          <div class="row-3 mt-6">
            <button class="btn is-mini" type="button" :disabled="!state.selection.mask" @click="actions.selectionToMask()">生成蒙版</button>
            <button class="btn is-mini" type="button" @click="actions.maskFromLayerAlpha()">按 Alpha 建选区</button>
            <button class="btn is-mini" type="button" :disabled="!state.selection.mask" @click="actions.selectionClear()">取消选区</button>
          </div>
          <button class="btn is-block is-ghost mt-6" type="button" :disabled="!activeLayer?.mask" @click="actions.clearLayerMask()">清除当前图层蒙版</button>
          <p class="hint">蒙版和选区都是灰度掩膜，可以在同一张图上反复加减；羽化用三次盒式模糊近似高斯。</p>
        </section>

        <!-- ------------------------------------------------------------ 动画 -->
        <section v-else-if="state.panelTab === 'anim'" class="section">
          <div class="grid-2">
            <label class="num-field"><span>帧率</span><input class="text-input mono" type="number" min="1" max="60" :value="doc.animation.fps" @change="actions.setAnimOption('fps', $event.target.value)" /></label>
            <label class="num-field"><span>时长 s</span><input class="text-input mono" type="number" step="0.1" min="0.1" :value="doc.animation.duration" @change="actions.setAnimOption('duration', $event.target.value)" /></label>
          </div>
          <div class="field-row mt-6">
            <label class="mlabel">循环</label>
            <select class="text-input" :value="doc.animation.loop" @change="actions.setAnimOption('loop', $event.target.value)">
              <option value="loop">循环</option>
              <option value="pingpong">往返</option>
              <option value="once">单次</option>
            </select>
          </div>
          <RangeField
            class="mt-6"
            label="播放头"
            :model-value="state.time"
            :min="0"
            :max="doc.animation.duration"
            :step="0.01"
            suffix="s"
            @update:model-value="actions.seek($event)"
          />
          <div class="row-2 mt-4">
            <button class="btn is-mini" type="button" @click="actions.togglePlay()">{{ state.playing ? '暂停' : '播放' }}</button>
            <button class="btn is-mini" type="button" @click="actions.seek(0)">回到 0</button>
          </div>

          <h3 class="section-title mt-10">关键帧（{{ activeLayer?.name || '未选图层' }}）</h3>
          <div class="prop-row" v-for="prop in trackProperties" :key="prop">
            <span class="prop-name mono">{{ prop }}</span>
            <button class="btn is-mini" type="button" :title="`在 ${state.time.toFixed(2)}s 打关键帧`" @click="actions.addKeyframe(prop)">
              ◆ {{ keyLabel(activeLayer?.transform?.[prop] ?? 0) }}
            </button>
          </div>

          <ul class="track-list">
            <li v-for="row in activeTracks" :key="row.prop" class="track-item">
              <div class="track-head">
                <span class="mono">{{ row.prop }}</span>
                <span class="muted mono">{{ row.value.toFixed(2) }}</span>
              </div>
              <div class="key-list">
                <span v-for="key in row.keys" :key="key.t" class="key-chip" :class="{ 'is-current': row.hasKey }">
                  <span class="mono">{{ key.t.toFixed(2) }}s</span>
                  <select class="mini-select" :value="typeof key.easing === 'string' ? key.easing : 'ease'" @change="actions.setKeyEasing(row.prop, key.t, $event.target.value)">
                    <option v-for="preset in easingPresets" :key="preset" :value="preset">{{ preset }}</option>
                    <option value="hold">hold</option>
                  </select>
                  <button class="mini" type="button" title="删除" @click="actions.deleteKeyframe(row.prop, key.t)">×</button>
                </span>
              </div>
            </li>
          </ul>
          <p v-if="!activeTracks.length" class="hint">还没有关键帧：上方点 ◆ 在当前时间打一个，再移动播放头改值就会生成动画。</p>
          <p class="hint">缓动取「段起点」的曲线（和 AE 的默认语义一致），关键帧时间轴导出时按帧率采样。</p>
        </section>

        <!-- ------------------------------------------------------------ 导出 -->
        <section v-else class="section">
          <div class="stat-row">
            <span class="muted">文档</span>
            <span class="mono">{{ doc.width }}×{{ doc.height }} · {{ doc.layers.length }} 层</span>
          </div>
          <RangeField
            label="导出倍率"
            :model-value="state.exportOptions.scale"
            :min="0.1"
            :max="4"
            :step="0.1"
            suffix="×"
            @update:model-value="state.exportOptions.scale = Number($event)"
          />
          <div class="field-row mt-6">
            <label class="mlabel">背景</label>
            <select class="text-input" v-model="state.exportOptions.background">
              <option value="transparent">透明</option>
              <option value="#000000">纯黑</option>
              <option value="#ffffff">纯白</option>
            </select>
          </div>

          <button class="btn is-primary is-block mt-8" type="button" :disabled="state.busy" @click="actions.exportPng({ toWorkspace: true, toLibrary: true })">
            {{ state.busy ? '正在渲染…' : '导出 PNG（并存入资源库）' }}
          </button>
          <button class="btn is-block mt-6" type="button" @click="actions.exportPng({ toWorkspace: false, download: true })">仅下载 PNG</button>
          <button class="btn is-block mt-6" type="button" @click="actions.exportOra({ download: true })">导出分层 .ora</button>
          <button class="btn is-block is-ghost mt-6" type="button" @click="actions.downloadDocJson()">导出文档 JSON</button>

          <h3 class="section-title mt-10">图集（精灵条 + 元数据）</h3>
          <div class="grid-2">
            <label class="num-field"><span>帧数</span><input class="text-input mono" type="number" min="1" max="240" :value="state.exportOptions.frameCount" @change="state.exportOptions.frameCount = Math.max(1, Number($event.target.value))" /></label>
            <label class="num-field"><span>列数</span><input class="text-input mono" type="number" min="0" :value="state.exportOptions.columns" @change="state.exportOptions.columns = Math.max(0, Number($event.target.value))" /></label>
            <label class="num-field"><span>间距</span><input class="text-input mono" type="number" min="0" :value="state.exportOptions.gap" @change="state.exportOptions.gap = Math.max(0, Number($event.target.value))" /></label>
            <label class="num-field"><span>外扩</span><input class="text-input mono" type="number" min="0" max="4" :value="state.exportOptions.extrude" @change="state.exportOptions.extrude = Math.max(0, Number($event.target.value))" /></label>
            <label class="num-field"><span>外边距</span><input class="text-input mono" type="number" min="0" :value="state.exportOptions.padding" @change="state.exportOptions.padding = Math.max(0, Number($event.target.value))" /></label>
            <label class="num-field"><span>九宫格</span><input class="text-input mono" type="number" min="0" :value="state.exportOptions.nineSlice" @change="state.exportOptions.nineSlice = Math.max(0, Number($event.target.value))" /></label>
          </div>
          <label class="check-row mt-6"><input v-model="state.exportOptions.pow2" type="checkbox" /><span>对齐到 2 的幂</span></label>
          <label class="check-row"><input v-model="state.exportOptions.trim" type="checkbox" /><span>逐帧裁掉透明边（trim）</span></label>
          <button class="btn is-primary is-block mt-6" type="button" :disabled="state.busy" @click="actions.exportAtlas({ toLibrary: true, download: true })">
            {{ state.busy ? '正在打包…' : '导出图集 ZIP（PNG + JSON + plist）' }}
          </button>
          <p class="hint">
            ZIP 内含 TexturePacker JSON（hash/array）、Phaser JSON、Cocos plist 与九宫格信息；
            外扩 1~2px 用于避免引擎采样时相邻帧渗色。
          </p>
        </section>

        <p v-if="state.error" class="hint is-warn">{{ state.error }}</p>
        <p v-else-if="state.status" class="hint">{{ state.status }}</p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.studio-panel {
  display: flex;
  flex-direction: column;
  width: 336px;
  flex: none;
  border-left: 1px solid var(--border);
}

.studio-tabs {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 3px;
  flex: none;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.studio-tab {
  height: 26px;
  padding: 0 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11px;
}

.studio-tab.is-active {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
}

.empty {
  padding: 14px 12px;
}

.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.row-3 .btn:nth-child(4) {
  grid-column: span 3;
}

.mt-4 {
  margin-top: 4px;
}

.mt-6 {
  margin-top: 6px;
}

.mt-8 {
  margin-top: 8px;
}

.mt-10 {
  margin-top: 12px;
}

.layer-list {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.layer-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  background: var(--panel-2);
}

.layer-item:last-child {
  border-bottom: none;
}

.layer-item.is-active {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

.eye {
  width: 16px;
  color: var(--text-2);
  font-size: 11px;
}

.layer-thumb {
  width: 34px;
  height: 26px;
  flex: none;
  object-fit: contain;
  border-radius: 3px;
  background: repeating-conic-gradient(var(--checker-a) 0% 25%, var(--checker-b) 0% 50%) 0 0 / 8px 8px;
}

.layer-thumb.is-adjust {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  color: var(--text-2);
  border: 1px solid var(--border);
}

.layer-meta {
  flex: 1;
  min-width: 0;
}

.layer-name {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
}

.layer-sub {
  display: block;
  color: var(--text-muted);
  font-size: 9px;
}

.layer-btns {
  display: flex;
  gap: 2px;
}

.mini {
  width: 18px;
  height: 18px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-2);
  font-size: 10px;
}

.mini:hover {
  color: var(--text);
}

.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mlabel {
  flex: none;
  color: var(--text-2);
  font-size: 11px;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.num-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
}

.num-field > span:first-child {
  flex: none;
  min-width: 42px;
}

.num-field .text-input {
  flex: 1;
  min-width: 0;
}

.readonly {
  padding: 0 4px;
  color: var(--text-muted);
}

.color-input {
  flex: 1;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-2);
}

.text-area {
  width: 100%;
  height: auto;
  padding: 6px 8px;
  resize: vertical;
  line-height: 1.5;
}

.text-row {
  display: flex;
  gap: 6px;
}

.text-row .text-input {
  flex: 1;
  min-width: 0;
}

.stat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 8px;
  font-size: 11px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 11px;
}

.check-row input {
  accent-color: var(--accent);
}

.prop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}

.prop-name {
  color: var(--text-2);
  font-size: 11px;
}

.track-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.track-item {
  padding: 5px 0;
  border-top: 1px solid var(--border);
}

.track-head {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
}

.key-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.key-chip {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 1px 3px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--panel-2);
  font-size: 9px;
}

.key-chip.is-current {
  border-color: var(--accent);
}

.mini-select {
  height: 16px;
  padding: 0 2px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-2);
  font-size: 9px;
}

.hint {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.6;
}

.hint.is-warn {
  color: var(--danger, #e5534b);
}
</style>
