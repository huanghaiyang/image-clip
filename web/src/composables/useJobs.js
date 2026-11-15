/**
 * 后台任务轮询 + 通知
 * -------------------
 * 服务端的长任务（目前主要是视频截帧）通过 GET /api/jobs 暴露状态。
 * 这里统一轮询：
 *  - 有任务在跑时 1s 一次，空闲时 6s 一次（顺带发现别处触发的任务）；
 *  - 每个任务只通知一次「开始」「完成 / 失败」，用 toast 的固定 id 原地更新进度；
 *  - 状态变化同时用 window 事件 `dsh:job` 广播，工作区据此刷新自己的结果。
 *
 * 多任务并存时 toast 栈会自动纵向堆叠（见 Toasts.vue）。
 */
import { computed, reactive } from 'vue';

import { fetchJobs } from '../lib/jobs.js';
import { dismissToast, expireToasts, pushToast, updateToast, useToasts } from './useToasts.js';

const LOCAL_TASKS_KEY = 'image-clip:tasks-history:v1';
const MAX_LOCAL_TASKS = 30;

const state = reactive({
  jobs: [],
  localTasks: loadLocalTasks(),
  loading: false,
  error: '',
  started: false,
  centerOpen: false,
  hiddenFinished: [], // 任务面板里手动隐藏的历史任务 id
});

