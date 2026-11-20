/**
 * 图集打包与元数据导出 —— 纯算法，浏览器与 Node 共用
 * ---------------------------------------------------
 * 现有的 sprite 合并只输出 PNG，引擎拿不到「每帧在整张图的哪个矩形」，
 * 也没有 padding / extrude / trim，实际导入 Unity / Cocos / Phaser 会漏边、错位。
 *
 * 这里把三件事补齐：
 *  1. 排版：固定网格 + 间距 + 外边距 + 2 的幂对齐 + 外扩（extrude）；
 *  2. 元数据：TexturePacker JSON（hash / array）、Cocos plist、Phaser JSON；
 *  3. 九宫格：给 UI 切图用的 border 数据。
 *
 * 全部是纯函数，不碰 canvas，测试直接用假尺寸跑。
 */

export function nextPowerOfTwo(value) {
  let n = Math.max(1, Math.round(Number(value) || 1));
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * 计算图集排版。
 * @param {{width:number,height:number,name?:string}[]} frames 每一帧的实际像素尺寸
 * @param {{columns?:number,gap?:number,padding?:number,extrude?:number,pow2?:boolean,maxSize?:number}} options
 * @returns {{width:number,height:number,columns:number,rows:number,cell:{width:number,height:number},
 *           placements:{name:string,x:number,y:number,width:number,height:number,index:number}[], trimmed:boolean}}
 */
export function planSheet(frames, { columns = 0, gap = 0, padding = 0, extrude = 0, pow2 = false, maxSize = 8192 } = {}) {
  const list = (frames ?? []).map((frame, index) => ({
    name: frame.name || `frame-${String(index).padStart(4, '0')}`,
    width: Math.max(1, Math.round(frame.width)),
    height: Math.max(1, Math.round(frame.height)),
  }));
  if (!list.length) {
    return { width: 1, height: 1, columns: 0, rows: 0, cell: { width: 1, height: 1 }, placements: [], trimmed: true };
  }

  const cell = {
    width: Math.max(...list.map((f) => f.width)) + extrude * 2,
    height: Math.max(...list.map((f) => f.height)) + extrude * 2,
  };
  const cols = Math.max(1, Math.min(list.length, Math.round(Number(columns) || Math.ceil(Math.sqrt(list.length)))));
  const rows = Math.ceil(list.length / cols);
  const g = Math.max(0, Math.round(Number(gap) || 0));
  const pad = Math.max(0, Math.round(Number(padding) || 0));

  let width = pad * 2 + cols * cell.width + (cols - 1) * g;
  let height = pad * 2 + rows * cell.height + (rows - 1) * g;
  if (pow2) {
    width = nextPowerOfTwo(width);
    height = nextPowerOfTwo(height);
  }
  if (maxSize && (width > maxSize || height > maxSize)) {
    throw new Error(`图集尺寸 ${width}×${height} 超过上限 ${maxSize}，请减少帧数或分页`);
  }

  const placements = list.map((frame, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    // 每帧在自己的格子里居中：尺寸不同的帧不会贴左上角导致播放跳动
    const x = pad + col * (cell.width + g) + Math.round((cell.width - frame.width) / 2);
    const y = pad + row * (cell.height + g) + Math.round((cell.height - frame.height) / 2);
    return { name: frame.name, x, y, width: frame.width, height: frame.height, index };
  });

  return { width, height, columns: cols, rows, cell, placements, trimmed: true };
}

/** 把一帧的 trim 信息换算成 TexturePacker 需要的 spriteSourceSize。 */
export function sourceRect(frame, placement) {
  const sourceW = frame.sourceWidth ?? placement.width;
  const sourceH = frame.sourceHeight ?? placement.height;
  return {
    x: frame.trimX ?? 0,
    y: frame.trimY ?? 0,
    w: placement.width,
    h: placement.height,
    sourceW,
    sourceH,
  };
}

function frameEntry(frame, placement, index) {
  return {
    filename: placement.name,
    frame: { x: placement.x, y: placement.y, w: placement.width, h: placement.height },
    rotated: false,
    trimmed: Boolean(frame.trimmed),
    spriteSourceSize: { x: frame.trimX ?? 0, y: frame.trimY ?? 0, w: placement.width, h: placement.height },
    sourceSize: { w: frame.sourceWidth ?? placement.width, h: frame.sourceHeight ?? placement.height },
    index,
  };
}

/**
 * TexturePacker JSON（hash 形式，Unity / Godot / PixiJS 都能吃）。
 * @param {{image:string,width:number,height:number,frames:object[],scale?:number,nineSlice?:object}} options
 */
export function toTexturePackerHash({ image, width, height, frames, scale = 1, nineSlice = null, app = 'image-clip', version = '1.0' }) {
  const out = {};
  (frames ?? []).forEach((frame, index) => {
    const placement = frame.placement ?? frame;
    const entry = frameEntry(frame, placement, index);
    out[placement.name] = {
      frame: entry.frame,
      rotated: entry.rotated,
      trimmed: entry.trimmed,
      spriteSourceSize: entry.spriteSourceSize,
      sourceSize: entry.sourceSize,
    };
  });
  const meta = {
    app,
    version,
    image,
    format: 'RGBA8888',
    size: { w: width, h: height },
    scale: String(scale),
  };
  if (nineSlice) meta.nineSlice = nineSlice;
  return { frames: out, meta };
}

/** TexturePacker JSON（array 形式，Cocos Creator 3.x / Phaser 常用）。 */
export function toTexturePackerArray({ image, width, height, frames, scale = 1, nineSlice = null, app = 'image-clip', version = '1.0' }) {
  const list = (frames ?? []).map((frame, index) => frameEntry(frame, frame.placement ?? frame, index));
  const meta = {
    app,
    version,
    image,
    format: 'RGBA8888',
    size: { w: width, h: height },
    scale: String(scale),
  };
  if (nineSlice) meta.nineSlice = nineSlice;
  return { frames: list, meta };
}

/** Phaser 3 的 JSON 图集：字段与 array 形式一致，只换 app 标识。 */
export function toPhaserJson(options) {
  return toTexturePackerArray({ ...options, app: 'Phaser', version: '3.60' });
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Cocos（SpriteFrame）plist。Cocos Creator 2.x 直接可导入。 */
export function toCocosPlist({ image, width, height, frames, scale = 1 }) {
  const entries = (frames ?? [])
    .map((frame, index) => {
      const placement = frame.placement ?? frame;
      const w = placement.width ?? placement.w;
      const h = placement.height ?? placement.h;
      const sourceW = frame.sourceWidth ?? w;
      const sourceH = frame.sourceHeight ?? h;
      return `    <key>${xmlEscape(placement.name)}</key>
    <dict>
      <key>frame</key>
      <string>{{${placement.x},${placement.y}},{${w},${h}}}</string>
      <key>offset</key>
      <string>{0,0}</string>
      <key>rotated</key>
      <false/>
      <key>sourceColorRect</key>
      <string>{{${frame.trimX ?? 0},${frame.trimY ?? 0}},{${w},${h}}}</string>
      <key>sourceSize</key>
      <string>{${sourceW},${sourceH}}</string>
      <key>index</key>
      <integer>${index}</integer>
    </dict>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>frames</key>
  <dict>
${entries}
  </dict>
  <key>metadata</key>
  <dict>
    <key>format</key>
    <integer>2</integer>
    <key>size</key>
    <string>{${width},${height}}</string>
    <key>textureFileName</key>
    <string>${xmlEscape(image)}</string>
    <key>scale</key>
    <string>${scale}</string>
  </dict>
</dict>
</plist>
`;
}

/** 九宫格（UI 切图）元数据：四条边不可拉伸的像素宽度。 */
export function nineSliceMeta({ left = 8, right = 8, top = 8, bottom = 8, width, height }) {
  return {
    border: {
      left: Math.max(0, Math.round(left)),
      right: Math.max(0, Math.round(right)),
      top: Math.max(0, Math.round(top)),
      bottom: Math.max(0, Math.round(bottom)),
    },
    size: { w: width, h: height },
    hint: '在引擎里做九宫格拉伸时，四角保持原像素，四边与中心拉伸',
  };
}

/**
 * 统一导出：一次拿到所有格式的文本，面板里按需下载。
 * 返回 { jsonHash, jsonArray, phaser, plist, nineSlice }
 */
export function buildAtlasBundle({ image, width, height, frames, scale = 1, nineSlice = null }) {
  return {
    jsonHash: JSON.stringify(toTexturePackerHash({ image, width, height, frames, scale, nineSlice }), null, 2),
    jsonArray: JSON.stringify(toTexturePackerArray({ image, width, height, frames, scale, nineSlice }), null, 2),
    phaser: JSON.stringify(toPhaserJson({ image, width, height, frames, scale, nineSlice }), null, 2),
    plist: toCocosPlist({ image, width, height, frames, scale }),
    nineSlice,
  };
}
