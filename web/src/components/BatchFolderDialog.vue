<script setup>
/**
 * 批量新建子文件夹
 * ----------------
 * 在指定父目录下一次性创建多个**固定名称**的文件夹：
 *  - 左侧输入：每行一个，也支持逗号 / 顿号 / 分号分隔；
 *  - 右侧实时预览：文件夹图标 + 名称 + 状态（新建 / 已存在 / 重复 / 不合法）；
 *  - 不覆盖、不自动编号；已存在或重复的名称会跳过并在结果里标明；
 *  - 创建完成后刷新资源库并关闭对话框（有失败项时保留结果，方便修正）。
 */
import { computed, ref, watch } from 'vue';

import { useLibrary } from '../composables/useLibrary.js';
import {
  loadFolderTemplates,
  removeFolderTemplate,
  saveFolderTemplates,
  upsertFolderTemplate,
} from '../lib/folderTemplates.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  parent: { type: String, default: '' },
});
const emit = defineEmits(['close', 'created']);

const { folders, state, actions } = useLibrary();
const text = ref('');
const submitting = ref(false);
const resultRows = ref(null);
const errorText = ref('');
const templates = ref(loadFolderTemplates(typeof localStorage === 'undefined' ? null : localStorage));
const savingTemplate = ref(false);
const templateName = ref('');
const templateNotice = ref('');

const parentLabel = computed(() => props.parent || '资源库根目录');

/** 父目录下已有的直接子文件夹（小写比较，Windows 风格不区分大小写）。 */
const existingNames = computed(() => {
  const set = new Set();
  for (const folder of folders.value) {
    const parent = folder.parent ?? '';
    if (parent === (props.parent ?? '')) set.add(String(folder.name).toLowerCase());
  }
  return set;
});

const NAME_MAX = 80;

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 输入框里的原始名称（未校验），模板保存也用这一份。 */
const rawNames = computed(() =>
  String(text.value ?? '')
    .split(/[\n\r,，、;；]+/)
    .map((name) => name.trim())
    .filter(Boolean),
);

function applyTemplate(template) {
  if (!template) return;
  text.value = template.names.join('\n');
  resultRows.value = null;
  errorText.value = '';
  templateNotice.value = `已应用模板：${template.name}`;
}

function saveCurrentTemplate() {
  const names = rawNames.value;
  if (!names.length) {
    errorText.value = '先输入至少一个文件夹名称，再保存为模板';
    return;
  }
  const name = templateName.value.trim();
  if (!name) {
    errorText.value = '请输入模板名称';
    return;
  }
  templates.value = upsertFolderTemplate(templates.value, { name, names });
  saveFolderTemplates(templates.value, storage());
  savingTemplate.value = false;
  templateName.value = '';
  templateNotice.value = `已保存模板：${name}`;
}

function deleteTemplate(template) {
  if (template?.builtin) return;
  templates.value = removeFolderTemplate(templates.value, template.id);
  saveFolderTemplates(templates.value, storage());
  if (templateNotice.value.includes(template.name)) templateNotice.value = '';
}

function validateName(name) {
  if (!name) return '名称为空';
  if (name === '.' || name === '..') return '名称不合法';
  if (name.length > NAME_MAX) return `名称最多 ${NAME_MAX} 个字符`;
  if (/[\\/:*?"<>|]/.test(name)) return '不能包含 \\ / : * ? " < > |';
  return '';
}

/**
 * 解析输入并生成预览行。
 * key 用小写做同批去重；status: ready | exists | duplicate | invalid
 */
const previewRows = computed(() => {
  const raw = rawNames.value;
  if (!raw.length) return [];
  const seen = new Set();
  const rows = [];
  for (const name of raw) {
    const key = name.toLowerCase();
    const base = { name };
    if (seen.has(key)) {
      rows.push({ ...base, key, status: 'duplicate', reason: '列表内重名' });
      continue;
    }
    seen.add(key);
    const invalid = validateName(name);
    if (invalid) {
      rows.push({ ...base, key, status: 'invalid', reason: invalid });
      continue;
    }
    if (existingNames.value.has(key)) {
      rows.push({ ...base, key, status: 'exists', reason: '同名文件夹已存在' });
      continue;
    }
    rows.push({ ...base, key, status: 'ready' });
  }
  return rows;
});

const counts = computed(() => {
  const rows = previewRows.value;
  return {
    total: rows.length,
    ready: rows.filter((row) => row.status === 'ready').length,
    exists: rows.filter((row) => row.status === 'exists').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    invalid: rows.filter((row) => row.status === 'invalid').length,
  };
});

const readyNames = computed(() => previewRows.value.filter((row) => row.status === 'ready').map((row) => row.name));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    text.value = '';
    resultRows.value = null;
    errorText.value = '';
    submitting.value = false;
    savingTemplate.value = false;
    templateName.value = '';
    templateNotice.value = '';
    templates.value = loadFolderTemplates(storage());
  },
);

