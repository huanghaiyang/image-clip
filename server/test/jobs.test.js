/**
 * 后台任务管理器单测
 * ------------------
 * 覆盖：创建/进度/完成/失败/取消、列表排序、上限裁剪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createJobManager } from '../src/jobs.js';

test('创建 → 更新进度 → 完成', () => {
  const jobs = createJobManager();
  const job = jobs.create({ type: 'video.frames', label: '截帧', meta: { path: 'a.mp4' } });
  assert.equal(job.status, 'running');
  assert.equal(job.progress, 0);

  jobs.update(job.id, { progress: 0.4, detail: '已截取 2/5' });
  const running = jobs.get(job.id);
  assert.equal(running.progress, 0.4);
  assert.equal(running.detail, '已截取 2/5');

  jobs.update(job.id, { progress: 5 }); // 越界会被夹到 1
  assert.equal(jobs.get(job.id).progress, 1);

  jobs.finish(job.id, { extracted: 5 });
  const done = jobs.get(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 1);
  assert.deepEqual(done.result, { extracted: 5 });
  assert.ok(done.finishedAt > 0);
});

test('失败与取消', () => {
  const jobs = createJobManager();
  const failed = jobs.create({ type: 'video.frames', label: '断' });
  jobs.fail(failed.id, 'ffmpeg 崩了');
  assert.equal(jobs.get(failed.id).status, 'failed');
  assert.match(jobs.get(failed.id).error, /ffmpeg/);

  const cancelled = jobs.create({ type: 'video.frames', label: '取消' });
  jobs.cancel(cancelled.id);
  assert.equal(jobs.get(cancelled.id).cancelled, true);
  // 已结束的任务再 finish/fail 不会覆盖状态
  jobs.finish(failed.id, {});
  assert.equal(jobs.get(failed.id).status, 'failed');
});

test('列表按开始时间倒序，并裁剪到上限', () => {
  const jobs = createJobManager({ max: 3 });
  const first = jobs.create({ type: 'a', label: '1' });
  const second = jobs.create({ type: 'b', label: '2' });
  const third = jobs.create({ type: 'c', label: '3' });
  jobs.finish(first.id);
  jobs.finish(second.id);
  jobs.finish(third.id);
  const fourth = jobs.create({ type: 'd', label: '4' });
  jobs.finish(fourth.id);

  const list = jobs.list();
  assert.ok(list.length <= 3);
  assert.equal(list[0].id, fourth.id);
  assert.ok(jobs.list({ active: true }).every((job) => job.status === 'running'));
});
