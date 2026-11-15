/**
 * 临时用户（前端）
 * ----------------
 * - 每个浏览器标签页一个临时身份：id 存 sessionStorage（刷新不丢、关标签页即结束）；
 * - 打开新标签页就是新的临时用户：与旧标签页工作区/任务互不混淆；
 * - 所有人共享同一个资源库；不需要登录/注册；
 * - 模块加载时给全局 fetch 加 X-Client-Id / X-Client-Name 头，服务端据此隔离任务。
 */
import { computed, reactive } from 'vue';

const ID_KEY = 'image-clip:guest-id';
const NAME_KEY = 'image-clip:guest-name';

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readStorage(key) {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStorage(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 新标签页带 ?newGuest=1 时强制换一个新临时身份（用于同一浏览器开多个工作区）。 */
function forceNew() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('newGuest') !== '1') return false;
    url.searchParams.delete('newGuest');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return true;
  } catch {
    return false;
  }
}

function ensureIdentity() {
  if (forceNew()) {
    writeStorage(ID_KEY, randomId());
    writeStorage(NAME_KEY, '');
  }
  let id = readStorage(ID_KEY);
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    id = randomId();
    writeStorage(ID_KEY, id);
  }
  const fallback = `临时用户-${id.slice(-4).toUpperCase()}`;
  const name = readStorage(NAME_KEY) || fallback;
  return { id, name };
}

const identity = ensureIdentity();

const state = reactive({
  id: identity.id,
  name: identity.name,
  dialogOpen: false,
});

export function guestHeaders() {
  return { 'X-Client-Id': state.id, 'X-Client-Name': encodeURIComponent(state.name) };
}

/** 给全局 fetch 注入临时用户头（同源 /api 请求）。 */
let installed = false;
export function installGuestFetch() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    let url = '';
    let request = null;
    if (typeof input === 'string') url = input;
    else if (input instanceof Request) {
      request = input;
      url = input.url;
    }
    const isApi = url.startsWith('/api/') || /https?:\/\/[^/]+\/api\//.test(url);
    if (!isApi) return original(input, init);
    const headers = new Headers(request ? request.headers : init.headers);
    headers.set('X-Client-Id', state.id);
    headers.set('X-Client-Name', encodeURIComponent(state.name));
    const nextInit = { ...init, headers };
    if (request) return original(new Request(request, { headers }), nextInit);
    return original(input, nextInit);
  };
}

installGuestFetch();

export function renameGuest(name) {
  const next = String(name ?? '').trim().slice(0, 32);
  if (!next) return;
  state.name = next;
  writeStorage(NAME_KEY, next);
}

/** 当前标签页换一个新临时用户（清掉本标签页的会话后刷新）。 */
export function startNewGuest() {
  writeStorage(ID_KEY, randomId());
  writeStorage(NAME_KEY, '');
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('image-clip:session')) localStorage.removeItem(key);
    }
  } catch {
    /* 忽略 */
  }
  window.location.reload();
}

/** 在另一个标签页打开新临时用户（不影响当前标签页）。 */
export function openNewGuestTab() {
  const url = new URL(window.location.href);
  url.searchParams.set('newGuest', '1');
  window.open(url.toString(), '_blank', 'noopener');
}

const displayName = computed(() => state.name);

export function useGuest() {
  return {
    state,
    displayName,
    actions: {
      rename: renameGuest,
      startNew: startNewGuest,
      openNewTab: openNewGuestTab,
      openDialog: () => {
        state.dialogOpen = true;
      },
      closeDialog: () => {
        state.dialogOpen = false;
      },
    },
  };
}
