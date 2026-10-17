/**
 * 大模型接入的**提供方注册表**与设置持久化。
 *
 * 设计要点
 * --------
 * 1. 协议统一用 **OpenAI 兼容**（`/v1/chat/completions`、`/v1/models`）。
 *    这样"本地 DeepSeek-VL2 / 本地 Ollama / 云端任意兼容服务"在代码里是同一种东西，
 *    切换只是换 baseUrl + model —— 这就是"大模型切换"的实现方式。
 * 2. 默认提供方是**本地**（127.0.0.1），因为本项目的约束是"离线、图片不外发"：
 *    - `local-deepseek`：本项目自带的 DeepSeek-VL2-tiny 侧车（npm run llm:serve）
 *    - `ollama`：本机 Ollama 的 OpenAI 兼容端点
 *    - `remote-openai`：任何云端兼容端点（**图片会离开本机**，仅在显式启用时使用）
 * 3. 设置落在 `data/llm.json`（gitignore），API key 只写不读回（读取时打码）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'llm.json');

/** 内置提供方（首次运行写入设置文件，之后以设置文件为准）。 */
const DEFAULT_PROVIDERS = [
  {
    id: 'local-deepseek',
    label: '本地 DeepSeek-VL2（自带侧车）',
    baseUrl: 'http://127.0.0.1:11500/v1',
    model: 'deepseek-vl2-tiny',
    kind: 'local',
    vision: true,
    apiKey: '',
    note: '随项目下载的 DeepSeek-VL2-tiny（6.4GB），CPU 推理较慢；图片不出本机',
  },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5vl:7b',
    kind: 'local',
    vision: true,
    apiKey: '',
    note: '需本机安装 Ollama 并 pull 一个视觉模型；图片不出本机',
  },
  {
    id: 'remote-openai',
    label: 'OpenAI 兼容（云端）',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    kind: 'remote',
    vision: true,
    apiKey: '',
    note: '⚠️ 云端：图片会离开本机，仅在明确同意时使用',
  },
];

let cache = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadSettings() {
  if (cache) return cache;
  ensureDir();
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    stored = null;
  }
  const byId = new Map(DEFAULT_PROVIDERS.map((p) => [p.id, { ...p }]));
  for (const p of stored?.providers ?? []) {
    if (!p?.id) continue;
    byId.set(p.id, { ...(byId.get(p.id) ?? {}), ...p });
  }
  // 环境变量覆盖默认的本地端点（方便部署时指向别的服务）
  if (process.env.LLM_BASE_URL) {
    const target = byId.get(process.env.LLM_PROVIDER_ID || 'local-deepseek');
    if (target) {
      target.baseUrl = process.env.LLM_BASE_URL;
      if (process.env.LLM_MODEL) target.model = process.env.LLM_MODEL;
      if (process.env.LLM_API_KEY) target.apiKey = process.env.LLM_API_KEY;
    }
  }
  const providers = [...byId.values()];
  const activeId = providers.some((p) => p.id === stored?.activeId) ? stored.activeId : providers[0].id;
  cache = { activeId, providers };
  return cache;
}

export function saveSettings(settings) {
  ensureDir();
  cache = settings;
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

function maskKey(apiKey) {
  if (!apiKey) return '';
  return apiKey.length <= 8 ? '••••' : `${apiKey.slice(0, 3)}••••${apiKey.slice(-2)}`;
}

/** 对外（HTTP）用的提供方视图：apiKey 打码，绝不回传明文。 */
export function listProviders() {
  const s = loadSettings();
  return {
    activeId: s.activeId,
    providers: s.providers.map((p) => ({ ...p, apiKey: maskKey(p.apiKey), apiKeySet: Boolean(p.apiKey) })),
  };
}

export function getProvider(id) {
  const s = loadSettings();
  return s.providers.find((p) => p.id === (id ?? s.activeId)) ?? null;
}

export function getActiveProvider() {
  return getProvider(loadSettings().activeId);
}

export function setActiveProvider(id) {
  const s = loadSettings();
  if (!s.providers.some((p) => p.id === id)) throw new Error(`未知的提供方：${id}`);
  saveSettings({ ...s, activeId: id });
  return listProviders();
}

/** 更新提供方配置（baseUrl / model / apiKey / label / vision）。 */
export function updateProvider(id, patch = {}) {
  const s = loadSettings();
  const idx = s.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error(`未知的提供方：${id}`);
  const allowed = ['label', 'baseUrl', 'model', 'apiKey', 'vision', 'kind', 'note'];
  const next = { ...s.providers[idx] };
  for (const key of allowed) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  // apiKey 传空字符串表示"保持不变"（界面上不回显明文）
  if (patch.apiKey === '') delete next.apiKey;
  if (patch.apiKey === '') next.apiKey = s.providers[idx].apiKey;
  const providers = [...s.providers];
  providers[idx] = next;
  saveSettings({ ...s, providers });
  return listProviders();
}

/** 探测提供方是否可达（GET /models），返回 { reachable, models, error }。 */
export async function probeProvider(id, { timeoutMs = 4000 } = {}) {
  const p = getProvider(id);
  if (!p) return { id, reachable: false, models: [], error: '提供方不存在' };
  const url = `${p.baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, {
      headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { id: p.id, reachable: false, models: [], error: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    const models = (json?.data ?? json?.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
    return { id: p.id, reachable: true, models, error: null };
  } catch (err) {
    return { id: p.id, reachable: false, models: [], error: err.message };
  }
}

export function settingsPath() {
  return SETTINGS_FILE;
}
