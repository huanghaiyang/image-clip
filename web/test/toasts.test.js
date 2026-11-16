/**
 * 右下角气泡通知单测
 * ------------------
 * push / update（同一 id 原地更新）/ dismiss / 上限 5 条 / 清空。
 * 这里统一传 timeout:0，避免测试挂 4 秒定时器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearToasts,
  dismissToast,
  pushToast,
  updateToast,
  useToasts,
} from '../src/composables/useToasts.js';

const { state } = useToasts();

test('push / update / dismiss', () => {
  clearToasts();
  const toast = pushToast({ id: 'job:1', kind: 'progress', title: '正在截帧', progress: 0.2, timeout: 0 });
  assert.equal(state.items.length, 1);
  assert.equal(toast.kind, 'progress');

  updateToast('job:1', { kind: 'success', title: '截帧完成', message: '5/5 帧', timeout: 0 });
  assert.equal(state.items.length, 1, '同一个 id 应该原地更新，不新增气泡');
  assert.equal(state.items[0].kind, 'success');
  assert.equal(state.items[0].title, '截帧完成');

  dismissToast('job:1');
  assert.equal(state.items.length, 0);
  assert.equal(dismissToast('missing'), false);
});

test('最多保留 5 条，超出丢弃最旧的', () => {
  clearToasts();
  for (let i = 0; i < 7; i += 1) pushToast({ id: `t${i}`, kind: 'info', title: `第 ${i} 条`, timeout: 0 });
  assert.equal(state.items.length, 5);
  assert.equal(state.items[0].id, 't6', '最新在最上面');
  assert.ok(!state.items.some((item) => item.id === 't1'));
});

test('clear 清空全部', () => {
  clearToasts();
  pushToast({ id: 'a', title: 'a', timeout: 0 });
  pushToast({ id: 'b', title: 'b', timeout: 0 });
  clearToasts();
  assert.equal(state.items.length, 0);
});


test('超时自动消失（回归：dismiss 未定义）', async () => {
  clearToasts();
  pushToast({ id: 'auto-dismiss', kind: 'success', title: '自动消失', timeout: 20 });
  assert.equal(state.items.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(state.items.length, 0);
});
