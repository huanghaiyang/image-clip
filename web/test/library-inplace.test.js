/**
 * 「就地保存」目标路径单测
 * ------------------------
 * 编辑器输出的都是保留 alpha 的 PNG，所以写回资源库时目标统一成 `.png`：
 *  - 素材已在资源库：覆盖同一个文件（JPG/WebP 需要先改名成 .png，旧内容进历史版本）；
 *  - 素材还没进资源库：在库根目录按素材名新建一个 .png。
 *
 * resolveInPlaceTarget 只做纯路径计算，这里把各种命名情况钉死，
 * 免得 `a.b/c.webp`、没有扩展名、带空路径这些边角把目标路径算歪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveInPlaceTarget } from '../src/lib/library.js';

test('素材已在资源库且就是 PNG：原样覆盖', () => {
  assert.deepEqual(resolveInPlaceTarget('裁剪结果/蝴蝶-01.png'), {
    path: '裁剪结果/蝴蝶-01.png',
    dir: '裁剪结果',
    name: '蝴蝶-01.png',
    renamed: false,
  });
});

test('素材在资源库但不是 PNG：目标改成 .png 并标记需要先改名', () => {
  assert.deepEqual(resolveInPlaceTarget('照片/IMG_0001.JPG'), {
    path: '照片/IMG_0001.JPG',
    dir: '照片',
    name: 'IMG_0001.png',
    renamed: true,
  });
  assert.equal(resolveInPlaceTarget('素材/a.webp').renamed, true);
});

test('根目录文件没有目录段', () => {
  const target = resolveInPlaceTarget('banner.webp');
  assert.equal(target.dir, '');
  assert.equal(target.path, 'banner.webp');
  assert.equal(target.name, 'banner.png');
});

test('路径里的点不会被当成扩展名', () => {
  assert.equal(resolveInPlaceTarget('v1.2/纹理 v2.png').name, '纹理 v2.png');
  assert.equal(resolveInPlaceTarget('v1.2/纹理 v2.webp').name, '纹理 v2.png');
  assert.equal(resolveInPlaceTarget('v1.2/纹理 v2.webp').dir, 'v1.2');
});

test('素材还没进资源库：用素材名在根目录新建 PNG', () => {
  assert.deepEqual(resolveInPlaceTarget('', '蝴蝶-01.webp'), {
    path: '',
    dir: '',
    name: '蝴蝶-01.png',
    renamed: false,
  });
  assert.equal(resolveInPlaceTarget('', '没有扩展名').name, '没有扩展名.png');
});

test('空名字有兜底，不会生成 ".png"', () => {
  assert.equal(resolveInPlaceTarget('', '').name, 'image.png');
  assert.equal(resolveInPlaceTarget(null, null).name, 'image.png');
  assert.equal(resolveInPlaceTarget(undefined, undefined).path, '');
});

test('空白 path 视为“还没进资源库”，不会拼出空格目录', () => {
  assert.deepEqual(resolveInPlaceTarget('   ', '素材.png'), {
    path: '',
    dir: '',
    name: '素材.png',
    renamed: false,
  });
});
