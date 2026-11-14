/**
 * 并发工具单测（web/src/lib/async.js）
 * --------------------------------
 * 导入图片/恢复会话都靠 mapLimit 控制「解码并发」：
 *  - 结果顺序必须与输入一致（素材列表顺序、libraryPaths 对应关系都依赖它）；
 *  - 任何时刻并发数不超过上限（大图解码不能无节制并行，否则内存峰值失控）；
 *  - 单项抛错向调用方冒泡（由调用方决定是否跳过）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapLimit } from '../src/lib/async.js';

test('结果顺序与输入一致（即使后面的任务先完成）', async () => {
  const delays = [40, 5, 25, 1];
  const result = await mapLimit([0, 1, 2, 3], 2, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, delays[item]));
    return item * 10;
  });
  assert.deepEqual(result, [0, 10, 20, 30]);
});

test('并发不超过上限', async () => {
  let running = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return true;
  });
  assert.equal(peak, 3);
});

test('空列表直接返回空数组；limit 非法时收敛为 1', async () => {
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
  const seen = [];
  const result = await mapLimit([1, 2], 0, async (item) => {
    seen.push(item);
    return item;
  });
  assert.deepEqual(result, [1, 2]);
  assert.deepEqual(seen, [1, 2]);
});

test('单项抛错会让整体 reject（跳过失败项由调用方在 mapper 里 catch）', async () => {
  await assert.rejects(
    () => mapLimit([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom');
      return item;
    }),
    /boom/,
  );
});
