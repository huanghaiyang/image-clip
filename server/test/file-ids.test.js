/**
 * 文件唯一 id：改名/移动后不变、可跨重启持久化、可用 id 直接操作。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { createLibrary, createLibraryRouter } from '../src/library.js';

async function makeLibrary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'image-clip-ids-'));
  const root = path.join(base, 'library');
  await fs.mkdir(path.join(root, 'A'), { recursive: true });
  await fs.mkdir(path.join(root, 'B'), { recursive: true });
  await fs.writeFile(path.join(root, 'A', 'one.png'), 'one');
  await fs.writeFile(path.join(root, 'A', 'two.png'), 'two');
  const library = createLibrary({
    root,
    thumbnailRoot: path.join(base, 'thumbs'),
    cacheRoot: path.join(base, 'cache'),
    idFile: path.join(base, 'cache', 'file-ids.json'),
  });
  await library.init();
  return { base, root, library };
}

/**
 * 清掉临时目录。fileIds 的落盘是 300ms 防抖定时器，直接 rm 会与写入竞争，
 * 在 Windows 上表现为 ENOTEMPTY；先等定时器过去，再让 fs.rm 自己重试。
 */
async function cleanupBase(base) {
  await new Promise((resolve) => setTimeout(resolve, 350));
  await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('扫描给每个文件分配稳定 id；改名后 id 不变且可用 id 再操作', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    const first = await library.scan({ light: true, force: true });
    const original = first.entries.find((entry) => entry.path === 'A/one.png');
    assert.match(original.id, /^f_[a-f0-9]{12}$/);

    // 只用 id 改名（不传 path）
    const results = await library.renameItems([{ id: original.id, name: 'one-renamed.png' }]);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].to, 'A/one-renamed.png');

    const second = await library.scan({ light: true, force: true });
    const renamed = second.entries.find((entry) => entry.path === 'A/one-renamed.png');
    assert.equal(renamed.id, original.id, '改名后 id 应保持不变');
    assert.equal(await fs.readFile(path.join(root, 'A', 'one-renamed.png'), 'utf8'), 'one');

    // 用 id 再移动
    const moved = await library.movePaths([{ id: original.id }], 'B');
    assert.equal(moved[0].to, 'B/one-renamed.png');
    const third = await library.scan({ light: true, force: true });
    assert.equal(third.entries.find((entry) => entry.path === 'B/one-renamed.png').id, original.id);
  } finally {
    await cleanupBase(base);
  }
});

test('id 持久化：重启后（新实例）同一文件仍是同一个 id', async () => {
  const { base, library } = await makeLibrary();
  try {
    const first = await library.scan({ light: true, force: true });
    const entry = first.entries.find((item) => item.path === 'A/one.png');
    await library.fileIds.persist();

    const reopened = createLibrary({
      root: path.join(base, 'library'),
      thumbnailRoot: path.join(base, 'thumbs'),
      cacheRoot: path.join(base, 'cache'),
      idFile: path.join(base, 'cache', 'file-ids.json'),
    });
    await reopened.init();
    const second = await reopened.scan({ light: true, force: true });
    assert.equal(second.entries.find((item) => item.path === 'A/one.png').id, entry.id);
  } finally {
    await cleanupBase(base);
  }
});

test('删除 / 回收站释放 id；复制得到新 id；resolveRef 找不到失效 id 返回 null', async () => {
  const { base, library } = await makeLibrary();
  try {
    const scan = await library.scan({ light: true, force: true });
    const one = scan.entries.find((item) => item.path === 'A/one.png');
    const two = scan.entries.find((item) => item.path === 'A/two.png');
    assert.ok(library.resolveRef({ id: one.id }));

    // 复制 → 新文件新 id，且复制响应本身就要带新 id / 条目
    const copied = await library.copyPaths([{ id: one.id }], 'B');
    assert.equal(copied[0].ok, true);
    assert.match(copied[0].id, /^f_[a-f0-9]{12}$/);
    assert.notEqual(copied[0].id, one.id);
    assert.equal(copied[0].entry.id, copied[0].id);
    assert.equal(copied[0].entry.path, copied[0].to);
    const afterCopy = await library.scan({ light: true, force: true });
    const clone = afterCopy.entries.find((item) => item.path === copied[0].to);
    assert.ok(clone.id);
    assert.notEqual(clone.id, one.id);

    // 删除（回收站）→ id 失效
    await library.trashPaths([{ id: two.id }]);
    assert.equal(library.resolveRef({ id: two.id }), null);
    const afterDelete = await library.scan({ light: true, force: true });
    assert.ok(!afterDelete.entries.some((item) => item.id === two.id));
  } finally {
    await cleanupBase(base);
  }
});

test('彻底删除回收站项目时，历史版本索引不再指向已删文件', async () => {
  const { base, library } = await makeLibrary();
  try {
    await library.snapshotVersion('A/one.png');
    const trashed = await library.trashPaths(['A/one.png']);
    assert.equal(trashed[0].ok, true);
    await library.purgeTrash([trashed[0].id]);

    const indexFile = path.join(base, 'library', '.versions', 'index.json');
    const index = JSON.parse(await fs.readFile(indexFile, 'utf8').catch(() => '{}'));
    assert.ok(!Object.hasOwn(index, 'A/one.png'), 'purge 后版本索引不应保留已删路径');
  } finally {
    await cleanupBase(base);
  }
});

test('HTTP 接口可直接按 id 访问文件 / 缩略图 / 元数据', async () => {
  const { base, library } = await makeLibrary();
  try {
    const scan = await library.scan({ light: false, force: true });
    const entry = scan.entries.find((item) => item.path === 'A/one.png');
    const app = express();
    app.use('/api/library', createLibraryRouter(library));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      // 用 id 改名（不传 path）
      const rename = await fetch(`${baseUrl}/api/library/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: entry.id, name: 'by-id.png' }] }),
      });
      const body = await rename.json();
      assert.equal(body.ok, true);
      assert.equal(body.results[0].to, 'A/by-id.png');

      const meta = await fetch(`${baseUrl}/api/library/meta?id=${entry.id}`);
      assert.equal(meta.status, 200);
      const metaBody = await meta.json();
      assert.equal(metaBody.path, 'A/by-id.png');

      const file = await fetch(`${baseUrl}/api/library/file?id=${entry.id}`);
      assert.equal(file.status, 200);
      assert.equal(await file.text(), 'one');

      const unknown = await fetch(`${baseUrl}/api/library/file?id=f_000000000000`);
      assert.equal(unknown.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await cleanupBase(base);
  }
});
