/**
 * 图集排版与元数据导出单元测试。
 */
import {
  buildAtlasBundle,
  nineSliceMeta,
  nextPowerOfTwo,
  planSheet,
  toCocosPlist,
  toPhaserJson,
  toTexturePackerArray,
  toTexturePackerHash,
} from './meta.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

test('2 的幂对齐', () => {
  assert(nextPowerOfTwo(3) === 4 && nextPowerOfTwo(300) === 512 && nextPowerOfTwo(1) === 1, '对齐错误');
});

test('默认列数为平方根向上取整', () => {
  const plan = planSheet([{ width: 32, height: 32 }, { width: 32, height: 32 }, { width: 32, height: 32 }, { width: 32, height: 32 }]);
  assert(plan.columns === 2 && plan.rows === 2, `应为 2×2，实际 ${plan.columns}×${plan.rows}`);
  assert(plan.width === 64 && plan.height === 64, `尺寸应为 64×64，实际 ${plan.width}×${plan.height}`);
});

test('间距与外边距计入总尺寸', () => {
  const plan = planSheet(
    [{ width: 10, height: 10 }, { width: 10, height: 10 }, { width: 10, height: 10 }, { width: 10, height: 10 }],
    { columns: 2, gap: 4, padding: 2 },
  );
  assert(plan.width === 2 + 10 * 2 + 4 + 2, `宽度计算错误：${plan.width}`);
  assert(plan.placements[3].x === 2 + 10 + 4, `第四帧 x 错误：${plan.placements[3].x}`);
});

test('extrude 会为每帧留出边缘空间', () => {
  const plan = planSheet([{ width: 8, height: 8 }], { columns: 1, padding: 0, extrude: 2 });
  assert(plan.cell.width === 12, `单元格应 12，实际 ${plan.cell.width}`);
  assert(plan.placements[0].x === 2, `外扩后居左偏移应为 2，实际 ${plan.placements[0].x}`);
});

test('2 的幂会放大总尺寸', () => {
  const plan = planSheet([{ width: 30, height: 30 }], { columns: 1, pow2: true });
  assert(plan.width === 32 && plan.height === 32, `应为 32×32，实际 ${plan.width}×${plan.height}`);
});

test('超上限要报错', () => {
  let threw = false;
  try {
    planSheet([{ width: 9000, height: 9000 }], { columns: 1, maxSize: 8192 });
  } catch {
    threw = true;
  }
  assert(threw, '超过 maxSize 应抛错');
});

test('TexturePacker hash 结构', () => {
  const frames = [
    {
      name: 'walk_01',
      width: 20,
      height: 30,
      trimmed: true,
      trimX: 2,
      trimY: 3,
      sourceWidth: 24,
      sourceHeight: 34,
      placement: { name: 'walk_01', x: 4, y: 5, width: 20, height: 30 },
    },
  ];
  const json = toTexturePackerHash({ image: 'hero.png', width: 40, height: 50, frames, scale: 1 });
  const entry = json.frames.walk_01;
  assert(entry.frame.x === 4 && entry.frame.w === 20, 'frame 矩形');
  assert(entry.spriteSourceSize.x === 2 && entry.sourceSize.w === 24, 'trim 信息');
  assert(entry.trimmed === true && entry.rotated === false, 'trim/rotated 标记');
  assert(json.meta.image === 'hero.png' && json.meta.size.w === 40, 'meta');
});

test('array 与 Phaser 形式', () => {
  const frames = [{ name: 'a', width: 10, height: 10, placement: { name: 'a', x: 0, y: 0, width: 10, height: 10 } }];
  const array = toTexturePackerArray({ image: 'a.png', width: 10, height: 10, frames });
  assert(Array.isArray(array.frames) && array.frames[0].filename === 'a', 'array frames');
  const phaser = toPhaserJson({ image: 'a.png', width: 10, height: 10, frames });
  assert(phaser.meta.app === 'Phaser', 'Phaser app 标识');
});

test('Cocos plist 转义与结构', () => {
  const frames = [{ name: 'a&b', width: 10, height: 10, placement: { name: 'a&b', x: 1, y: 2, width: 10, height: 10 } }];
  const plist = toCocosPlist({ image: 'a.png', width: 10, height: 10, frames });
  assert(plist.includes('<key>a&amp;b</key>'), '需要 XML 转义');
  assert(plist.includes('{{1,2},{10,10}}'), 'frame 字符串');
  assert(plist.includes('<key>format</key>'), 'metadata format');
});

test('九宫格与 bundle', () => {
  const nine = nineSliceMeta({ left: 4, right: 4, top: 2, bottom: 2, width: 32, height: 32 });
  assert(nine.border.left === 4 && nine.size.w === 32, '九宫格结构');
  const bundle = buildAtlasBundle({
    image: 'a.png',
    width: 10,
    height: 10,
    frames: [{ name: 'a', width: 10, height: 10, placement: { name: 'a', x: 0, y: 0, width: 10, height: 10 } }],
    nineSlice: nine,
  });
  assert(typeof bundle.jsonHash === 'string' && bundle.jsonHash.includes('"frames"'), 'jsonHash 文本');
  assert(bundle.plist.startsWith('<?xml'), 'plist 文本');
});

console.log(`\natlas-meta: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
