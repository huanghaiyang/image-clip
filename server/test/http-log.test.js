/**
 * HTTP 访问日志 / 错误日志 / 浏览器错误上报清洗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createAccessLogger, logHttpError, sanitizeClientEvent } from '../src/httpLog.js';

function fakeLogger() {
  const calls = [];
  return {
    calls,
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
    debug: (...args) => calls.push(['debug', ...args]),
  };
}

async function withServer(handler) {
  const app = express();
  handler(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('访问日志：记录方法/路径/状态/耗时/请求 ID，响应头带 X-Request-Id', async () => {
  const logger = fakeLogger();
  const app = express();
  app.use(createAccessLogger({ logger }));
  app.get('/api/ok', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ok?x=1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-request-id'), /^req-/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const line = logger.calls.find((call) => call[0] === 'info');
    assert.ok(line, '应写一条 info 访问日志');
    assert.equal(line[1], 'http');
    assert.match(line[2], /GET \/api\/ok 200/);
    assert.equal(line[3].status, 200);
    assert.ok(line[3].ms >= 0);
    assert.equal(line[3].method, 'GET');
    assert.equal(line[3].path, '/api/ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('错误日志：5xx 带堆栈；4xx 记 warn', async () => {
  const logger = fakeLogger();
  const app = express();
  app.use(createAccessLogger({ logger }));
  app.get('/api/boom', () => {
    throw Object.assign(new Error('炸了'), { status: 500 });
  });
  app.use((err, req, res, _next) => {
    const status = err.status ?? 500;
    res.locals.errorInfo = { code: 'INTERNAL_ERROR', message: err.message };
    logHttpError(logger, err, req, { status, code: 'INTERNAL_ERROR', message: err.message });
    res.status(status).json({ error: { message: err.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const fail = await fetch(`${base}/api/boom`);
    assert.equal(fail.status, 500);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const errorLine = logger.calls.find((call) => call[0] === 'error' && call[1] === 'http');
    assert.ok(errorLine);
    assert.equal(errorLine[3].status, 500);
    assert.match(errorLine[3].stack, /炸了/);

    const missing = await fetch(`${base}/api/missing`);
    assert.equal(missing.status, 404);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const warnLine = logger.calls.find((call) => call[0] === 'warn' && call[2]?.includes('/api/missing'));
    assert.ok(warnLine);
    assert.equal(warnLine[3].status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('浏览器错误清洗：截断超长内容、只接受合法级别', () => {
  const event = sanitizeClientEvent({
    level: 'verbose',
    message: 'x'.repeat(1000),
    stack: 's'.repeat(9000),
    url: 'u'.repeat(900),
    line: 12,
    column: 3,
    kind: 'window-error',
  });
  assert.ok(event);
  assert.equal(event.level, 'error');
  assert.equal(event.message.length, 600);
  assert.equal(event.stack.length, 6000);
  assert.equal(event.line, 12);
  assert.equal(sanitizeClientEvent({}), null);
});
