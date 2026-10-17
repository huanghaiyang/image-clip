/**
 * 测试用的 **mock OpenAI 兼容模型服务**。
 *
 * 为什么要它：本地 DeepSeek-VL2 在 CPU 上单次推理要几十秒，不能作为单元测试依赖；
 * 而"接入/切换/工具调用/水印识别与去除"这些**编排逻辑**必须可重复验证。
 * 所以用一个按脚本回复的假模型：第一轮返回 tool_calls，工具结果回来后返回下一轮，
 * 最终返回文本。这样就能端到端验证：模型决策 → 本地真跑检测/去除 → 结果回灌 → 收尾。
 */
import http from 'node:http';

/**
 * 启动 mock 服务。
 * @param {{host?:string, port?:number, script?:Array<Function>}} options
 *   script: 每收到一次 chat/completions 就弹出一个构造器，参数是 messages，
 *           返回 {tool:{name,arguments}} 或 {content:string}
 */
export async function startMockLlm({ host = '127.0.0.1', port = 0, script = [] } = {}) {
  const calls = [];
  let queue = [...script];
  const model = 'mock-vl';

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (req.url?.endsWith('/models') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
        return;
      }
      if (req.url?.endsWith('/chat/completions') && req.method === 'POST') {
        let payload = {};
        try {
          payload = JSON.parse(bodyText);
        } catch {
          payload = {};
        }
        calls.push(payload);
        const build = queue.shift();
        const step = build ? build(payload.messages ?? [], payload) : { content: '（mock 脚本已用完）' };
        const message = step.tool
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${calls.length}`,
                  type: 'function',
                  function: { name: step.tool.name, arguments: JSON.stringify(step.tool.arguments ?? {}) },
                },
              ],
            }
          : { role: 'assistant', content: step.content ?? '' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl_${calls.length}`,
            object: 'chat.completion',
            model,
            choices: [{ index: 0, message, finish_reason: step.tool ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock: unknown ${req.method} ${req.url}` } }));
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const baseUrl = `http://${host}:${address.port}/v1`;
  return {
    baseUrl,
    model,
    calls,
    get requestCount() {
      return calls.length;
    },
    setScript(next) {
      queue = [...next];
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
