/**
 * 日志系统：按天拆分、按大小再拆、任务日志分离、保留期清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../src/logger.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'image-clip-logs-'));
}

test('应用日志按天写入 JSONL，字段完整', async () => {
  const dir = await tempDir();
  try {
    const day = new Date(2026, 0, 2, 10, 30, 0);
    const logger = createLogger({ dir, now: () => day, minLevel: 'debug' });
    await logger.init();
    logger.info('server', '启动', { port: 8786 });
    logger.error('jobs', '失败', { id: 'job-1', error: 'boom' });
    await logger.flush();

    const file = path.join(dir, 'app-2026-01-02.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].scope, 'server');
    assert.equal(lines[0].msg, '启动');
    assert.equal(lines[0].port, 8786);
    assert.equal(lines[1].level, 'error');
    assert.match(lines[0].t, /2026-01-02T/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('同一天超过 maxBytes 时继续拆分（.1/.2）', async () => {
  const dir = await tempDir();
  try {
    const day = new Date(2026, 0, 3, 9, 0, 0);
    const logger = createLogger({ dir, now: () => day, maxBytes: 120, minLevel: 'info' });
    await logger.init();
    for (let i = 0; i < 12; i += 1) logger.info('split', `第 ${i} 行`, { payload: 'x'.repeat(30) });
    await logger.flush();
    const names = (await fs.readdir(dir)).filter((name) => name.startsWith('app-2026-01-03')).sort();
    assert.ok(names.includes('app-2026-01-03.jsonl'));
    assert.ok(names.length >= 2, `应当拆分出多个文件，实际 ${names.join(',')}`);
    const stats = await Promise.all(names.map(async (name) => (await fs.stat(path.join(dir, name))).size));
    assert.ok(stats.every((size) => size <= 400), '拆分文件不应无限增长');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('任务日志：单任务文件 + 当天汇总，可 tail', async () => {
  const dir = await tempDir();
  try {
    const day = new Date(2026, 0, 4, 12, 0, 0);
    const logger = createLogger({ dir, now: () => day, minLevel: 'debug' });
    await logger.init();
    logger.jobLog('job-abc', 'info', 'video.frames', '开始', { userId: 'u1' });
    logger.jobLog('job-abc', 'info', 'video.frames', '完成', { frames: 5 });
    logger.jobLog('job-other', 'warn', 'video.frames', '取消', {});
    await logger.flush();

    const single = path.join(dir, 'jobs', '2026-01-04', 'job-abc.jsonl');
    const aggregate = path.join(dir, 'jobs', 'jobs-2026-01-04.jsonl');
    const singleLines = (await fs.readFile(single, 'utf8')).split('\n').filter(Boolean);
    assert.equal(singleLines.length, 2);
    const allLines = (await fs.readFile(aggregate, 'utf8')).split('\n').filter(Boolean);
    assert.equal(allLines.length, 3, '汇总文件应包含所有任务');

    const tailed = await logger.tailFile(single, 1);
    assert.equal(tailed.total, 2);
    assert.equal(tailed.lines.length, 1);
    assert.equal(JSON.parse(tailed.lines[0]).msg, '完成');

    const list = await logger.listLogs();
    assert.ok(list.jobDays.some((dayEntry) => dayEntry.day === '2026-01-04'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('保留期清理：过期文件被删除，新文件保留', async () => {
  const dir = await tempDir();
  try {
    const logger = createLogger({ dir, retainAppDays: 3, retainJobDays: 3, now: () => new Date(2026, 0, 10) });
    await logger.init();
    await fs.mkdir(path.join(dir, 'jobs', '2025-01-01'), { recursive: true });
    const oldApp = path.join(dir, 'app-2025-01-01.jsonl');
    const newApp = path.join(dir, 'app-2026-01-10.jsonl');
    const oldJob = path.join(dir, 'jobs', '2025-01-01', 'job-old.jsonl');
    await fs.writeFile(oldApp, '{}\n');
    await fs.writeFile(newApp, '{}\n');
    await fs.writeFile(oldJob, '{}\n');
    const old = new Date(2025, 0, 1);
    await fs.utimes(oldApp, old, old);
    await fs.utimes(oldJob, old, old);
    await logger.cleanup();
    const names = await fs.readdir(dir);
    assert.ok(!names.includes('app-2025-01-01.jsonl'), '过期应用日志应被清理');
    assert.ok(names.includes('app-2026-01-10.jsonl'), '新日志应保留');
    await assert.rejects(fs.readFile(oldJob));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
