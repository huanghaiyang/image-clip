<script setup>
/**
 * 精灵图右侧面板
 * --------------
 * 选中左侧素材后自动载入；切分方式、帧率、播放控制都写入 useSprite，
 * 舞台即时反映同一份状态。
 */
import { computed, watch } from 'vue';

import { useWorkspace } from '../composables/useWorkspace.js';
import { useSprite } from '../composables/useSprite.js';
import { openImportPicker } from '../composables/useUploadPicker.js';
import RangeField from './ui/RangeField.vue';
import SegmentedControl from './ui/SegmentedControl.vue';
import SwitchField from './ui/SwitchField.vue';
import SpriteMergeBlock from './SpriteMergeBlock.vue';
import { useSpriteMerge } from '../composables/useSpriteMerge.js';

const { selected } = useWorkspace();
const { state, frames, currentFrame, actions } = useSprite();
const { mergeSource } = useSpriteMerge();
const mergeCount = computed(() => mergeSource.value?.count ?? 0);

const item = computed(() => selected.value ?? null);
const total = computed(() => frames.value.length);
/** 精灵图工作区的两个方向：拆分已有 sprite / 多图合并成 sprite */
const pane = computed(() => state.pane ?? 'split');
const paneOptions = [
  { value: 'split', label: '拆分', hint: '把一张 sprite 图切成帧，预览并播放' },
  { value: 'merge', label: '合并', hint: '把勾选的多张图片拼成一张 sprite 图（尺寸可不同）' },
];

const modeOptions = [
  { value: 'auto', label: '自动分隔', hint: '按透明分隔线切帧，适合带帧间距的 sprite 图' },
  { value: 'grid', label: '网格', hint: '按列数 × 行数等分，适合帧紧贴的 sprite 图' },
];

watch(
  item,
  (value) => {
    if (value) actions.loadItem(value);
  },
  { immediate: true },
);

function importSprite() {
  openImportPicker('image');
}
</script>

<template>
  <aside class="panel sprite-panel">
    <div class="panel-title">
      <span>精灵图</span>
      <span class="chip">{{ pane === 'merge' ? `${mergeCount} 张待合并` : `${total} 帧` }}</span>
    </div>

    <div class="panel-body">
      <section class="section">
        <SegmentedControl
          :model-value="pane"
          :options="paneOptions"
          block
          @update:model-value="actions.setPane($event)"
        />
      </section>

      <!-- 合并：把「当前素材」里勾选的多张图拼成一张 sprite -->
      <template v-if="pane === 'merge'">
        <SpriteMergeBlock />
      </template>

      <!-- 拆分：把当前 sprite 图切成帧 -->
      <p v-else-if="!item" class="empty muted">请先在左侧选择一张 sprite 图。</p>

      <template v-else>
        <section class="section">
          <h3 class="section-title">源图</h3>
          <dl class="kv">
            <div class="kv-row">
              <dt>文件</dt>
              <dd class="mono ellipsis" :title="item.name">{{ item.name }}</dd>
            </div>
            <div class="kv-row">
              <dt>尺寸</dt>
              <dd class="mono">{{ state.width }} × {{ state.height }}</dd>
            </div>
          </dl>
          <button class="btn is-block is-ghost mt-6" type="button" @click="importSprite">导入 sprite 图</button>
          <p class="hint">导入后会保存到资源库并加入左侧素材列表；也可以直接把图片拖进窗口。</p>
        </section>

        <section class="section">
          <h3 class="section-title">切分</h3>
          <SegmentedControl
            :model-value="state.mode"
            :options="modeOptions"
            size="sm"
            block
            @update:model-value="actions.setMode($event)"
          />

          <template v-if="state.mode === 'auto'">
            <p v-if="state.detected" class="hint">
              按透明分隔线切出 {{ state.autoColumns }} 列 × {{ state.autoRows }} 行，共 {{ state.autoColumns * state.autoRows }} 帧。
            </p>
            <p v-else class="hint is-warn">
              没有检测到透明分隔线。帧与帧紧贴时请切到「网格」，手动填写列数 / 行数。
            </p>
            <button class="btn is-block is-ghost mt-6" type="button" @click="actions.redetect()">重新检测</button>
          </template>

          <template v-else>
            <div class="mt-10">
              <RangeField
                label="列数"
                :model-value="state.columns"
                :min="1"
                :max="128"
                suffix="列"
                hint="横向切几列；按整图宽度等分。"
                @update:model-value="actions.setColumns($event)"
              />
              <RangeField
                label="行数"
                :model-value="state.rows"
                :min="1"
                :max="128"
                suffix="行"
                hint="纵向切几行；按整图高度等分。"
                @update:model-value="actions.setRows($event)"
              />
            </div>
          </template>
        </section>

        <section class="section">
          <h3 class="section-title">帧</h3>
          <dl class="kv">
            <div class="kv-row">
              <dt>帧数</dt>
              <dd class="mono">{{ total }}</dd>
            </div>
            <div v-if="currentFrame" class="kv-row">
              <dt>当前</dt>
              <dd class="mono">
                第 {{ state.selected + 1 }} 帧 · {{ currentFrame.width }} × {{ currentFrame.height }}
              </dd>
            </div>
            <div v-if="currentFrame" class="kv-row">
              <dt>位置</dt>
              <dd class="mono">{{ currentFrame.x }}, {{ currentFrame.y }}</dd>
            </div>
          </dl>
          <div class="btn-row mt-8">
            <button class="btn is-block" type="button" :disabled="state.selected <= 0" @click="actions.step(-1)">上一帧</button>
            <button
              class="btn is-block"
              type="button"
              :disabled="state.selected >= total - 1"
              @click="actions.step(1)"
            >
              下一帧
            </button>
          </div>
        </section>

        <section class="section">
          <h3 class="section-title">播放</h3>
          <RangeField
            label="帧率"
            :model-value="state.fps"
            :min="1"
            :max="60"
            suffix="FPS"
            hint="每秒播放多少帧；改完立即生效。"
            @update:model-value="actions.setFps($event)"
          />
          <SwitchField
            label="循环播放"
            :model-value="state.loop"
            hint="关闭后播放到最后一帧自动停下。"
            @update:model-value="actions.setLoop($event)"
          />
          <button
            class="btn is-primary is-block mt-8"
            type="button"
            :disabled="total < 2"
            @click="actions.togglePlay()"
          >
            {{ state.playing ? '暂停' : '播放' }}
          </button>
          <p class="hint">空格播放 / 暂停，←/→ 逐帧，也可以直接点击画布上的格子选帧。</p>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.ellipsis {
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.hint.is-warn {
  color: var(--warn, #e5a54b);
}
</style>
