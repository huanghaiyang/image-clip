/**
 * 大模型接入的 HTTP 路由。
 *
 * 分三类：
 *   1. **接入入口 / 切换**：/health、/providers（列表、改配置、激活、探测）
 *   2. **图片素材**：/assets 上传（转 artifact）、/artifact/:id 取图
 *   3. **对话**：/chat（SSE 流式事件：tool_call / tool_result / done）
 */
import express from 'express';

import { LIMITS, readMetadata } from '../imaging.js';
import { getArtifact } from './assets.js';
import { attachImage, createSession, getSession, listSessions, runChat } from './agent.js';
import { TOOL_DEFINITIONS, toolsStatus } from './tools.js';
import { getActiveProvider, listProviders, probeProvider, setActiveProvider, updateProvider } from './providers.js';

export function createLlmRouter() {
  const router = express.Router();
  const rawImage = express.raw({ type: () => true, limit: LIMITS.maxUploadBytes });
  const jsonBody = express.json({ limit: '2mb' });

  // ---------------------------------------------------------------- 接入状态
  router.get('/health', async (_req, res) => {
    const providers = listProviders();
    const tools = await toolsStatus();
    const active = getActiveProvider();
    const probe = active ? await probeProvider(active.id, { timeoutMs: 3000 }) : null;
    res.json({
      ok: Boolean(tools.available),
      active: providers.activeId,
      providers: providers.providers,
      activeReachable: probe?.reachable ?? false,
      activeModels: probe?.models ?? [],
      activeError: probe?.error ?? null,
      tools,
      settingsPath: 'data/llm.json',
    });
  });

  router.get('/providers', (_req, res) => res.json(listProviders()));

  router.put('/providers/:id', jsonBody, (req, res, next) => {
    try {
      res.json(updateProvider(req.params.id, req.body ?? {}));
    } catch (err) {
      next(err);
    }
  });

  router.post('/providers/:id/activate', (req, res, next) => {
    try {
      res.json(setActiveProvider(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/providers/:id/probe', async (req, res) => {
    res.json(await probeProvider(req.params.id, { timeoutMs: 5000 }));
  });

  router.get('/tools', (_req, res) => res.json({ tools: TOOL_DEFINITIONS }));

  // ---------------------------------------------------------------- 素材
  router.post('/assets', rawImage, async (req, res, next) => {
    try {
      const buffer = req.body;
      if (!buffer?.length) return res.status(400).json({ error: '缺少图片数据（请直接 POST 图片二进制）' });
      const meta = await readMetadata(buffer);
      const { session, asset } = attachImage(req.query.sessionId, buffer, {
        mime: meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`,
        width: meta.width,
        height: meta.height,
        label: String(req.query.name ?? '上传图片'),
      });
      res.json({ session, asset });
    } catch (err) {
      next(err);
    }
  });

  router.get('/artifact/:id', (req, res) => {
    const found = getArtifact(req.params.id);
    if (!found) return res.status(404).json({ error: 'artifact 不存在' });
    res.setHeader('Content-Type', found.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(found.buffer);
  });

  // ---------------------------------------------------------------- 会话 / 对话
  router.post('/sessions', jsonBody, (req, res) => {
    const session = createSession({ providerId: req.body?.providerId ?? null, title: String(req.body?.title ?? '') });
    res.json(session);
  });

  router.get('/sessions', (_req, res) => res.json({ sessions: listSessions() }));

  router.get('/sessions/:id', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    res.json(session);
  });

  /**
   * 对话：SSE 流式返回事件，前端逐条渲染（工具调用轨迹很适合流式展示）。
   * 事件类型：start / image_attached / model_reply / tool_call / tool_result / done / error
   */
  router.post('/chat', jsonBody, async (req, res, next) => {
    try {
      const { sessionId, message, providerId = null } = req.body ?? {};
      if (!sessionId) return res.status(400).json({ error: '缺少 sessionId（先 POST /api/llm/sessions 或 /assets）' });
      if (!getSession(sessionId)) return res.status(404).json({ error: `会话不存在：${sessionId}` });

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const send = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      send({ type: 'start', sessionId, providerId });

      await runChat({
        sessionId,
        message: String(message ?? ''),
        providerId,
        onEvent: send,
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      // 已经进入 SSE 的话，把错误也当事件发出去，前端才能显示可读原因
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        next(err);
      }
    }
  });

  return router;
}
