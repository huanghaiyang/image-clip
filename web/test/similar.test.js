/**
 * 相似检索展示辅助单测
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSimilarity, rankSimilarResults, similarityLabel, similarityLevel, summarizeSimilar } from '../src/lib/similar.js';

test('相似度文案分档（按结构 + 颜色的综合分）', () => {
  assert.equal(similarityLabel(1), '几乎相同');
  assert.equal(similarityLabel(0.98), '几乎相同');
  assert.equal(similarityLabel(0.9), '高度相似');
  assert.equal(similarityLabel(0.85), '高度相似');
  assert.equal(similarityLabel(0.75), '相似');
  assert.equal(similarityLabel(0.6), '有点像');
  assert.equal(similarityLabel(0.4), '不太像');
  assert.equal(similarityLabel('nope'), '未知');
});

test('相似度等级用于着色', () => {
  assert.equal(similarityLevel(1), 'same');
  assert.equal(similarityLevel(0.9), 'high');
  assert.equal(similarityLevel(0.75), 'similar');
  assert.equal(similarityLevel(0.5), 'weak');
  assert.equal(similarityLevel(null), 'weak');
});

test('百分比格式化', () => {
  assert.equal(formatSimilarity(0.9321), '93.2%');
  assert.equal(formatSimilarity(1), '100.0%');
  assert.equal(formatSimilarity(-1), '0.0%');
  assert.equal(formatSimilarity(undefined), '—');
});

test('结果按综合分降序，非法项过滤，minScore 生效', () => {
  const ranked = rankSimilarResults(
    [
      { path: 'b.png', score: 0.77 },
      { path: 'a.png', score: 0.93 },
      { path: 'bad.png' },
      { path: 'c.png', score: 0.41 },
      { path: 'd.png', score: 0.93 },
      { path: 'e.png', score: '0.6' },
    ],
    { minScore: 0.5 },
  );
  assert.deepEqual(ranked.map((item) => item.path), ['a.png', 'd.png', 'b.png', 'e.png']);
  assert.equal(rankSimilarResults([{ score: 0.9 }, { score: 0.6 }], { minScore: 0.8 }).length, 1);
  assert.equal(rankSimilarResults([{ score: 0.9 }, { score: 0.6 }], { minScore: 0.95 }).length, 0);
});

test('汇总文案', () => {
  assert.equal(summarizeSimilar({ totalImages: 141, indexed: 141, results: [{}, {}] }), '资源库 141 张图片 · 找到 2 个相似结果');
  assert.equal(summarizeSimilar({ totalImages: 10, indexed: 8, results: [] }), '资源库 10 张图片 · 已建指纹 8 · 没有找到相似图片');
  assert.equal(summarizeSimilar({}), '资源库 0 张图片 · 没有找到相似图片');
});
