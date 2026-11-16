/**
 * 批量创建固定名称子文件夹：正常创建、跳过已存在/重名/非法名称、HTTP 接口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createLibrary, createLibraryRouter } from '../src/library.js';

async function makeLibrary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-clip-mkdirs-'));
  const root = path.join(base, 'library');
  await fs.mkdir(root, { recursive: true });
  const library = createLibrary({
    root,
    thumbnailRoot: path.join(base, 'thumbs'),
    cacheRoot: path.join(base, 'cache'),
    idFile: path.join(base, 'cache', 'file-ids.json'),
    lockFile: path.join(base, 'cache', 'file-locks.json'),
    markFile: path.join(base, 'cache', 'file-marks.json'),
  });
  await library.init();
  return { base, root, library };
}

async function cleanup(base) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

test('批量创建：正常创建并跳过已存在 / 批内重名 / 非法名称', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await fs.mkdir(path.join(root, '已有'));
    const rows = await library.mkdirBatch('', ['图标', '背景', '已有', '图标', 'bad/name']);
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((row) => row.ok).length, 2);
    assert.equal(rows.find((row) => row.name === '图标').status, 'created');
    assert.equal(rows.find((row) => row.name === '背景').status, 'created');
    assert.equal(rows.find((row) => row.name === '已有').status, 'exists');
    assert.equal(rows.filter((row) => row.name === '图标')[1].status, 'duplicate');
    assert.equal(rows.find((row) => row.name === 'bad/name').status, 'invalid');

    assert.equal((await fs.stat(path.join(root, '图标'))).isDirectory(), true);
    assert.equal((await fs.stat(path.join(root, '背景'))).isDirectory(), true);
  } finally {
    await cleanup(base);
  }
});

test('批量创建支持子目录作为父级，并在父目录不存在时报错', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await fs.mkdir(path.join(root, 'parent'));
    const rows = await library.mkdirBatch('parent', ['a', 'b']);
    assert.equal(rows.filter((row) => row.ok).length, 2);
    assert.equal(rows[0].path, 'parent/a');

    await assert.rejects(library.mkdirBatch('missing', ['a']), /目标目录不存在/);
  } finally {
    await cleanup(base);
  }
});

test('HTTP /mkdir-batch 返回创建数量与逐项状态', async () => {
  const { base, library } = await makeLibrary();
  try {
    const app = express();
    app.use('/api/library', createLibraryRouter(library));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${baseUrl}/api/library/mkdir-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: '', names: ['x', 'y', 'x'] }),
      });
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.created, 2);
      assert.equal(body.total, 3);
      assert.equal(body.results[2].status, 'duplicate');

      const again = await fetch(`${baseUrl}/api/library/mkdir-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: '', names: ['x'] }),
      });
      const againBody = await again.json();
      assert.equal(againBody.created, 0);
      assert.equal(againBody.results[0].status, 'exists');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await cleanup(base);
  }
});
