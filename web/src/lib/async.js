/**
 * 轻量并发工具。
 *
 * 图片导入是「CPU + 内存」双密集（createImageBitmap + getImageData 各占一份全尺寸像素），
 * 完全串行时导入 6 张就要排队等 6 次解码；但也不能无上限并发，大图很容易把内存打满。
 * 统一用 mapLimit 控制并发：既能压满多核解码，又把峰值控制在可预期的范围内。
 */

/**
 * 按并发上限依次执行 mapper，返回与输入顺序一致的结果数组。
 * 任何一项抛错都会让整个调用 reject（和 Promise.all 一致）；需要「跳过失败项」时在 mapper 内自行 catch。
 *
 * @template T, R
 * @param {ReadonlyArray<T>} items
 * @param {number} limit 并发上限（≥1）
 * @param {(item: T, index: number) => Promise<R> | R} mapper
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, mapper) {
  const list = [...(items ?? [])];
  if (!list.length) return [];
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await mapper(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
