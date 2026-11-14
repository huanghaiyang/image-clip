/**
 * 精灵图（Sprite Sheet）切分
 * --------------------------
 * 两种切法共用同一份帧数据结构：{ x, y, width, height }。
 *
 *  - 自动分隔：alpha > 0 的像素视为内容，整列 / 整行完全没有内容的位置就是
 *    帧与帧之间的透明分隔线。把连续的“有内容列”和“有内容行”各自合并成带，
 *    再取交叉矩形得到每一帧。导出时留了帧间距的 sprite 图可以直接切开。
 *  - 网格切分：按列数 × 行数等分，适合帧紧贴、没有透明分隔线的素材。
 */

const MAX_GRID = 128;

function collectBands(flags) {
  const bands = [];
  let start = -1;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      bands.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) bands.push({ start, end: flags.length - 1 });
  return bands;
}

/**
 * 自动检测透明分隔线并切帧。
 * 返回 { columns, rows, frames }；缓冲区不合法时返回 null。
 * 完全没有内容（或数据不足）时返回 0 帧。
 */
export function detectSpriteGrid(rgba, width, height, options = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const count = w * h;
  if (!rgba || rgba.length < count * 4) return null;

  const threshold = Math.max(0, Math.min(255, Math.floor(Number(options.alphaThreshold) || 0)));
  const colHas = new Uint8Array(w);
  const rowHas = new Uint8Array(h);
  for (let y = 0; y < h; y += 1) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x += 1) {
      if (rgba[(rowOffset + x) * 4 + 3] > threshold) {
        colHas[x] = 1;
        rowHas[y] = 1;
      }
    }
  }

  const colBands = collectBands(colHas);
  const rowBands = collectBands(rowHas);

  const frames = [];
  for (const row of rowBands) {
    for (const col of colBands) {
      frames.push({
        x: col.start,
        y: row.start,
        width: col.end - col.start + 1,
        height: row.end - row.start + 1,
      });
    }
  }

  return { columns: colBands.length, rows: rowBands.length, frames, colBands, rowBands };
}

/** 按列数 × 行数等分切帧（边界四舍五入，保证覆盖整张图）。 */
export function buildGridFrames(width, height, columns, rows) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const cols = Math.max(1, Math.min(MAX_GRID, Math.floor(Number(columns) || 1)));
  const rowCount = Math.max(1, Math.min(MAX_GRID, Math.floor(Number(rows) || 1)));

  const xs = Array.from({ length: cols + 1 }, (_, i) => Math.round((i * w) / cols));
  const ys = Array.from({ length: rowCount + 1 }, (_, i) => Math.round((i * h) / rowCount));

  const frames = [];
  for (let r = 0; r < rowCount; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = xs[c];
      const y = ys[r];
      const fw = xs[c + 1] - x;
      const fh = ys[r + 1] - y;
      if (fw > 0 && fh > 0) frames.push({ x, y, width: fw, height: fh });
    }
  }
  return frames;
}

export const SPRITE_MAX_GRID = MAX_GRID;

/**
 * 多图合并为精灵图的布局
 * ----------------------
 * 合并时每张图的尺寸可能不同（白底帧、留白不同、分辨率混合都很常见）。
 * 规则：单元格 = 各帧最大宽/高；每帧等比缩放后居中放进自己的单元格（不拉伸，空白透明）。
 * 导出与面板预览共用这个纯函数，保证看到的排版就是导出的排版。
 *
 * @param {{sizes: Array<{width:number,height:number}>, columns?: number, gap?: number}} options
 * @returns {{count:number, cell:{width:number,height:number}, cols:number, rows:number, spacing:number, width:number, height:number}|null}
 */
export function planSpriteSheet({ sizes = [], columns = 0, gap = 0 } = {}) {
  const list = (sizes ?? []).filter((size) => Number(size?.width) > 0 && Number(size?.height) > 0);
  const count = list.length;
  if (!count) return null;

  const cell = {
    width: Math.max(...list.map((size) => Math.round(Number(size.width)))),
    height: Math.max(...list.map((size) => Math.round(Number(size.height)))),
  };
  const auto = Math.ceil(Math.sqrt(count));
  const requested = Math.round(Number(columns) || 0);
  const cols = Math.max(1, Math.min(count, requested > 0 ? requested : auto));
  const rows = Math.ceil(count / cols);
  const spacing = Math.max(0, Math.round(Number(gap) || 0));
  return {
    count,
    cell,
    cols,
    rows,
    spacing,
    width: cols * cell.width + (cols - 1) * spacing,
    height: rows * cell.height + (rows - 1) * spacing,
  };
}

/** 第 index 帧所在单元格的左上角坐标（像素）。 */
export function spriteCellOrigin(plan, index) {
  const cols = Math.max(1, plan?.cols ?? 1);
  const cellWidth = Math.max(1, plan?.cell?.width ?? 1);
  const cellHeight = Math.max(1, plan?.cell?.height ?? 1);
  const spacing = Math.max(0, plan?.spacing ?? 0);
  return {
    x: (index % cols) * (cellWidth + spacing),
    y: Math.floor(index / cols) * (cellHeight + spacing),
  };
}
