/**
 * 移动 / 复制同名文件的冲突处理
 * -----------------------------
 * 判据：把文件移动/复制到已有同名文件的目录时，绝不能覆盖，必须自动加序号，
 * 且两边文件内容都保持不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLibrary } from '../src/library.js';

async function makeLibrary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'library-move-'));
  const root = path.join(base, 'library');
  await fs.mkdir(path.join(root, 'A'), { recursive: true });
  await fs.mkdir(path.join(root, 'B'), { recursive: true });
  await fs.writeFile(path.join(root, 'A', 'same.png'), 'from-A');
  await fs.writeFile(path.join(root, 'B', 'same.png'), 'from-B');
  const library = createLibrary({
    root,
    thumbnailRoot: path.join(base, 'thumbs'),
    cacheRoot: path.join(base, 'cache'),
  });
  await library.init();
  return { base, root, library };
}

test('移动到已有同名文件的目录：自动加序号，不覆盖任何一方', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    const results = await library.movePaths(['A/same.png'], 'B');
    const row = results.find((item) => item.ok);
    assert.ok(row, '移动应成功');
    assert.equal(row.to, 'B/same (2).png', '目标已存在时应自动加序号');
    assert.equal(await fs.readFile(path.join(root, 'B', 'same.png'), 'utf8'), 'from-B');
    assert.equal(await fs.readFile(path.join(root, 'B', 'same (2).png'), 'utf8'), 'from-A');
    await assert.rejects(fs.readFile(path.join(root, 'A', 'same.png')));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('复制到已有同名文件的目录：自动加序号，原文件保留', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    const results = await library.copyPaths(['A/same.png'], 'B');
    const row = results.find((item) => item.ok);
    assert.ok(row, '复制应成功');
    assert.equal(row.to, 'B/same (2).png');
    assert.equal(await fs.readFile(path.join(root, 'B', 'same.png'), 'utf8'), 'from-B');
    assert.equal(await fs.readFile(path.join(root, 'B', 'same (2).png'), 'utf8'), 'from-A');
    assert.equal(await fs.readFile(path.join(root, 'A', 'same.png'), 'utf8'), 'from-A');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('同名文件批量改名：冲突时自动加序号，不互相覆盖', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await fs.writeFile(path.join(root, 'A', 'x.png'), 'x');
    await fs.writeFile(path.join(root, 'A', 'y.png'), 'y');
    const results = await library.renameItems([
      { path: 'A/x.png', name: 'z.png' },
      { path: 'A/y.png', name: 'z.png' },
    ]);
    assert.ok(results.every((row) => row.ok));
    const names = new Set(results.map((row) => row.to.split('/').pop()));
    assert.equal(names.size, 2, '两个文件不能落到同一个名字');
    assert.ok([...names].includes('z.png'));
    const contents = await Promise.all([...names].map((name) => fs.readFile(path.join(root, 'A', name), 'utf8')));
    assert.deepEqual(contents.sort(), ['x', 'y']);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
