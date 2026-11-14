/**
 * 素材面板界面现场：导入/导出归一化单测
 * ------------------------------------
 * 这个现场随临时会话落盘，必须能容忍旧会话 / 脏数据：
 * tab 只认 workspace|library，滚动位置取非负整数，搜索词只接受字符串。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { exportAssetView, importAssetView, resetAssetView, useAssetView } from '../src/composables/useAssetView.js';

const { state } = useAssetView();

test('初始状态：tab 未决定，滚动为 0', () => {
  resetAssetView();
  assert.equal(state.tab, null);
  assert.equal(state.keyword, '');
  assert.deepEqual({ ...state.scrollTop }, { workspace: 0, library: 0 });
});

test('导出/导入往返保持现场', () => {
  resetAssetView();
  state.tab = 'library';
  state.keyword = 'case-1';
  state.scrollTop.workspace = 300;
  state.scrollTop.library = 120;

  const doc = exportAssetView();
  resetAssetView();
  importAssetView(doc);

  assert.equal(state.tab, 'library');
  assert.equal(state.keyword, 'case-1');
  assert.deepEqual({ ...state.scrollTop }, { workspace: 300, library: 120 });
});

test('非法 tab / 脏滚动值被归一化', () => {
  resetAssetView();
  importAssetView({
    tab: 'nope',
    keyword: 123,
    scrollTop: { workspace: -50, library: 'abc' },
  });
  assert.equal(state.tab, null);
  assert.equal(state.keyword, '');
  assert.deepEqual({ ...state.scrollTop }, { workspace: 0, library: 0 });
});

test('滚动位置取整，浮点/字符串数字可用', () => {
  resetAssetView();
  importAssetView({ tab: 'workspace', scrollTop: { workspace: 302.6, library: '88' } });
  assert.equal(state.tab, 'workspace');
  assert.equal(state.scrollTop.workspace, 303);
  assert.equal(state.scrollTop.library, 88);
});

test('没有 assets 字段的旧会话（undefined）不覆盖现有现场', () => {
  resetAssetView();
  state.tab = 'workspace';
  state.scrollTop.workspace = 42;
  importAssetView(undefined);
  importAssetView(null);
  assert.equal(state.tab, 'workspace');
  assert.equal(state.scrollTop.workspace, 42);
});

test('空对象按“没有现场”处理（tab 回到自动判断、滚动归零）', () => {
  resetAssetView();
  state.tab = 'workspace';
  state.scrollTop.workspace = 42;
  importAssetView({});
  assert.equal(state.tab, null);
  assert.equal(state.scrollTop.workspace, 0);
});

test('reset 清空所有字段', () => {
  state.tab = 'library';
  state.keyword = 'x';
  state.scrollTop.library = 99;
  resetAssetView();
  assert.deepEqual(exportAssetView(), {
    tab: '',
    keyword: '',
    scrollTop: { workspace: 0, library: 0 },
  });
});
