/**
 * 极简 ZIP 打包（仅 store 模式，不压缩）。
 *
 * 图片本身已经是压缩格式，再套一层 deflate 收益极小，
 * 因此这里手写 ZIP 结构，避免为了批量导出引入额外依赖。
 * 支持 UTF-8 文件名（通用标志位 bit 11），中文名不会乱码。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * @param {{name: string, data: Uint8Array|ArrayBuffer}[]} entries
 * @returns {Blob} application/zip
 */
export function createZip(entries, { date = new Date() } = {}) {
  const encoder = new TextEncoder();
  const { time, date: dosDate } = toDosDateTime(date);

  const prepared = entries.map((entry) => {
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    return { nameBytes: encoder.encode(entry.name), data, crc: crc32(data) };
  });

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const buffer = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  const central = [];

  for (const entry of prepared) {
    const localHeaderOffset = offset;
    view.setUint32(offset, 0x04034b50, true); // 本地文件头签名
    view.setUint16(offset + 4, 20, true); // 需要的版本 2.0
    view.setUint16(offset + 6, 0x0800, true); // 通用标志：UTF-8 文件名
    view.setUint16(offset + 8, 0, true); // 压缩方法 0 = store
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, dosDate, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true); // 压缩后大小
    view.setUint32(offset + 22, entry.data.length, true); // 原始大小
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // 扩展字段长度
    offset += 30;
    buffer.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    buffer.set(entry.data, offset);
    offset += entry.data.length;

    central.push({ ...entry, localHeaderOffset });
  }

  const centralStart = offset;
  for (const entry of central) {
    view.setUint32(offset, 0x02014b50, true); // 中央目录签名
    view.setUint16(offset + 4, 20, true); // 生成版本
    view.setUint16(offset + 6, 20, true); // 需要版本
    view.setUint16(offset + 8, 0x0800, true); // UTF-8 文件名
    view.setUint16(offset + 10, 0, true); // store
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, dosDate, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // 扩展字段
    view.setUint16(offset + 32, 0, true); // 注释
    view.setUint16(offset + 34, 0, true); // 磁盘号
    view.setUint16(offset + 36, 0, true); // 内部属性
    view.setUint32(offset + 38, 0, true); // 外部属性
    view.setUint32(offset + 42, entry.localHeaderOffset, true);
    offset += 46;
    buffer.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  view.setUint32(offset, 0x06054b50, true); // 中央目录结束记录
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);

  return new Blob([buffer], { type: 'application/zip' });
}

/** Blob → Uint8Array（ZIP 打包前用）。 */
export async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
