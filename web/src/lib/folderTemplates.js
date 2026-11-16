/**
 * 批量建子文件夹：模板
 * --------------------
 * 内置几套常用目录模板；用户也可以把当前名称列表保存为自定义模板，
 * 下次打开对话框一键填充，避免重复输入。
 *
 * 纯函数放这里，方便单测；localStorage 只由调用方传入（node 测试用假 storage）。
 */
export const FOLDER_TEMPLATE_KEY = 'image-clip:folder-templates:v1';

export const BUILTIN_FOLDER_TEMPLATES = Object.freeze([
  {
    id: 'builtin-animation',
    name: '动画项目',
    builtin: true,
    names: ['帧序列', '背景', '角色', '场景', '音效', '导出'],
  },
  {
    id: 'builtin-video',
    name: '视频拆帧',
    builtin: true,
    names: ['关键帧', '音频', '封面', '导出'],
  },
  {
    id: 'builtin-assets',
    name: '素材整理',
    builtin: true,
    names: ['原图', '裁剪', '去背', '导出'],
  },
]);

/** 去首尾空白、去空、按小写去重；保留用户输入顺序与原始大小写。 */
export function normalizeFolderNames(names) {
  const seen = new Set();
  const list = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(name);
  }
  return list;
}

function sanitizeTemplate(template) {
  if (!template || typeof template !== 'object') return null;
  const name = String(template.name ?? '').trim().slice(0, 40);
  const names = normalizeFolderNames(template.names);
  if (!name || !names.length) return null;
  return {
    id: String(template.id || `tpl-${name}`),
    name,
    builtin: Boolean(template.builtin),
    names,
  };
}

/** 内置模板 + 已保存的自定义模板；损坏数据直接忽略。 */
export function loadFolderTemplates(storage) {
  const custom = [];
  try {
    const raw = storage?.getItem?.(FOLDER_TEMPLATE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, 50)) {
        const clean = sanitizeTemplate(item);
        if (clean) custom.push({ ...clean, builtin: false });
      }
    }
  } catch {
    // 隐私模式 / 损坏数据：只用内置模板
  }
  return [...BUILTIN_FOLDER_TEMPLATES.map((item) => ({ ...item, names: [...item.names] })), ...custom];
}

/** 只持久化自定义模板（内置的始终从代码生成）。 */
export function saveFolderTemplates(templates, storage) {
  try {
    const custom = (templates ?? [])
      .filter((item) => item && !item.builtin)
      .slice(0, 50)
      .map((item) => ({ id: item.id, name: item.name, names: normalizeFolderNames(item.names) }))
      .filter((item) => item.name && item.names.length);
    storage?.setItem?.(FOLDER_TEMPLATE_KEY, JSON.stringify(custom));
    return true;
  } catch {
    return false;
  }
}

/** 新增或按名称覆盖自定义模板；返回新数组。 */
export function upsertFolderTemplate(templates, { name, names }) {
  const clean = sanitizeTemplate({ name, names });
  if (!clean) return templates;
  const list = [...(templates ?? [])];
  const index = list.findIndex((item) => !item.builtin && item.name.toLowerCase() === clean.name.toLowerCase());
  const entry = { ...clean, builtin: false };
  if (index >= 0) list[index] = { ...list[index], ...entry };
  else list.push(entry);
  return list;
}

export function removeFolderTemplate(templates, id) {
  return (templates ?? []).filter((item) => item.builtin || item.id !== id);
}
