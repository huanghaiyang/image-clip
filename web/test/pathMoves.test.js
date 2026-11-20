import test from 'node:test';
import assert from 'node:assert/strict';

import { movesFromResults, remapLibraryPath, remapMetaInfo } from '../src/lib/pathMoves.js';

test('remapLibraryPath：文件精确改名、文件夹前缀迁移、最长前缀优先', () => {
  const moves = [
    { from: 'A/old.png', to: 'A/new.png' },
    { from: 'A/sub', to: 'B/sub' },
  ];
  assert.equal(remapLibraryPath('A/old.png', moves), 'A/new.png');
  assert.equal(remapLibraryPath('A/sub/x.png', moves), 'B/sub/x.png');
  assert.equal(remapLibraryPath('A/other.png', moves), 'A/other.png');
});

test('movesFromResults：只取成功且路径确实变化的项', () => {
  const moves = movesFromResults([
    { from: 'A/old.png', to: 'A/new.png', ok: true },
    { from: 'A/x.png', to: 'A/x.png', ok: true },
    { from: 'A/y.png', ok: false, error: 'nope' },
  ]);
  assert.deepEqual(moves, [{ from: 'A/old.png', to: 'A/new.png' }]);
});

test('remapMetaInfo：改名后元数据里的 path 同步到新路径', () => {
  const info = { path: 'A/old.png', id: 'f_1', width: 1186, height: 802, format: 'png' };
  const next = remapMetaInfo(info, 'A/new.png');
  assert.equal(next.path, 'A/new.png');
  assert.equal(next.width, 1186);
  assert.equal(next.id, 'f_1');
  assert.equal(info.path, 'A/old.png', '不应修改原对象');
});

test('remapMetaInfo：没有 path 的元数据原样返回', () => {
  const info = { width: 10, height: 10 };
  assert.equal(remapMetaInfo(info, 'A/new.png'), info);
  assert.equal(remapMetaInfo(null, 'A/new.png'), null);
});
