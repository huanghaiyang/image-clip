/**
 * 资源路径变更广播
 * -----------------
 * 改名 / 移动完成后，useLibrary 会把成功的结果整理成 `{ from, to }` 映射广播出去，
 * 视频 / 音频工作区据此同步正在打开的文件，避免继续指向旧路径。
 *
 * 单独放在 lib 里，是为了让 useLibrary 不必反向 import 两个工作区（那会形成循环依赖）。
 */
const listeners = new Set();

/** 订阅路径变更；返回取消订阅函数。 */
export function onLibraryPathsMoved(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyLibraryPathsMoved(moves) {
  const list = (moves ?? []).filter((move) => move?.from && move?.to && move.from !== move.to);
  if (!list.length) return;
  for (const listener of [...listeners]) listener(list);
}

/**
 * 按映射把旧路径换成新路径。
 * 直接按「源路径」找到对应结果，而不是逐条串行改写：
 * 文件互换（a ↔ b）时，原 a 上的选中项 / 当前文件应该落到新路径 b。
 * 文件夹改名 / 移动会带上整棵子树（取最长的前缀匹配）。
 */
export function remapLibraryPath(path, moves) {
  if (!path) return path;
  let best = null;
  for (const move of moves ?? []) {
    if (!move?.from || !move?.to || move.from === move.to) continue;
    if (path === move.from) return move.to;
    if (path.startsWith(`${move.from}/`) && (!best || move.from.length > best.from.length)) best = move;
  }
  if (!best) return path;
  return `${best.to}/${path.slice(best.from.length + 1)}`;
}

/** 从服务端改名/移动结果里提取成功项的路径映射。 */
export function movesFromResults(results) {
  return (results ?? [])
    .filter((item) => item?.ok && item.from && item.to && item.from !== item.to)
    .map((item) => ({ from: item.from, to: item.to }));
}