const STATUS_META = {
  ready: { label: '新建', className: 'is-ready' },
  exists: { label: '已存在', className: 'is-exists' },
  duplicate: { label: '重复', className: 'is-duplicate' },
  invalid: { label: '不合法', className: 'is-invalid' },
  created: { label: '已创建', className: 'is-created' },
  skipped: { label: '已跳过', className: 'is-exists' },
  error: { label: '失败', className: 'is-invalid' },
};

function statusOf(row) {
  if (!row) return STATUS_META.ready;
  if (row.status === 'ready' && resultRows.value) {
    // 提交后：找到了结果就用结果状态
    const hit = resultRows.value.find((item) => String(item.name).toLowerCase() === row.key);
    if (hit) return hit.ok ? STATUS_META.created : STATUS_META[hit.status] ?? STATUS_META.error;
  }
  return STATUS_META[row.status] ?? STATUS_META.ready;
}

async function submit() {
  if (submitting.value || !readyNames.value.length) return;
  submitting.value = true;
  errorText.value = '';
  try {
    const result = await actions.createFolders(readyNames.value);
    if (!result) {
      errorText.value = state.error || '创建失败';
      return;
    }
    resultRows.value = result.results ?? [];
    emit('created', result);
    // 全部成功就直接关闭；有失败项时留在对话框里展示结果
    if (!(result.results ?? []).some((row) => !row.ok)) emit('close');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="bf-mask" @click.self="emit('close')">
      <div class="bf-dialog" role="dialog" aria-modal="true" aria-label="批量新建子文件夹" @keydown.esc="emit('close')">
        <header class="bf-head">
          <div>
            <h2>批量新建子文件夹</h2>
            <p class="bf-sub">
              父目录：<span class="bf-parent mono">{{ parentLabel }}</span>
            </p>
          </div>
          <button class="bf-close" type="button" title="关闭 (Esc)" @click="emit('close')">×</button>
        </header>

        <div class="bf-templates">
          <span class="bf-template-label">模板</span>
          <div class="bf-template-chips">
            <button
              v-for="template in templates"
              :key="template.id"
              class="bf-template"
              type="button"
              :title="`应用模板：${template.names.join(' / ')}`"
              @click="applyTemplate(template)"
            >
              <span class="bf-template-name">{{ template.name }}</span>
              <span class="bf-template-count mono">{{ template.names.length }}</span>
              <span v-if="template.builtin" class="bf-template-builtin">内置</span>
              <span v-else class="bf-template-remove" title="删除模板" @click.stop="deleteTemplate(template)">×</span>
            </button>
            <button class="bf-template-add" type="button" @click="savingTemplate = !savingTemplate">+ 保存当前为模板</button>
          </div>
          <div v-if="savingTemplate" class="bf-template-save">
            <input
              v-model="templateName"
              class="text-input"
              maxlength="40"
              placeholder="模板名称，例如：我的项目目录"
              @keydown.enter.prevent="saveCurrentTemplate"
              @keydown.esc="savingTemplate = false"
            />
            <button class="btn is-mini" type="button" @click="saveCurrentTemplate">保存</button>
            <button class="btn is-mini is-ghost" type="button" @click="savingTemplate = false">取消</button>
          </div>
          <span v-if="templateNotice" class="bf-template-notice">{{ templateNotice }}</span>
        </div>

        <div class="bf-body">
          <section class="bf-input">
            <label class="bf-label" for="bf-names">固定名称列表</label>
            <textarea
              id="bf-names"
              v-model="text"
              class="bf-textarea"
              rows="12"
              placeholder="每行一个名称，例如：&#10;图标&#10;背景&#10;角色&#10;场景&#10;（也支持逗号 / 顿号 / 分号分隔）"
            />
            <p class="bf-hint">
              不会自动编号、不会覆盖已有文件夹；同名或重复项会跳过。最多 200 个。
            </p>
          </section>

          <section class="bf-preview">
            <div class="bf-preview-head">
              <span class="bf-label">预览（{{ counts.total }} 个）</span>
              <span class="bf-counts mono">
                <span class="is-ready">{{ counts.ready }} 新建</span>
                <span v-if="counts.exists" class="is-exists">{{ counts.exists }} 已存在</span>
                <span v-if="counts.duplicate" class="is-duplicate">{{ counts.duplicate }} 重复</span>
                <span v-if="counts.invalid" class="is-invalid">{{ counts.invalid }} 不合法</span>
              </span>
            </div>
            <div v-if="!previewRows.length" class="bf-empty muted">
              在左侧输入名称后，这里会显示将要创建的文件夹和状态。
            </div>
            <div v-else class="bf-grid">
              <div v-for="(row, index) in previewRows" :key="`${row.key}-${index}`" class="bf-item">
                <span class="bf-index mono">{{ String(index + 1).padStart(2, '0') }}</span>
                <svg class="bf-folder" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M1.8 4.1c0-.6.5-1.1 1.1-1.1h3l1.3 1.4h5.9c.6 0 1.1.5 1.1 1.1v5.4c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.1Z"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="bf-name" :title="row.name">{{ row.name }}</span>
                <span class="bf-status" :class="statusOf(row).className">{{ statusOf(row).label }}</span>
              </div>
            </div>
          </section>
        </div>

        <footer class="bf-foot">
          <span v-if="errorText" class="bf-error">{{ errorText }}</span>
          <span v-else class="bf-summary muted">
            将创建 <b>{{ counts.ready }}</b> 个文件夹
            <span v-if="counts.exists || counts.duplicate || counts.invalid"> · 跳过 {{ counts.exists + counts.duplicate + counts.invalid }} 个</span>
          </span>
          <div class="bf-actions">
            <button class="btn" type="button" @click="emit('close')">取消</button>
            <button
              class="btn is-primary"
              type="button"
              :disabled="submitting || !counts.ready"
              @click="submit"
            >
              {{ submitting ? '正在创建…' : `创建 ${counts.ready} 个文件夹` }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.bf-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
}

.bf-dialog {
  display: flex;
  flex-direction: column;
  width: min(760px, 94vw);
  max-height: min(720px, 88vh);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--panel);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}

.bf-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border);
}

