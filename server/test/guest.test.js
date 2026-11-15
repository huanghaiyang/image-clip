/**
 * 临时用户：不登录，按 X-Client-Id 隔离任务与工作区；共享资源库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/index.js';
import { guestFromRequest } from '../src/guest.js';

function fakeReq(headers = {}) {
  return { headers };
}

test('临时用户标识：默认、有效、非法回退、名字清洗', () => {
  assert.equal(guestFromRequest(fakeReq()).id, 'guest-local');
  assert.equal(guestFromRequest(fakeReq({ 'x-client-id': 'abc12345' })).id, 'abc12345');
  assert.equal(guestFromRequest(fakeReq({ 'x-client-id': 'bad id!' })).id, 'guest-local');
  assert.equal(guestFromRequest(fakeReq({ 'x-client-name': '  设计-小王  ' })).name, '设计-小王');
  assert.equal(guestFromRequest(fakeReq({ 'x-client-name': 'x'.repeat(80) })).name.length, 32);
  const fallback = guestFromRequest(fakeReq({ 'x-client-id': 'abcdef12' }));
  assert.match(fallback.name, /^临时用户-[0-9A-F]{4}$/);
});

test('任务按临时用户隔离：A 看不到 B 的任务，也不能读 B 的日志', async () => {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const A = { 'X-Client-Id': 'client-aaaaaa', 'X-Client-Name': 'A' };
  const B = { 'X-Client-Id': 'client-bbbbbb', 'X-Client-Name': 'B' };
  try {
    const { jobs } = app.locals.services;
    const job = jobs.create({ type: 'test', label: 'A 的任务', userId: 'client-aaaaaa' });
    jobs.finish(job.id, { ok: true });

    const listA = await (await fetch(`${base}/api/jobs`, { headers: A })).json();
    const listB = await (await fetch(`${base}/api/jobs`, { headers: B })).json();
    assert.ok(listA.jobs.some((item) => item.id === job.id), 'A 能看到自己的任务');
    assert.ok(!listB.jobs.some((item) => item.id === job.id), 'B 看不到 A 的任务');

    const logA = await fetch(`${base}/api/jobs/${job.id}/log`, { headers: A });
    const logB = await fetch(`${base}/api/jobs/${job.id}/log`, { headers: B });
    assert.equal(logA.status, 200);
    assert.equal(logB.status, 403);

    // 共享资源库：两个临时用户看到同一份索引
    const treeA = await (await fetch(`${base}/api/library/tree?light=1`, { headers: A })).json();
    const treeB = await (await fetch(`${base}/api/library/tree?light=1`, { headers: B })).json();
    assert.equal(treeA.stats.files, treeB.stats.files);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
