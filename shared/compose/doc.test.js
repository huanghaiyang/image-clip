/**
 * 文档模型 / 图层 / 命中测试 / 撤销栈单元测试。
 */
import {
  BLEND_MODES,
  addLayer,
  blendOperation,
  contentBounds,
  createDoc,
  createHistory,
  createLayer,
  duplicateLayer,
  findLayer,
  hitTest,
  layerBounds,
  moveLayer,
  patchLayer,
  removeLayer,
  serializeDoc,
  deserializeDoc,
  toLayerLocal,
} from './doc.js';

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

function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

function makeDoc() {
  const doc = createDoc({ width: 200, height: 100 });
  const bottom = createLayer('image', { name: '底图', width: 100, height: 50 });
  const top = createLayer('image', { name: '上层', width: 40, height: 40 });
  top.transform.x = 120;
  top.transform.y = 30;
  addLayer(doc, bottom);
  addLayer(doc, top);
  return { doc, bottom, top };
}

test('混合模式映射到 canvas 合成操作', () => {
  assert(blendOperation('multiply') === 'multiply', '正片叠底');
  assert(blendOperation('add') === 'lighter', '相加映射 lighter');
  assert(blendOperation('unknown') === 'source-over', '未知回退正常');
  assert(BLEND_MODES.length >= 15, '混合模式数量');
});

test('图层顺序与移动', () => {
  const { doc, bottom, top } = makeDoc();
  assert(doc.layers[0].id === bottom.id && doc.layers[1].id === top.id, '初始顺序');
  moveLayer(doc, bottom.id, 1);
  assert(doc.layers[1].id === bottom.id, '上移后顺序');
  moveLayer(doc, bottom.id, 1);
  assert(doc.layers[1].id === bottom.id, '已在顶部时不应越界');
});

test('删除图层同时清理动画轨道', () => {
  const { doc, top } = makeDoc();
  doc.animation.tracks[top.id] = { x: { property: 'x', keys: [{ t: 0, v: 0, easing: 'linear' }] } };
  removeLayer(doc, top.id);
  assert(doc.layers.length === 1 && !doc.animation.tracks[top.id], '轨道应被清理');
});

test('包围盒：位移 + 缩放 + 旋转', () => {
  const layer = createLayer('image', { width: 100, height: 50 });
  layer.transform.x = 10;
  layer.transform.y = 20;
  const plain = layerBounds(layer);
  assert(near(plain.x, 10) && near(plain.y, 20) && near(plain.width, 100), JSON.stringify(plain));
  layer.transform.scaleX = 2;
  layer.transform.scaleY = 2;
  const scaled = layerBounds(layer);
  assert(near(scaled.width, 200) && near(scaled.height, 100), JSON.stringify(scaled));
  layer.transform.scaleX = 1;
  layer.transform.scaleY = 1;
  layer.transform.rotation = 90;
  const rotated = layerBounds(layer);
  assert(near(rotated.width, 50) && near(rotated.height, 100), JSON.stringify(rotated));
});

test('命中测试从上层往下找', () => {
  const { doc, bottom, top } = makeDoc();
  assert(hitTest(doc, 130, 40).id === top.id, '上层命中');
  assert(hitTest(doc, 10, 10).id === bottom.id, '底图命中');
  assert(hitTest(doc, 190, 90) === null, '空白处不命中');
  top.visible = false;
  assert(hitTest(doc, 50, 20).id === bottom.id, '隐藏的上层要跳过（落到下层）');
});

test('文档坐标 → 图层本地坐标（缩放后）', () => {
  const layer = createLayer('image', { width: 100, height: 100 });
  layer.transform.scaleX = 2;
  layer.transform.scaleY = 2;
  // 缩放围绕中心：文档中心 50 保持不动，文档 100 处对应本地 75
  const local = toLayerLocal(layer, 100, 100);
  assert(near(local.x, 75) && near(local.y, 75), JSON.stringify(local));
  const center = toLayerLocal(layer, 50, 50);
  assert(near(center.x, 50) && near(center.y, 50), JSON.stringify(center));
});

test('patchLayer 合并 transform / text', () => {
  const layer = createLayer('text', { width: 10, height: 10 });
  patchLayer({ layers: [layer] }, layer.id, { transform: { x: 5 }, text: { size: 20 } });
  assert(layer.transform.x === 5 && layer.transform.scaleX === 1, 'transform 浅合并不能丢字段');
  assert(layer.text.size === 20 && layer.text.content === '文字', 'text 浅合并不能丢字段');
});

test('复制图层共享位图与蒙版，但 id / transform 独立', () => {
  const { doc, top } = makeDoc();
  const bitmap = { width: 1, height: 1 };
  top.bitmap = bitmap;
  top.mask = { width: 1, height: 1, data: new Uint8Array([255]) };
  const copy = duplicateLayer(doc, top.id);
  assert(copy.id !== top.id, 'id 必须不同');
  assert(copy.bitmap === bitmap && copy.mask === top.mask, '不可变资源可以共享');
  copy.transform.x = 99;
  assert(top.transform.x === 120, 'transform 不能共享引用');
});

test('撤销 / 重做恢复图层状态', () => {
  const { doc, top } = makeDoc();
  const history = createHistory(doc);
  assert(history.canUndo === false, '初始没有历史');
  history.record('移动');
  top.transform.x = 300;
  history.commit('移动');
  assert(history.canUndo === true, '提交后应可撤销');
  history.undo();
  assert(doc.layers[1].transform.x === 120, `撤销后应回到 120，实际 ${doc.layers[1].transform.x}`);
  history.redo();
  assert(doc.layers[1].transform.x === 300, '重做后恢复新值');
});

test('序列化 / 反序列化保留图层与蒙版', () => {
  const { doc, top } = makeDoc();
  top.mask = { width: 2, height: 1, data: new Uint8Array([0, 255]) };
  const json = JSON.parse(JSON.stringify(serializeDoc(doc)));
  assert(json.layers[1].bitmap === null, '位图不序列化');
  assert(typeof json.layers[1].mask.data === 'string', '蒙版应转 base64');
  const restored = deserializeDoc(json);
  assert(restored.layers.length === 2 && restored.layers[1].mask.data[1] === 255, '蒙版应还原');
  assert(restored.layers[1].mask.data[0] === 0, '蒙版首值');
});

test('内容包围盒取所有可见图层并集', () => {
  const { doc } = makeDoc();
  const box = contentBounds(doc);
  assert(box.x === 0 && box.y === 0, JSON.stringify(box));
  assert(box.width === 160 && box.height === 70, JSON.stringify(box));
});

test('findLayer / 不存在的 id', () => {
  const { doc, top } = makeDoc();
  assert(findLayer(doc, top.id) === top, '应能找到');
  assert(findLayer(doc, 'nope') === null, '找不到返回 null');
});

console.log(`\ndoc: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
