/**
 * 文件锁定：锁定后禁止删除（文件 / 文件夹内包含锁定文件）、改名后仍锁定、跨重启持久化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createLibrary, createLibraryRouter } from '../src/library.js';

async function makeLibrary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-clip-locks-'));
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
  };
  const library = createLibrary(options);
  await library.init();
  return { base, root, library, options };
}

test('锁定文件后禁止删除；解锁后可正常删除', async () => {
  const { base, library } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((entry) => entry.path === 'A/one.png');
    assert.equal(one.locked, false);

    const locked = await library.setLocks([{ id: one.id }], true);
    assert.equal(locked[0].ok, true);
    const afterLock = await library.scan({ light: true, force: true });
    assert.equal(afterLock.entries.find((entry) => entry.path === 'A/one.png').locked, true);

    const denied = await library.trashPaths([{ id: one.id }]);
    assert.equal(denied[0].ok, false);
    assert.match(denied[0].error, /锁定/);
    assert.equal(await fs.readFile(path.join(base, 'library', 'A', 'one.png'), 'utf8'), 'one');

    await library.setLocks([{ id: one.id }], false);
    const removed = await library.trashPaths([{ id: one.id }]);
    assert.equal(removed[0].ok, true);
    await assert.rejects(fs.stat(path.join(base, 'library', 'A', 'one.png')));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('文件夹内包含锁定文件时整个文件夹都不能删除', async () => {
  const { base, library } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((entry) => entry.path === 'A/one.png');
    await library.setLocks([{ id: one.id }], true);

    const denied = await library.trashPaths([{ path: 'A' }]);
    assert.equal(denied[0].ok, false);
    assert.match(denied[0].error, /文件夹内.*锁定/);
    assert.equal(await fs.readFile(path.join(base, 'library', 'A', 'one.png'), 'utf8'), 'one');
    assert.equal(await fs.readFile(path.join(base, 'library', 'A', 'two.png'), 'utf8'), 'two');

    await library.setLocks([{ id: one.id }], false);
    const removed = await library.trashPaths([{ path: 'A' }]);
    assert.equal(removed[0].ok, true);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('改名 / 移动后锁定状态跟着文件走；跨重启持久化', async () => {
  const { base, library, options } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((entry) => entry.path === 'A/one.png');
    await library.setLocks([{ id: one.id }], true);

    const renamed = await library.renameItems([{ id: one.id, name: 'locked.png' }]);
    assert.equal(renamed[0].ok, true);
    const moved = await library.movePaths([{ id: one.id }], '');
    assert.equal(moved[0].ok, true);
    const after = await library.scan({ light: true, force: true });
    const renamedEntry = after.entries.find((entry) => entry.id === one.id);
    assert.equal(renamedEntry.locked, true);
    assert.equal(renamedEntry.path, 'locked.png');
    assert.equal((await library.trashPaths([{ id: one.id }]))[0].ok, false);

    await library.fileIds.persist();
    await library.fileLocks.persist();
    const reopened = createLibrary(options);
    await reopened.init();
    const restored = await reopened.scan({ light: true, force: true });
    assert.equal(restored.entries.find((entry) => entry.id === one.id).locked, true);
  } finally {
    // 后台指纹索引可能还在写缓存，重试几次再清理
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  }
});

test('HTTP /lock：批量锁定、返回结果与删除拒绝', async () => {
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
      const response = await fetch(`${baseUrl}/api/library/lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: one.id }, { id: two.id }], locked: true }),
      });
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.succeeded, 2);

      const remove = await fetch(`${baseUrl}/api/library/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [{ id: one.id }, { id: two.id }] }),
      });
      const removeBody = await remove.json();
      assert.equal(removeBody.ok, false);
      assert.equal(removeBody.succeeded, 0);
      assert.match(removeBody.results[0].error, /锁定/);
      assert.equal((await fs.stat(path.join(base, 'library', 'A', 'one.png'))).isFile(), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
