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

async function rmWithRetry(target) {
  // 资源库的 fileIds / meta / pHash 都有防抖写盘定时器，Windows 上可能在
  // 测试 finally 执行时仍持有临时文件句柄，导致 ENOTEMPTY。
  await new Promise((resolve) => setTimeout(resolve, 350));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err.code) || attempt === 9) throw err;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
}

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

test('移动到项目自己所在的目录：空操作，不改名也不产生副本', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    const results = await library.movePaths(['A/same.png'], 'A');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].skipped, true);
    assert.equal(results[0].to, 'A/same.png');
    assert.equal(await fs.readFile(path.join(root, 'A', 'same.png'), 'utf8'), 'from-A');
    await assert.rejects(fs.readFile(path.join(root, 'A', 'same (2).png')));
  } finally {
    await rmWithRetry(base);
  }
});

test('批量移动时，已在目标目录的项目保持原名，其余项目正常移动', async () => {
  const { base, root, library } = await makeLibrary();
  try {
    await fs.writeFile(path.join(root, 'A', 'x.png'), 'x');
    const results = await library.movePaths(['A/same.png', 'A/x.png'], 'A');
    assert.ok(results.every((row) => row.ok));
    assert.ok(results.every((row) => row.skipped));
    assert.deepEqual(
      (await fs.readdir(path.join(root, 'A'))).sort(),
      ['same.png', 'x.png'],
      '同目录移动不能改名或生成 (2) 副本',
    );
  } finally {
    await rmWithRetry(base);
  }
});

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
    await rmWithRetry(base);
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
    await rmWithRetry(base);
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
    await rmWithRetry(base);
  }
});
