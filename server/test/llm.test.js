/**
 * 大模型接入的端到端测试（用 mock 模型，不依赖 6.4GB 的真实权重）。
 *
 * 覆盖用户提的四件事：
 *   1. 接入入口：/api/llm/health、/api/llm/providers 可用；
 *   2. 切换：PUT 改端点 + POST activate，且 apiKey 只回传打码值；
 *   3. 水印识别与去除：模型发 tool_calls → 本地**真跑** detect/remove → 结果回灌 → 收尾；
 *   4. 任意图片操作：裁剪/缩放/转格式等工具经同一条链路可调用。
 *
 * 真实模型（DeepSeek-VL2）只是换了 baseUrl，协议完全一样 —— 所以这套测试证明了
 * "换成真模型也只是配置不同"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import createApp from '../src/index.js';
import { createLlmRouter } from '../src/llm/routes.js';
import { getProvider, listProviders, saveSettings, setActiveProvider, updateProvider, loadSettings } from '../src/llm/providers.js';
import { startMockLlm } from './mock-llm.js';

const SAMPLE = path.resolve(import.meta.dirname, '../../samples/蝴蝶-豆包AI水印.jpg');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseOf(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

/** 读 SSE 直到 [DONE]，返回事件数组。 */
async function readSse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // 忽略非 JSON 心跳
    }
  }
  return events;
}

