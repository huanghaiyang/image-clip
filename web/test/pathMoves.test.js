import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dirnamePosix,
  entryMetaPatch,
  movesFromResults,
  remapDuplicateGroups,
  remapLibraryPath,
} from '../src/lib/pathMoves.js';

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

test('entryMetaPatch：只保留尺寸 / 时长等描述字段，不覆盖 path/name/id/bytes', () => {
  const info = {
    path: 'A/old.png',
    name: 'old.png',
    id: 'f_1',
    bytes: 228,
    mtime: 1,
    width: 1186,
    height: 802,
    format: 'png',
  };
  assert.deepEqual(entryMetaPatch(info), { width: 1186, height: 802, format: 'png' });
  assert.deepEqual(entryMetaPatch({ width: 10 }), { width: 10 });
  assert.deepEqual(entryMetaPatch(null), {});
});

test('dirnamePosix：根目录返回空串', () => {
  assert.equal(dirnamePosix('A/old.png'), 'A');
  assert.equal(dirnamePosix('A/sub/x.png'), 'A/sub');
  assert.equal(dirnamePosix('root.png'), '');
});

test('remapDuplicateGroups：改名保持组，移动出目录的成员被剔除，少于 2 个的组消失', () => {
  const groups = [
    { paths: ['A/a.png', 'A/b.png'] },
    { paths: ['A/c.png', 'A/d.png'] },
  ];
  const moves = [
    { from: 'A/a.png', to: 'A/a-renamed.png' },
    { from: 'A/d.png', to: 'B/d.png' },
  ];
  const next = remapDuplicateGroups(groups, moves, 'A');
  assert.deepEqual(next, [{ paths: ['A/a-renamed.png', 'A/b.png'] }]);
  assert.deepEqual(remapDuplicateGroups(groups, [], ''), []);
});
