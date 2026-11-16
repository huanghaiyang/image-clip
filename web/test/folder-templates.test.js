/**
 * 批量建夹模板：内置模板、保存/覆盖/删除、去重与坏数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_FOLDER_TEMPLATES,
  FOLDER_TEMPLATE_KEY,
  loadFolderTemplates,
  normalizeFolderNames,
  removeFolderTemplate,
  saveFolderTemplates,
  upsertFolderTemplate,
} from '../src/lib/folderTemplates.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test('normalizeFolderNames：去空、去首尾空格、按小写去重', () => {
  assert.deepEqual(normalizeFolderNames(['  图标 ', '背景', '', '图标', 'ICON', 'icon']), ['图标', '背景', 'ICON']);
});

test('loadFolderTemplates 默认只有内置模板', () => {
  const list = loadFolderTemplates(fakeStorage());
  assert.equal(list.length, BUILTIN_FOLDER_TEMPLATES.length);
  assert.ok(list.every((item) => item.builtin));
  assert.deepEqual(list[0].names, BUILTIN_FOLDER_TEMPLATES[0].names);
});

test('保存自定义模板后能重新加载；同名保存覆盖而不是重复', () => {
  const storage = fakeStorage();
  let list = loadFolderTemplates(storage);
  list = upsertFolderTemplate(list, { name: '我的目录', names: ['a', 'b', 'a'] });
  saveFolderTemplates(list, storage);
  const reloaded = loadFolderTemplates(storage);
  const mine = reloaded.find((item) => item.name === '我的目录');
  assert.ok(mine);
  assert.deepEqual(mine.names, ['a', 'b']);
  assert.equal(mine.builtin, false);

  list = upsertFolderTemplate(reloaded, { name: '我的目录', names: ['c'] });
  saveFolderTemplates(list, storage);
  const again = loadFolderTemplates(storage).filter((item) => item.name === '我的目录');
  assert.equal(again.length, 1);
  assert.deepEqual(again[0].names, ['c']);
});

test('删除自定义模板；内置模板不能删；坏数据不影响内置', () => {
  const storage = fakeStorage({
    [FOLDER_TEMPLATE_KEY]: JSON.stringify([{ id: 'custom-1', name: '临时', names: ['x'] }, { name: '', names: [] }]),
  });
  let list = loadFolderTemplates(storage);
  const custom = list.find((item) => item.name === '临时');
  assert.ok(custom);
  list = removeFolderTemplate(list, custom.id);
  assert.ok(!list.some((item) => item.name === '临时'));
  list = removeFolderTemplate(list, BUILTIN_FOLDER_TEMPLATES[0].id);
  assert.ok(list.some((item) => item.builtin && item.id === BUILTIN_FOLDER_TEMPLATES[0].id));

  const broken = loadFolderTemplates(fakeStorage({ [FOLDER_TEMPLATE_KEY]: '{bad json' }));
  assert.equal(broken.length, BUILTIN_FOLDER_TEMPLATES.length);
});
