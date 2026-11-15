/**
 * 任务队列：并发上限、排队位置、用户配额、取消、日志落盘、统计。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createJobManager, JobLimitError } from '../src/jobs.js';
import { createLogger } from '../src/logger.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('并发上限：最多 2 个同时运行，其余排队并给出位置', () => {
  const jobs = createJobManager({ concurrency: 2, maxPerUser: 5 });
  const gates = [];
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    const gate = deferred();
    gates.push(gate);
    results.push(jobs.run({ type: 't', label: `任务${i}`, userId: 'u1' }, () => gate.promise));
  }
  assert.equal(jobs.stats().running, 2);
  assert.equal(jobs.stats().queued, 2);
  assert.equal(results[0].status, 'running');
  assert.equal(results[2].status, 'queued');
  assert.equal(results[2].queuePosition, 1);
  assert.equal(results[3].queuePosition, 2);
});

test('任务完成/失败：状态、结果与队列推进', async () => {
  const jobs = createJobManager({ concurrency: 1, maxPerUser: 10 });
  const firstGate = deferred();
  const first = jobs.run({ type: 't', label: 'A' }, () => firstGate.promise);
  const second = jobs.run({ type: 't', label: 'B' }, async () => 'second');
  assert.equal(second.status, 'queued');
  firstGate.resolve('first');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobs.get(first.id).status, 'done');
  assert.equal(jobs.get(first.id).result, 'first');
  assert.equal(jobs.get(second.id).status, 'done');
  assert.equal(jobs.get(second.id).result, 'second');

  const failing = jobs.run({ type: 't', label: 'C' }, async () => {
    throw new Error('炸了');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(jobs.get(failing.id).status, 'failed');
  assert.match(jobs.get(failing.id).error, /炸了/);
});

test('每用户配额：超过 maxPerUser 抛 JobLimitError', () => {
  const jobs = createJobManager({ concurrency: 1, maxPerUser: 2 });
  const gate1 = deferred();
  const gate2 = deferred();
  jobs.run({ type: 't', label: '1', userId: 'u1' }, () => gate1.promise);
  jobs.run({ type: 't', label: '2', userId: 'u1' }, () => gate2.promise);
  assert.throws(
    () => jobs.run({ type: 't', label: '3', userId: 'u1' }, async () => null),
    (err) => err instanceof JobLimitError && err.status === 429,
  );
  // 另一个用户不受影响
  const other = jobs.run({ type: 't', label: 'other', userId: 'u2' }, async () => null);
  assert.ok(other.id);
});

test('取消：排队任务立即取消，运行任务标记 cancelled 并在结束后落状态', async () => {
  const jobs = createJobManager({ concurrency: 1, maxPerUser: 10 });
  const gate = deferred();
  const running = jobs.run({ type: 't', label: 'running' }, () => gate.promise);
  const queued = jobs.run({ type: 't', label: 'queued' }, async () => null);
  jobs.cancel(queued.id);
  assert.equal(jobs.get(queued.id).status, 'cancelled');
  jobs.cancel(running.id);
  assert.equal(jobs.get(running.id).cancelled, true);
  gate.resolve(null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobs.get(running.id).status, 'cancelled');
});

test('任务日志：写入单任务文件与汇总文件，含状态与进度', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-clip-joblog-'));
  try {
    const logger = createLogger({ dir, now: () => new Date(2026, 0, 5, 8, 0, 0), minLevel: 'debug' });
    await logger.init();
    const jobs = createJobManager({ concurrency: 1, maxPerUser: 5, logger });
    const gate = deferred();
    const job = jobs.run({ type: 'video.frames', label: '截帧', userId: 'u1' }, async (ctx) => {
      ctx.progress(0.5, '一半');
      ctx.log('中间日志', { step: 1 });
      await gate.promise;
      return { extracted: 3 };
    });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await logger.flush();

    const file = logger.fileForJob(job.id, new Date(2026, 0, 5, 8, 0, 0));
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const messages = lines.map((line) => line.msg);
    assert.ok(messages.includes('enqueued'));
    assert.ok(messages.includes('started'));
    assert.ok(messages.includes('progress'));
    assert.ok(messages.includes('中间日志'));
    assert.ok(messages.includes('done'));
    const aggregate = await fs.readFile(logger.fileForJobDay(new Date(2026, 0, 5, 8, 0, 0)), 'utf8');
    assert.match(aggregate, /enqueued/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
