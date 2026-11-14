/**
 * 感知哈希单测
 * ------------
 * 判据：
 *  - 同一张图（含重新编码 / 缩放 / 加透明边）应几乎一致；
 *  - 完全不同的构图应明显更远；
 *  - 汉明距离与相似度换算正确、非法输入返回 null。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  HASH_BITS,
  NEAR_DUPLICATE_DISTANCE,
  SIGNATURE_VERSION,
  computeDHash,
  computeSignature,
  hammingDistance,
  isValidHash,
  isValidSignature,
  similarityScore,
  signatureSimilarity,
} from '../src/phash.js';

async function gradient(width = 240, height = 180) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b2b5e"/><stop offset="1" stop-color="#f7e7b2"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.65}" cy="${height * 0.4}" r="${Math.min(width, height) * 0.2}" fill="#ffffff"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function checker(width = 240, height = 180) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#111"/>
    ${Array.from({ length: 6 }, (_, i) => `<rect x="${i * 40}" y="${i * 30}" width="30" height="30" fill="#eee"/>`).join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test('同图两次哈希一致，且是 16 位十六进制', async () => {
  const buffer = await gradient();
  const a = await computeDHash(sharp, buffer);
  const b = await computeDHash(sharp, buffer);
  assert.equal(a.hash, b.hash);
  assert.ok(isValidHash(a.hash));
  assert.equal(a.hash.length, HASH_BITS / 4);
});

test('缩放 / 重新编码后仍几乎一致（距离 ≤ 阈值）', async () => {
  const original = await gradient(240, 180);
  const scaled = await sharp(original).resize(120, 90).jpeg({ quality: 70 }).toBuffer();
  const a = await computeDHash(sharp, original);
  const b = await computeDHash(sharp, scaled);
  const distance = hammingDistance(a.hash, b.hash);
  assert.ok(distance <= NEAR_DUPLICATE_DISTANCE, `距离 ${distance} 应 ≤ ${NEAR_DUPLICATE_DISTANCE}`);
});

test('透明边不影响指纹（flatten 到黑底）', async () => {
  const base = await gradient(200, 150);
  const padded = await sharp({
    create: { width: 260, height: 210, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: base, left: 30, top: 30 }])
    .png()
    .toBuffer();
  const a = await computeDHash(sharp, base);
  const b = await computeDHash(sharp, padded);
  assert.ok(hammingDistance(a.hash, b.hash) <= NEAR_DUPLICATE_DISTANCE);
});

test('构图不同的图距离明显更大', async () => {
  const a = await computeDHash(sharp, await gradient());
  const b = await computeDHash(sharp, await checker());
  assert.ok(hammingDistance(a.hash, b.hash) > NEAR_DUPLICATE_DISTANCE);
});

test('汉明距离/相似度换算', () => {
  const zero = '0000000000000000';
  const ones = 'ffffffffffffffff';
  assert.equal(hammingDistance(zero, zero), 0);
  assert.equal(hammingDistance(zero, ones), 64);
  assert.equal(hammingDistance('0000000000000001', zero), 1);
  assert.equal(hammingDistance('zzzz', zero), null);
  assert.equal(hammingDistance(null, zero), null);
  assert.equal(similarityScore(zero, zero), 1);
  assert.equal(similarityScore(zero, ones), 0);
  assert.equal(similarityScore(zero, 'nope'), null);
  assert.equal(isValidHash('ABCDEF0123456789'), true);
});

// ---------------------------------------------------------------- 综合指纹（结构 + 颜色）

async function shape(color, { width = 240, height = 180, shape = 'circle' } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#0a0a0c"/>
    ${
      shape === 'circle'
        ? `<circle cx="${width * 0.5}" cy="${height * 0.5}" r="${Math.min(width, height) * 0.3}" fill="${color}"/>`
        : `<rect x="${width * 0.2}" y="${height * 0.2}" width="${width * 0.6}" height="${height * 0.6}" fill="${color}"/>`
    }
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test('综合指纹：同图完全一致（score = 1，分项全 1）', async () => {
  const buffer = await gradient();
  const signature = await computeSignature(sharp, buffer);
  assert.equal(isValidSignature(signature), true);
  assert.equal(signature.chroma.length, 64);
  assert.equal(signature.luma.length, 8);
  const similarity = signatureSimilarity(signature, signature);
  assert.equal(similarity.score, 1);
  assert.equal(similarity.structure, 1);
  assert.equal(similarity.color, 1);
  assert.equal(similarity.distance, 0);
  assert.ok(SIGNATURE_VERSION >= 2); // 索引格式版本（v2 起带颜色）
});

test('综合指纹：缩放 + 重新编码后仍高度相似', async () => {
  const original = await gradient(320, 240);
  const scaled = await sharp(original).resize(160, 120).jpeg({ quality: 72 }).toBuffer();
  const a = await computeSignature(sharp, original);
  const b = await computeSignature(sharp, scaled);
  const similarity = signatureSimilarity(a, b);
  assert.ok(similarity.score >= 0.85, `score ${similarity.score} 应 ≥ 0.85`);
  assert.ok(similarity.structure >= 0.8);
});

test('综合指纹：形状相同但颜色不同 → 结构相近、颜色低、综合分被拉低', async () => {
  const red = await shape('#e11d48');
  const blue = await shape('#2563eb');
  const a = await computeSignature(sharp, red);
  const b = await computeSignature(sharp, blue);
  const similarity = signatureSimilarity(a, b);
  assert.ok(similarity.structure >= 0.6, `结构 ${similarity.structure} 应相近`);
  assert.ok(similarity.color < 0.5, `颜色 ${similarity.color} 应明显不同`);
  assert.ok(similarity.score < 0.75, `综合 ${similarity.score} 应被颜色拉低`);
});

test('综合指纹：颜色接近但构图不同 → 综合分同样不高', async () => {
  const circle = await shape('#2f9e44');
  const checkerImage = await checker();
  const a = await computeSignature(sharp, circle);
  const b = await computeSignature(sharp, checkerImage);
  const similarity = signatureSimilarity(a, b);
  assert.ok(similarity.score < 0.8, `综合 ${similarity.score} 不应判为相似`);
});

test('isValidSignature：旧版只有 hash 的条目判为过期', () => {
  const hashOnly = { hash: '0101000108084c8a' };
  assert.equal(isValidHash(hashOnly.hash), true);
  assert.equal(isValidSignature(hashOnly), false);
  assert.equal(isValidSignature(null), false);
  assert.equal(isValidSignature({ hash: 'zz' }), false);
});