test('大模型接入：入口 / 切换 / 水印识别与去除 / 任意图片操作（mock 模型）', async (t) => {
  assert.ok(fs.existsSync(SAMPLE), '需要 samples/蝴蝶-豆包AI水印.jpg 作为测试素材');

  // 保存原始设置，测试结束后恢复（避免污染本地配置）
  const original = JSON.parse(JSON.stringify(loadSettings()));
  const mock = await startMockLlm();
  const app = createApp();
  const server = await listen(app);
  const base = baseOf(server);

  t.after(async () => {
    saveSettings(original);
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
  });

  // ---------------------------------------------------------------- 1) 接入入口
  const health = await (await fetch(`${base}/api/llm/health`)).json();
  assert.equal(health.ok, true, '工具应可用');
  assert.ok(Array.isArray(health.providers) && health.providers.length >= 3, '应列出多个可切换的提供方');
  assert.ok(health.tools.tools.includes('detect_watermark'), '工具集里应有 detect_watermark');
  assert.ok(health.tools.tools.includes('remove_watermark'), '工具集里应有 remove_watermark');

  // ---------------------------------------------------------------- 2) 切换
  const put1 = await (await fetch(`${base}/api/llm/providers/local-deepseek`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: mock.baseUrl, model: mock.model, apiKey: 'sk-test-1234567890' }),
  })).json();
  const local = put1.providers.find((p) => p.id === 'local-deepseek');
  assert.equal(local.baseUrl, mock.baseUrl, '端点应被更新');
  assert.notEqual(local.apiKey, 'sk-test-1234567890', 'apiKey 不能明文回传');
  assert.equal(local.apiKeySet, true);

  const activated = await (await fetch(`${base}/api/llm/providers/local-deepseek/activate`, { method: 'POST' })).json();
  assert.equal(activated.activeId, 'local-deepseek', '激活应生效');
  const probe = await (await fetch(`${base}/api/llm/providers/local-deepseek/probe`, { method: 'POST' })).json();
  assert.equal(probe.reachable, true, `探测应可达（${probe.error ?? ''}）`);
  assert.deepEqual(probe.models, [mock.model]);

  // ---------------------------------------------------------------- 上传素材
  const imageBytes = await fs.promises.readFile(SAMPLE);
  const uploaded = await (await fetch(`${base}/api/llm/assets?name=${encodeURIComponent('蝴蝶.jpg')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: imageBytes,
  })).json();
  assert.ok(uploaded.session?.id, '应返回会话 id');
  assert.ok(uploaded.asset?.id, '应返回 asset id');
  const sessionId = uploaded.session.id;
  const assetId = uploaded.asset.id;

  // ---------------------------------------------------------------- 3+4) 对话：模型发工具调用
  // 脚本化：先检测 → 再用上一步返回的 maskId 去除 → 最后给结论
  mock.setScript([
    () => ({ tool: { name: 'detect_watermark', arguments: { assetId, method: 'model', sensitivity: 55 } } }),
    (messages) => {
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      const parsed = lastTool ? JSON.parse(lastTool.content) : {};
      const maskId = parsed?.mask?.id;
      assert.ok(maskId, 'detect_watermark 的返回里应带 mask.id，供下一轮去除使用');
      return { tool: { name: 'remove_watermark', arguments: { assetId, maskId, engine: 'auto' } } };
    },
    () => ({ content: '已完成：检测到右下角文字水印并已去除，结果见 artifact。' }),
  ]);

  const chatRes = await fetch(`${base}/api/llm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message: '帮我把右下角的水印去掉' }),
  });
  assert.equal(chatRes.status, 200);
  const events = await readSse(chatRes);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('tool_call'), '应有工具调用事件');
  assert.ok(types.includes('tool_result'), '应有工具结果事件');
  assert.ok(types.includes('done'), '应正常结束');

  const detectResult = events.find((e) => e.type === 'tool_result' && e.name === 'detect_watermark');
  assert.ok(detectResult?.ok, `检测工具应成功（${JSON.stringify(detectResult?.result)?.slice(0, 200)}）`);
  assert.ok(detectResult.result.coverage > 0, '应检出覆盖面积 > 0');
  assert.ok(detectResult.result.mask?.id, '应产出掩膜 artifact');

  const removeResult = events.find((e) => e.type === 'tool_result' && e.name === 'remove_watermark');
  assert.ok(removeResult?.ok, `去除工具应成功（${JSON.stringify(removeResult?.result)?.slice(0, 200)}）`);
  assert.equal(removeResult.result.changedOutsideMask, 0, '掩膜外不应有改动');

  const done = events.find((e) => e.type === 'done');
  assert.ok(done.artifacts.length >= 2, '应至少产出掩膜 + 结果两张 artifact');

  // artifact 能取回图片
  const artifact = await fetch(`${base}${removeResult.result.artifact.url}`);
  assert.equal(artifact.status, 200);
  const bytes = Buffer.from(await artifact.arrayBuffer());
  assert.ok(bytes.length > 1000, 'artifact 应有实际内容');
  assert.equal(bytes[0], 0x89, 'PNG 魔数');

  // ---------------------------------------------------------------- 任意图片操作（同一链路）
  mock.setScript([
    () => ({ tool: { name: 'crop_transparent', arguments: { assetId } } }),
    () => ({ tool: { name: 'resize_image', arguments: { assetId, width: 480 } } }),
    () => ({ content: '已裁剪并缩放。' }),
  ]);
  const chat2 = await readSse(
    await fetch(`${base}/api/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '裁掉透明边并缩到 480 宽' }),
    }),
  );
  const cropResult = chat2.find((e) => e.type === 'tool_result' && e.name === 'crop_transparent');
  const resizeResult = chat2.find((e) => e.type === 'tool_result' && e.name === 'resize_image');
  // 该样例是不透明 JPG：裁剪会报"整张都是透明区域"或不做改动，两种都算工具链路正常
  assert.ok(cropResult, '裁剪工具应被调用');
  assert.ok(resizeResult?.ok, '缩放工具应成功');
  assert.ok(resizeResult.result.artifact?.width === 480, '缩放宽度应为 480');

  // ---------------------------------------------------------------- 提示式工具调用（给不支持 function calling 的模型）
  // 本地 DeepSeek-VL2-tiny 不会发原生 tool_calls，只会说文字；这里验证"文字里的 JSON 调用"能被识别。
  mock.setScript([
    () => ({ content: `\`\`\`json\n{"tool": "detect_watermark", "arguments": {"assetId": "${assetId}", "method": "yolo"}}\n\`\`\`` }),
    () => ({ content: '检测完成，掩膜已生成。' }),
  ]);
  const chat3 = await readSse(
    await fetch(`${base}/api/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: '再检测一次水印' }),
    }),
  );
  const prompted = chat3.find((e) => e.type === 'tool_result' && e.name === 'detect_watermark');
  assert.ok(prompted?.ok, '提示式工具调用应被执行（文字里的 JSON 被识别为工具调用）');
  const done3 = chat3.find((e) => e.type === 'done');
  assert.ok(done3.text.includes('检测完成'), '提示式调用后应拿到最终回答');

  // 会话历史里应有两条问答
  const session = await (await fetch(`${base}/api/llm/sessions/${sessionId}`)).json();
  assert.ok(session.messages.filter((m) => m.role === 'assistant').length >= 2, '会话应保留多轮历史');

  // 网关挂载点存在（不是被 SPA 兜底吞掉）
  const router = createLlmRouter();
  assert.equal(typeof router, 'function', 'createLlmRouter 应返回 Express Router');
  assert.ok(getProvider('local-deepseek'), '提供方应可读回');
  assert.equal(listProviders().activeId, 'local-deepseek');
  // updateProvider 之后 getProvider 应拿到明文（内部使用），HTTP 视图才打码
  assert.equal(getProvider('local-deepseek').apiKey, 'sk-test-1234567890');
  assert.equal(setActiveProvider('local-deepseek').activeId, 'local-deepseek');
});
