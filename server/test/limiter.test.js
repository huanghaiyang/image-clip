/**
 * 并发限流：最多 N 个同时处理，排队满时返回 503，释放后自动放行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createLimiter } from '../src/limiter.js';

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = null;
  res.set = (key, value) => {
    res.headers[key] = value;
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    end(res);
    return res;
  };
  return res;
}

function end(res) {
  res.emit('finish');
}

test('并发槽位：超出的请求排队，队列满返回 503', () => {
  const limiter = createLimiter({ name: 'test', concurrency: 1, queueLimit: 1 });
  const mw = limiter.middleware();
  const res1 = fakeRes();
  const res2 = fakeRes();
  const res3 = fakeRes();
  let started = 0;

  mw({ path: '/a' }, res1, () => {
    started += 1;
  });
  mw({ path: '/b' }, res2, () => {
    started += 1;
  });
  mw({ path: '/c' }, res3, () => {
    started += 1;
  });

  assert.equal(started, 1, '只放行第一个');
  assert.equal(limiter.stats().queued, 1);

  // 队列满 → 第三个直接 503
  assert.equal(res3.statusCode, 503);
  assert.equal(res3.body.error.code, 'BUSY');
  assert.equal(limiter.stats().rejected, 1);

  // 释放第一个 → 第二个被放行
  end(res1);
  assert.equal(started, 2);
  assert.equal(limiter.stats().active, 1);
  end(res2);
  assert.equal(limiter.stats().active, 0);
});

test('手动 acquire / release 与统计', async () => {
  const limiter = createLimiter({ name: 'manual', concurrency: 2, queueLimit: 5 });
  const release1 = await limiter.acquire();
  const release2 = await limiter.acquire();
  assert.equal(limiter.stats().active, 2);
  const pending = limiter.acquire();
  assert.equal(limiter.stats().queued, 1);
  release1();
  const release3 = await pending;
  assert.equal(limiter.stats().queued, 0);
  release3();
  release2();
  assert.equal(limiter.stats().active, 0);
});
