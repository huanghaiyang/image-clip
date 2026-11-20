import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createExternalAssets } from '../src/externalAssets.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function rmWithRetry(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code) || attempt === 9) throw err;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
}

test('关联资源索引：扫描 AI 产物 / 导出文件，带缩略图，且不混入资源库', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-clip-external-'));
  const artifactDir = path.join(root, 'artifacts');
  const exportDir = path.join(root, 'exports');
  const thumbnailDir = path.join(root, 'thumbs');
  const indexFile = path.join(root, 'cache', 'external-assets-index.json');
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(path.join(exportDir, '子目录'), { recursive: true });
  await fs.writeFile(path.join(artifactDir, 'a_test.png'), PNG_1X1);
  await fs.writeFile(
    path.join(artifactDir, 'a_test.json'),
    JSON.stringify({
      id: 'a_test',
      ext: 'png',
      kind: 'result',
      label: '测试产物',
      width: 1,
      height: 1,
      bytes: PNG_1X1.length,
      sessionId: 'c_test',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  await fs.writeFile(path.join(exportDir, '子目录', '导出图.png'), PNG_1X1);

  const assets = createExternalAssets({
    artifactDir,
    exportDir,
    thumbnailDir,
    indexFile,
  });

  try {
    await assets.init();
    const all = await assets.search({ limit: 10 });
    assert.equal(all.total, 2);
    assert.equal(all.stats.artifacts, 1);
    assert.equal(all.stats.exports, 1);
    assert.ok(all.entries.every((entry) => entry.thumbUrl));

    const byKeyword = await assets.search({ q: '测试产物' });
    assert.equal(byKeyword.total, 1);
    assert.equal(byKeyword.entries[0].source, 'artifact');
    assert.equal(byKeyword.entries[0].sessionId, 'c_test');

    const exportsOnly = await assets.search({ source: 'export' });
    assert.equal(exportsOnly.total, 1);
    assert.equal(exportsOnly.entries[0].name, '导出图.png');

    const artifact = all.entries.find((entry) => entry.source === 'artifact');
    const thumb = await assets.thumbnail(artifact.id, { width: 64 });
    const stat = await fs.stat(thumb);
    assert.ok(stat.size > 0);

    // 索引落盘：重新打开后仍能直接命中
    const reopened = createExternalAssets({ artifactDir, exportDir, thumbnailDir, indexFile });
    await reopened.init();
    assert.equal((await reopened.search({ q: '测试产物' })).total, 1);

    const unknown = await assets.search({ q: '完全不存在的关键字' });
    assert.equal(unknown.total, 0);
  } finally {
    await rmWithRetry(root);
  }
});
