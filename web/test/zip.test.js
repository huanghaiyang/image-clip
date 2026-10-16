/**
 * ZIP 打包单测：手工写的 ZIP 结构必须能被标准工具正确解析。
 *
 * 这里不依赖任何第三方库：
 *  - CRC 用 node:zlib 的 crc32 独立算一遍做对照；
 *  - 结构直接按 ZIP 规范逐字段解析（本地文件头 / 中央目录 / EOCD）。
 * 另外由 scripts 外的真实解压（PowerShell Expand-Archive）做过一次端到端验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

import { createZip } from '../src/lib/zip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/** 解析 ZIP 的中央目录与本地文件头，返回结构化视图。 */
function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD 位于末尾，签名 0x06054b50（此处无注释，固定 22 字节）
  const eocdOffset = bytes.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50, 'EOCD 签名');
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  assert.equal(eocdOffset, centralOffset + centralSize, '中央目录应与 EOCD 相邻');

  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, `第 ${i} 个中央目录签名`);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    // 本地文件头
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, '本地文件头签名');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      flags,
      method,
      crc,
      size,
      data: bytes.subarray(dataStart, dataStart + size),
    });
    cursor += 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return { entryCount, entries, centralOffset, centralSize };
}

test('createZip 生成的结构可被规范解析，内容与 CRC 均正确', async () => {
  const payloadA = encoder.encode('hello image-clip');
  const payloadB = new Uint8Array(300).map((_, i) => i % 251);

  const blob = await createZip([
    { name: '蝴蝶-01-cropped.png', data: payloadA },
    { name: 'plain.bin', data: payloadB },
  ]);
  assert.equal(blob.type, 'application/zip');

  const bytes = await bytesOf(blob);
  const zip = parseZip(bytes);

  assert.equal(zip.entryCount, 2);
  assert.equal(zip.entries[0].name, '蝴蝶-01-cropped.png', '中文文件名按 UTF-8 还原');
  assert.equal(zip.entries[1].name, 'plain.bin');

  for (const entry of zip.entries) {
    assert.equal(entry.method, 0, 'store 模式（不压缩）');
    assert.equal(entry.flags & 0x0800, 0x0800, '通用标志位必须置 UTF-8 位');
    const expected = entry.name === 'plain.bin' ? payloadB : payloadA;
    assert.equal(entry.size, expected.length);
    assert.equal(entry.crc, crc32(Buffer.from(expected)) >>> 0, 'CRC32 与 node:zlib 一致');
    assert.deepEqual([...entry.data], [...expected], '解出的数据与原数据逐字节相同');
  }
});

test('空清单也能生成合法的空 ZIP', async () => {
  const bytes = await bytesOf(await createZip([]));
  assert.equal(bytes.length, 22);
  const zip = parseZip(bytes);
  assert.equal(zip.entryCount, 0);
});

test('相同内容的 ZIP 只受时间戳影响（字节结构稳定）', async () => {
  const date = new Date('2026-01-02T03:04:06Z');
  const entry = [{ name: 'a.txt', data: encoder.encode('x') }];
  const a = await bytesOf(await createZip(entry, { date }));
  const b = await bytesOf(await createZip(entry, { date }));
  assert.deepEqual(a, b, '同一时间戳下输出完全一致');
});