/** 本地任务（上传、批量抠图…不是服务端 job）：和历史一起展示在任务面板里。 */
function loadLocalTasks() {
  try {
    const raw = localStorage.getItem(LOCAL_TASKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // 上次没跑完的本地任务：标成中断，避免任务中心一直显示"进行中"
    return parsed.slice(0, MAX_LOCAL_TASKS).map((task) =>
      task?.status === 'running'
        ? { ...task, status: 'failed', progress: 1, detail: '应用重启，任务已中断', finishedAt: task.finishedAt || Date.now() }
        : task,
    );
  } catch {
    return [];
  }
}

function saveLocalTasks() {
  try {
    localStorage.setItem(LOCAL_TASKS_KEY, JSON.stringify(state.localTasks.slice(0, MAX_LOCAL_TASKS)));
  } catch {
    /* 隐私模式等写不进去就只在内存里保留 */
  }
}

/**
 * 登记一个本地长任务（开始）。
 * 会自动挂一条进度气泡；没显式结束也会被 45s 超时兜底清掉。
 */
export function startLocalTask({ id, title, detail = '' } = {}) {
  if (!id) return null;
  const task = {
    id,
    type: 'local',
    label: title || '本地任务',
    detail,
    progress: 0,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
  };
  state.localTasks = [task, ...state.localTasks.filter((item) => item.id !== id)].slice(0, MAX_LOCAL_TASKS);
  saveLocalTasks();
  pushToast({ id: `local:${id}`, kind: 'progress', title: task.label, message: detail, progress: 0, timeout: 45000 });
  return task;
}

export function updateLocalTask(id, patch = {}) {
  const task = state.localTasks.find((item) => item.id === id);
  if (!task) return null;
  if (patch.progress != null) task.progress = Math.max(0, Math.min(1, Number(patch.progress) || 0));
  if (patch.detail != null) task.detail = String(patch.detail);
  updateToast(`local:${id}`, { message: task.detail, progress: task.progress });
  return task;
}

export function finishLocalTask(id, { status = 'done', detail = '' } = {}) {
  const task = state.localTasks.find((item) => item.id === id);
  if (!task) return null;
  task.status = status;
  task.progress = 1;
  if (detail) task.detail = detail;
  task.finishedAt = Date.now();
  saveLocalTasks();
  updateToast(`local:${id}`, {
    kind: status === 'done' ? 'success' : 'error',
    title: `${task.label} · ${status === 'done' ? '完成' : '失败'}`,
    message: task.detail,
    progress: 1,
  });
  return task;
}

export function toggleTaskCenter(force) {
  state.centerOpen = typeof force === 'boolean' ? force : !state.centerOpen;
  if (state.centerOpen) void pollJobs();
}

export function hideFinishedTasks(ids = []) {
  const list = ids.length ? ids : [...state.jobs.filter((job) => job.status !== 'running').map((job) => job.id), ...state.localTasks.filter((task) => task.status !== 'running').map((task) => task.id)];
  state.hiddenFinished = [...new Set([...state.hiddenFinished, ...list])];
}

export function clearLocalTaskHistory() {
  state.localTasks = state.localTasks.filter((task) => task.status === 'running');
  saveLocalTasks();
}

/**
 * 清理「任务已经结束、但气泡还停留在进度状态」的过期通知。
 * 以服务端任务状态为准，避免事件丢失时气泡一直转圈。
 */
function reconcileToasts() {
  const { state: toastState } = useToasts();
  const byId = new Map(state.jobs.map((job) => [`job:${job.id}`, job]));
  for (const toast of [...toastState.items]) {
    if (toast.kind !== 'progress' || !toast.id.startsWith('job:')) continue;
    const job = byId.get(toast.id);
    if (!job) {
      dismissToast(toast.id);
      continue;
    }
    if (job.status === 'done') {
      pushToast({ id: toast.id, kind: 'success', title: `${job.label || '任务'} · 完成`, message: summarize(job), timeout: 5000 });
    } else if (job.status === 'failed') {
      pushToast({ id: toast.id, kind: 'error', title: `${job.label || '任务'} · 失败`, message: job.error || '任务执行失败', timeout: 9000 });
    }
  }
}

let timer = 0;
let inFlight = false;
/** 首轮只建立基线：已经完成的历史任务不再弹通知，避免刚打开应用就刷出一屏旧气泡 */
let baseline = true;
/** jobId → 上一次见到的 status（用于只在状态变化时通知一次） */
const seen = new Map();

function summarize(job) {
  const result = job?.result;
  if (!result) return '';
  if (job.type === 'video.frames') {
    const folder = result.folder ? ` → 资源库/${result.folder}` : '';
    return `截取 ${result.extracted ?? 0}/${result.requested ?? 0} 帧${folder}${result.failed ? ` · ${result.failed} 帧失败` : ''}`;
  }
  return '';
}

function toastId(job) {
  return `job:${job.id}`;
}

function notifyTransition(job) {
  const id = toastId(job);
  if (job.status === 'running') {
    const detail = job.detail || '正在后台执行…';
    pushToast({
      id,
      kind: 'progress',
      title: job.label || '后台任务',
      message: detail,
      progress: job.progress ?? 0,
      timeout: 0,
    });
    return;
  }
  if (job.status === 'done') {
    pushToast({
      id,
      kind: 'success',
      title: `${job.label || '任务'} · 完成`,
      message: summarize(job),
      timeout: 5000,
    });
    return;
  }
  if (job.status === 'failed') {
    pushToast({
      id,
      kind: 'error',
      title: `${job.label || '任务'} · 失败`,
      message: job.error || '任务执行失败',
      timeout: 9000,
    });
  }
}

function applyJobs(jobs) {
  state.jobs = Array.isArray(jobs) ? jobs : [];
  for (const job of state.jobs) {
    if (baseline && job.status !== 'running') {
      // 首轮：历史任务只记录状态，不补发通知
      seen.set(job.id, job.status);
      continue;
    }
    const previous = seen.get(job.id);
    if (previous === job.status) {
      // 进度型通知原地更新
      if (job.status === 'running') {
        updateToast(toastId(job), { message: job.detail || '正在后台执行…', progress: job.progress ?? 0 });
      }
      continue;
    }
    seen.set(job.id, job.status);
    notifyTransition(job);
    window.dispatchEvent(new CustomEvent('dsh:job', { detail: job }));
  }
  reconcileToasts();
  expireToasts();
}

function schedule(delay) {
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(pollJobs, delay);
}

export async function pollJobs() {
  if (inFlight) return state.jobs;
  inFlight = true;
  try {
    const payload = await fetchJobs();
    state.error = '';
    applyJobs(payload?.jobs ?? []);
  } catch (err) {
    state.error = err.message || '读取任务失败';
  } finally {
    inFlight = false;
    const active = state.jobs.some((job) => job.status === 'running');
    baseline = false;
    schedule(active ? 1000 : 6000);
  }
  return state.jobs;
}

/** 启动轮询（App 挂载时调用一次；重复调用无副作用）。 */
export function startJobPolling() {
  if (state.started) return;
  state.started = true;
  void pollJobs();
}

export function stopJobPolling() {
  if (timer) clearTimeout(timer);
  timer = 0;
  state.started = false;
}

/** 正在跑的任务（UI 可用来显示进度）。 */
const activeJobs = computed(() => state.jobs.filter((job) => job.status === 'running'));

export function findFramesJob(path) {
  return state.jobs.find((job) => job.type === 'video.frames' && (!path || job.meta?.path === path)) ?? null;
}

export function useJobs() {
  return {
    state,
    activeJobs,
    actions: {
      poll: pollJobs,
      start: startJobPolling,
      stop: stopJobPolling,
      findFramesJob,
      startLocal: startLocalTask,
      updateLocal: updateLocalTask,
      finishLocal: finishLocalTask,
      clearLocalHistory: clearLocalTaskHistory,
      toggleCenter: toggleTaskCenter,
      hideFinished: hideFinishedTasks,
    },
  };
}
