/**
 * 指纹索引：存量补建 / 新增自动补 / 幂等 / 落盘
 * --------------------------------------------
 * 对应需求：
 *  1) 为现有资源生成指纹（ensurePhashIndex 全量补建）；
 *  2) 后续每一个新增资源都生成指纹（扫描发现新图 / 写操作 phashTouch / 手动触发）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { createLibrary } from '../src/library.js';

// 测试里不让启动预热自动跑，避免和断言抢时序；手动调 ensurePhashIndex / scan
process.env.IMAGE_CLIP_PHASH_AUTO = '0';

async function makeImage(file, { width = 160, height = 120, color = '#2563eb', dot = '#facc15' } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${color}"/>
    <circle cx="${width * 0.4}" cy="${height * 0.45}" r="${Math.min(width, height) * 0.22}" fill="${dot}"/>
  </svg>`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function waitFor(check, { timeout = 6000, interval = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

async function makeLibrary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'phash-lib-'));
  const root = path.join(base, 'library');
  const thumbnailRoot = path.join(base, 'thumbs');
  const cacheRoot = path.join(base, 'cache');
  const library = createLibrary({ root, thumbnailRoot, cacheRoot });
  await library.init();
  return { base, root, cacheRoot, library };
}

test('存量资源：ensurePhashIndex 为全部图片建指纹，并可被相似检索使用', async () => {
  const { base, root, cacheRoot, library } = await makeLibrary();
  try {
    await makeImage(path.join(root, 'a.png'));
    await fs.copyFile(path.join(root, 'a.png'), path.join(root, 'b.png')); // 完全相同的副本
    await makeImage(path.join(root, 'c.png'), { color: '#111111', dot: '#ff0055', width: 240, height: 240 });

    const status = await library.ensurePhashIndex();
    assert.equal(status.totalImages, 3);
    assert.equal(status.indexed, 3);
    assert.equal(status.failed, 0);
    assert.equal(status.running, false);

    const similar = await library.findSimilar({ path: 'a.png', limit: 5 });
    assert.equal(similar.totalImages, 3);
    assert.equal(similar.indexed, 3);
    assert.equal(similar.results[0].path, 'b.png');
    assert.equal(similar.results[0].score, 1);

    // 落盘：重建实例也能直接复用
    const cacheFile = path.join(cacheRoot, 'phash-index.json');
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.equal(Object.keys(cached.entries).length, 3);
    assert.ok(cached.entries['a.png'].hash);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('再次调用是幂等的：不重复计算', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await makeImage(path.join(root, 'a.png'));
    await makeImage(path.join(root, 'b.png'), { color: '#333' });
    await library.ensurePhashIndex();
    const again = await library.ensurePhashIndex();
    assert.equal(again.indexed, 2);
    assert.equal(again.done, 0);
    assert.equal(again.queued, 0);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('新增资源：扫描发现的新图片自动补指纹', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await makeImage(path.join(root, 'a.png'));
    await library.ensurePhashIndex();
    assert.equal(library.phashStatus().indexed, 1);

    // 外部新增一张图（模拟拷进资源库 / 别的进程生成）
    await makeImage(path.join(root, 'new.png'), { color: '#0aa' });
    // 列表刷新时会走 scan(light)，扫描结果里发现新图 → 自动入队
    await library.scan({ light: true, force: true });
    assert.ok(await waitFor(() => library.phashStatus().indexed === 2));
    assert.equal(library.phashStatus().queued, 0);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('新增资源：写操作后 phashTouch 立即排队', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await library.ensurePhashIndex();
    // 上传 / 复制 / 截帧写入后会调用 phashTouch
    await makeImage(path.join(root, 'uploaded.png'));
    library.phashTouch('uploaded.png');
    assert.ok(await waitFor(() => library.phashStatus().indexed === 1));
    const similar = await library.findSimilar({ path: 'uploaded.png', limit: 3 });
    assert.equal(similar.totalImages, 1);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('改名迁移指纹；删除后清掉指纹；force 重算', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await makeImage(path.join(root, 'old.png'));
    await library.ensurePhashIndex();
    assert.equal(library.phashStatus().indexed, 1);

    const renamed = await library.renameItems([{ path: 'old.png', name: 'renamed.png' }]);
    assert.equal(renamed[0].ok, true);
    await library.scan({ light: true, force: true });
    // 指纹跟着路径走，不需要重算
    assert.ok(await waitFor(() => library.phashStatus().indexed === 1));
    const similar = await library.findSimilar({ path: 'renamed.png', limit: 3 });
    assert.equal(similar.totalImages, 1);

    // 移入回收站 → 指纹移除
    await library.trashPaths(['renamed.png']);
    await library.scan({ light: true, force: true });
    assert.ok(await waitFor(() => library.phashStatus().indexed === 0));

    // 恢复 → 自动补指纹
    const trash = await library.listTrash();
    await library.restoreTrash([trash.items[0].id]);
    assert.ok(await waitFor(() => library.phashStatus().indexed === 1));

    // force 重算：done 计数 = 图片总数
    const forced = await library.ensurePhashIndex({ force: true });
    assert.equal(forced.done, 1);
    assert.equal(forced.indexed, 1);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('启动预热：init 后自动为存量图片补指纹（无需手动调用）', async () => {
  process.env.IMAGE_CLIP_PHASH_AUTO = '1';
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'phash-warm-'));
  const root = path.join(base, 'library');
  try {
    // 先放好存量图片，再 createLibrary + init：模拟「服务启动时库里已有资源」
    await makeImage(path.join(root, 'auto-a.png'));
    await makeImage(path.join(root, 'auto-b.png'), { color: '#046' });
    const library = createLibrary({
      root,
      thumbnailRoot: path.join(base, 'thumbs'),
      cacheRoot: path.join(base, 'cache'),
    });
    await library.init();
    assert.ok(await waitFor(() => library.phashStatus().indexed === 2, { timeout: 12000 }));
  } finally {
    process.env.IMAGE_CLIP_PHASH_AUTO = '0';
    await fs.rm(base, { recursive: true, force: true });
  }
});