.bf-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.bf-sub {
  margin: 5px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.bf-parent {
  color: var(--text-2);
}

.bf-close {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
}

.bf-close:hover {
  background: var(--hover);
  color: var(--text);
}

.bf-templates {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}

.bf-template-label {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}

.bf-template-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.bf-template {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--panel);
  color: var(--text-2);
  font-size: 10px;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.bf-template:hover {
  border-color: var(--accent);
  color: var(--text);
}

.bf-template-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bf-template-count {
  color: var(--text-muted);
  font-size: 9px;
}

.bf-template-builtin {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--panel-3);
  font-size: 8px;
  color: var(--text-muted);
}

.bf-template-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  color: var(--text-muted);
  font-size: 11px;
}

.bf-template-remove:hover {
  background: var(--danger);
  color: #fff;
}

.bf-template-add {
  height: 24px;
  padding: 0 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  color: var(--text-muted);
  font-size: 10px;
}

.bf-template-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.bf-template-save {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
}

.bf-template-save .text-input {
  flex: 1;
  max-width: 260px;
  height: 24px;
}

.bf-template-notice {
  font-size: 10px;
  color: var(--ok);
}

.bf-body {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
  padding: 16px 18px;
  min-height: 0;
  overflow: hidden;
}

.bf-input {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.bf-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}

.bf-textarea {
  flex: 1;
  min-height: 220px;
  margin-top: 6px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.7;
  resize: none;
}

.bf-hint {
  margin: 6px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-muted);
}

.bf-preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.bf-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.bf-counts {
  display: flex;
  gap: 8px;
  font-size: 10px;
}

.bf-counts .is-ready {
  color: var(--ok);
}

.bf-counts .is-exists {
  color: var(--warn);
}

.bf-counts .is-duplicate {
  color: var(--text-muted);
}

.bf-counts .is-invalid {
  color: var(--danger);
}

.bf-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 18px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  font-size: 11px;
  text-align: center;
}

.bf-grid {
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  min-height: 0;
}

.bf-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel);
  font-size: 11px;
}

.bf-index {
  flex: none;
  width: 18px;
  font-size: 9px;
  color: var(--text-muted);
}

.bf-folder {
  flex: none;
  color: var(--accent);
}

.bf-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bf-status {
  flex: none;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 9px;
  line-height: 1.6;
  background: var(--panel-3);
  color: var(--text-muted);
}

.bf-status.is-ready {
  background: color-mix(in srgb, var(--ok) 18%, transparent);
  color: var(--ok);
}

.bf-status.is-exists {
  background: color-mix(in srgb, var(--warn) 18%, transparent);
  color: var(--warn);
}

.bf-status.is-duplicate {
  background: var(--panel-3);
  color: var(--text-muted);
}

.bf-status.is-invalid {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  color: var(--danger);
}

.bf-status.is-created {
  background: color-mix(in srgb, var(--ok) 22%, transparent);
  color: var(--ok);
}

.bf-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}

.bf-summary {
  font-size: 11px;
}

.bf-error {
  font-size: 11px;
  color: var(--danger);
}

.bf-actions {
  display: flex;
  gap: 8px;
}

@media (max-width: 720px) {
  .bf-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  .bf-textarea {
    min-height: 150px;
  }

  .bf-grid {
    max-height: 220px;
  }
}
</style>
