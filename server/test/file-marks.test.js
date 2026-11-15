/**
 * 收藏 / emoji 标记：按文件 id 持久化、改名/移动不丢、HTTP 接口、删除时清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createLibrary, createLibraryRouter } from '../src/library.js';

async function makeLibrary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-clip-marks-'));
  const root = path.join(base, 'library');
  await fs.mkdir(path.join(root, 'A'), { recursive: true });
  await fs.writeFile(path.join(root, 'A', 'one.png'), 'one');
  await fs.writeFile(path.join(root, 'A', 'two.png'), 'two');
  const options = {
    root,
    thumbnailRoot: path.join(base, 'thumbs'),
    cacheRoot: path.join(base, 'cache'),
    idFile: path.join(base, 'cache', 'file-ids.json'),
    lockFile: path.join(base, 'cache', 'file-locks.json'),
    markFile: path.join(base, 'cache', 'file-marks.json'),
  };
  const library = createLibrary(options);
  await library.init();
  return { base, options, library };
}

async function cleanup(base) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

test('收藏与 emoji 标记：写入后条目可见，可取消/清除', async () => {
  const { base, library } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((entry) => entry.path === 'A/one.png');
    assert.equal(one.favorite, false);
    assert.equal(one.mark, null);

    const rows = await library.setMarks([{ id: one.id }], { favorite: true, mark: '⭐' });
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].favorite, true);
    assert.equal(rows[0].mark, '⭐');

    const after = await library.scan({ light: true, force: true });
    const entry = after.entries.find((item) => item.id === one.id);
    assert.equal(entry.favorite, true);
    assert.equal(entry.mark, '⭐');

    await library.setMarks([{ id: one.id }], { favorite: false, mark: null });
    const cleared = await library.scan({ light: true, force: true });
    assert.equal(cleared.entries.find((item) => item.id === one.id).favorite, false);
    assert.equal(cleared.entries.find((item) => item.id === one.id).mark, null);
  } finally {
    await cleanup(base);
  }
});

test('改名 / 移动后收藏与标记跟着 id 走；跨重启持久化', async () => {
  const { base, library, options } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((entry) => entry.path === 'A/one.png');
    await library.setMarks([{ id: one.id }], { favorite: true, mark: '🔥' });

    await library.renameItems([{ id: one.id, name: 'kept.png' }]);
    const moved = await library.movePaths([{ id: one.id }], '');
    assert.equal(moved[0].ok, true);

    const after = await library.scan({ light: true, force: true });
    const entry = after.entries.find((item) => item.id === one.id);
    assert.equal(entry.path, 'kept.png');
    assert.equal(entry.favorite, true);
    assert.equal(entry.mark, '🔥');

    await library.fileIds.persist();
    await library.fileMarks.persist();
    const reopened = createLibrary(options);
    await reopened.init();
    const restored = await reopened.scan({ light: true, force: true });
    const again = restored.entries.find((item) => item.id === one.id);
    assert.equal(again.favorite, true);
    assert.equal(again.mark, '🔥');
  } finally {
    await cleanup(base);
  }
});

test('删除时清理收藏 / 标记；非法标记拒绝', async () => {
  const { base, library } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((entry) => entry.path === 'A/one.png');
    await library.setMarks([{ id: one.id }], { favorite: true, mark: '📌' });

    await assert.rejects(library.setMarks([{ id: one.id }], { mark: 'x'.repeat(20) }), /8/);
    await library.trashPaths([{ id: one.id }]);
    const after = await library.scan({ light: true, force: true });
    assert.ok(!after.entries.some((item) => item.id === one.id));
  } finally {
    await cleanup(base);
  }
});

test('HTTP /marks：批量收藏与标记、返回字段正确', async () => {
  const { base, library } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((entry) => entry.path === 'A/one.png');
    const two = scan.entries.find((entry) => entry.path === 'A/two.png');
    const app = express();
    app.use('/api/library', createLibraryRouter(library));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${baseUrl}/api/library/marks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: one.id }, { id: two.id }], favorite: true, mark: '🎯' }),
      });
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.succeeded, 2);
      assert.equal(body.results[0].favorite, true);
      assert.equal(body.results[0].mark, '🎯');

      const clear = await fetch(`${baseUrl}/api/library/marks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: two.id }], mark: null }),
      });
      const clearBody = await clear.json();
      assert.equal(clearBody.results[0].mark, null);
      assert.equal(clearBody.results[0].favorite, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await cleanup(base);
  }
});
