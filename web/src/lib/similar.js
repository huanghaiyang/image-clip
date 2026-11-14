/**
 * 相似资源检索的展示辅助
 * ---------------------
 * 服务端返回综合相似度 score（0~1）与分项 structure / color，
 * 前端统一用这里的纯函数决定文案与分档，避免各组件各写一套阈值。
 *
 * 分档按「结构 + 颜色」加权后的实际分布定：
 *   完全一致 ≈ 1.0；同一素材的不同帧 ≈ 0.85~0.95；同体裁但不同颜色/构图 ≈ 0.55~0.75；
 *   不同主体（花 vs 蝴蝶）通常 < 0.45。
 */

/** 综合相似度 → 一句话结论。 */
export function similarityLabel(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '未知';
  if (value >= 0.97) return '几乎相同';
  if (value >= 0.85) return '高度相似';
  if (value >= 0.7) return '相似';
  if (value >= 0.55) return '有点像';
  return '不太像';
}

/** 分档，用于着色：same / high / similar / weak。 */
export function similarityLevel(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'weak';
  if (value >= 0.97) return 'same';
  if (value >= 0.85) return 'high';
  if (value >= 0.7) return 'similar';
  return 'weak';
}

/** 0.9321 → "93.2%" */
export function formatSimilarity(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '—';
  return `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`;
}

/** 汉明距离 0~64 → 展示文本。 */
export function formatDistance(distance) {
  const value = Number(distance);
  if (!Number.isFinite(value)) return '—';
  return `差异 ${Math.round(value)}/64`;
}

/**
 * 过滤 + 排序结果：按距离升序（距离相同按路径稳定排序）。
 * @param {Array<{distance?:number, score?:number, path?:string}>} results
 * @param {{minScore?:number}} [options]
 */
export function rankSimilarResults(results, { minScore = 0 } = {}) {
  const threshold = Math.max(0, Math.min(1, Number(minScore) || 0));
  return (results ?? [])
    .filter((item) => Number.isFinite(Number(item?.score)))
    .filter((item) => Number(item.score) >= threshold)
    .slice()
    .sort((a, b) => Number(b.score) - Number(a.score) || String(a.path ?? '').localeCompare(String(b.path ?? ''), 'zh-Hans-CN'));
}

/**
 * 汇总一句话：例如「资源库 141 张图片 · 已建指纹 141 · 找到 24 个相似结果」。
 * @param {{totalImages?:number, indexed?:number, results?:Array}} payload
 */
export function summarizeSimilar(payload) {
  const total = Number(payload?.totalImages) || 0;
  const indexed = Number(payload?.indexed) || 0;
  const found = Array.isArray(payload?.results) ? payload.results.length : 0;
  const parts = [`资源库 ${total} 张图片`];
  if (indexed && indexed !== total) parts.push(`已建指纹 ${indexed}`);
  parts.push(found ? `找到 ${found} 个相似结果` : '没有找到相似图片');
  return parts.join(' · ');
}
