"""
本地 DeepSeek-VL2 侧车：把 deepseek-vl2-tiny 暴露成 **OpenAI 兼容**端点。

为什么做成侧车
--------------
Node 服务不直接跑 PyTorch。这里起一个本机 HTTP 服务（默认 127.0.0.1:11500）说
OpenAI 协议，Node 侧把它当成一个 provider（见 server/src/llm/providers.js）。
好处：
  · 图片只在环回地址上流转，不出本机（符合"离线、图片不外发"）；
  · Node 侧代码对"本地 DeepSeek / Ollama / 云端"完全一致，切换零成本；
  · 模型加载失败只影响这个侧车，主应用照常可用（健康检查会报不可达）。

模型：deepseek-ai/deepseek-vl2-tiny（约 6.4GB）。CPU 推理，单次回答常见 30~120s，
      所以下面的服务把 max_tokens 默认压得很小，并在日志里打印耗时。

用法：
  models\\venv\\Scripts\\python.exe scripts/llm-sidecar-deepseek-vl.py \
      --model models/deepseek-vl2-tiny --port 11500 --dtype float32
  # 或 npm run llm:serve（会挑 venv 里的 python 并按上面的参数启动）
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 脚本在 scripts/ 下，项目根是上一级
VL2_CODE = os.path.join(ROOT, "models", "DeepSeek-VL2-main")

STATE = {
    "model": None,
    "processor": None,
    "tokenizer": None,
    "model_name": "deepseek-vl2-tiny",
    "device": "cpu",
    "loading": True,
    "error": None,
    "ready_at": None,
}


def log(msg: str) -> None:
    print(f"[vl2] {msg}", flush=True)


def install_xformers_shim() -> None:
    """给 CPU 补一个 xformers 的等价实现。

    siglip_vit.Attention.forward 里是**硬编码** `from xformers.ops import memory_efficient_attention`
    （不是条件导入），而 xformers 只有 CUDA 构建，CPU 机器上直接 ModuleNotFoundError。
    这里注入一个用 torch SDPA 实现的同名函数，语义等价：
    入参/出参形状都是 [B, N, H, D]，内部转成 SDPA 要的 [B, H, N, D]。
    """
    try:
        import xformers  # noqa: F401

        return
    except ImportError:
        pass
    import types

    import torch
    import torch.nn.functional as F

    def memory_efficient_attention(q, k, v, p=0.0, attn_bias=None, **kwargs):  # noqa: ARG001
        return F.scaled_dot_product_attention(
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), dropout_p=float(p)
        ).transpose(1, 2)

    module = types.ModuleType("xformers")
    ops = types.ModuleType("xformers.ops")
    ops.memory_efficient_attention = memory_efficient_attention
    module.ops = ops
    sys.modules["xformers"] = module
    sys.modules["xformers.ops"] = ops
    log("xformers 未安装：已注入 SDPA 等价实现（CPU 回退）")


def load_model(model_path: str, dtype: str) -> None:
    try:
        # DeepSeek-VL2 的模型类在它自己的仓库里（不是 HF 仓库的 remote code）
        if VL2_CODE not in sys.path:
            sys.path.insert(0, VL2_CODE)
        install_xformers_shim()
        import torch
        from deepseek_vl2.models import DeepseekVLV2ForCausalLM, DeepseekVLV2Processor

        log(f"加载 processor：{model_path}")
        processor = DeepseekVLV2Processor.from_pretrained(model_path)
        log("加载权重（CPU，可能要几分钟）…")
        torch_dtype = {"float32": torch.float32, "bfloat16": torch.bfloat16}.get(dtype, torch.float32)
        model = DeepseekVLV2ForCausalLM.from_pretrained(
            model_path,
            trust_remote_code=True,
            torch_dtype=torch_dtype,
            low_cpu_mem_usage=True,
        )
        model = model.to(torch_dtype).eval()
        STATE.update(
            model=model,
            processor=processor,
            tokenizer=processor.tokenizer,
            loading=False,
            ready_at=time.time(),
        )
        log("模型就绪")
    except Exception as exc:  # noqa: BLE001
        STATE.update(loading=False, error=f"{type(exc).__name__}: {exc}")
        log(f"模型加载失败：{STATE['error']}")


def decode_images(content) -> list:
    """从 OpenAI 多模态 content 里取出图片（data URL 或 http URL）。"""
    from PIL import Image
    import urllib.request

    images = []
    if isinstance(content, str):
        return images
    for part in content:
        if part.get("type") != "image_url":
            continue
        url = (part.get("image_url") or {}).get("url", "")
        if url.startswith("data:"):
            payload = base64.b64decode(url.split(",", 1)[1])
            images.append(Image.open(io.BytesIO(payload)).convert("RGB"))
        elif url.startswith("http"):
            with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310
                images.append(Image.open(io.BytesIO(resp.read())).convert("RGB"))
    return images


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(p.get("text", "") for p in content if p.get("type") == "text")


def run_inference(messages, max_new_tokens: int) -> str:
    import torch

    model = STATE["model"]
    processor = STATE["processor"]
    tokenizer = STATE["tokenizer"]

    system_prompt = ""
    turns = []
    images = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            system_prompt = text_of(msg.get("content"))
        elif role == "user":
            imgs = decode_images(msg.get("content"))
            images.extend(imgs)
            turns.append((role, text_of(msg.get("content")), imgs))
        elif role == "assistant":
            turns.append((role, text_of(msg.get("content")), []))

    # 组装成 DeepSeek-VL2 需要的 conversation 结构（最后一条留空给模型）
    conversation = []
    image_queue = list(images)
    for role, text, imgs in turns:
        if role == "user":
            n = len(imgs)
            prefix = "<image>\n" * n
            conversation.append({"role": "<|User|>", "content": prefix + text, "images": []})
            # images 直接给 processor 的 images 参数更稳妥
    conversation.append({"role": "<|Assistant|>", "content": ""})

    t0 = time.time()
    with torch.inference_mode():
        prepare_inputs = processor(
            conversations=conversation,
            images=images,
            force_batchify=True,
            system_prompt=system_prompt,
        ).to(STATE["device"])
        inputs_embeds = model.prepare_inputs_embeds(**prepare_inputs)
        outputs = model.language.generate(
            inputs_embeds=inputs_embeds,
            attention_mask=prepare_inputs.attention_mask,
            pad_token_id=tokenizer.eos_token_id,
            bos_token_id=tokenizer.bos_token_id,
            eos_token_id=tokenizer.eos_token_id,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            use_cache=True,
        )
        answer = tokenizer.decode(outputs[0].tolist(), skip_special_tokens=True)
    log(f"推理完成：{time.time() - t0:.1f}s，{max_new_tokens} max_new_tokens")
    return answer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 静默默认访问日志，只保留我们自己的
        pass

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": STATE["model_name"], "object": "model"}]})
            return
        if self.path.rstrip("/").endswith("/health"):
            self._json(
                200,
                {
                    "ok": STATE["model"] is not None,
                    "loading": STATE["loading"],
                    "error": STATE["error"],
                    "model": STATE["model_name"],
                    "device": STATE["device"],
                    "readyAt": STATE["ready_at"],
                },
            )
            return
        self._json(404, {"error": {"message": f"unknown GET {self.path}"}})

    def do_POST(self):  # noqa: N802
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json(404, {"error": {"message": f"unknown POST {self.path}"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            payload = {}
        if STATE["model"] is None:
            reason = STATE["error"] or ("模型仍在加载" if STATE["loading"] else "模型不可用")
            self._json(503, {"error": {"message": f"本地 DeepSeek-VL2 不可用：{reason}"}})
            return
        try:
            answer = run_inference(payload.get("messages", []), int(payload.get("max_tokens") or 256))
        except Exception as exc:  # noqa: BLE001
            log(f"推理失败：{exc}")
            self._json(500, {"error": {"message": f"推理失败：{type(exc).__name__}: {exc}"}})
            return
        self._json(
            200,
            {
                "id": f"chatcmpl-{int(time.time() * 1000)}",
                "object": "chat.completion",
                "model": STATE["model_name"],
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            },
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.path.join(ROOT, "models", "deepseek-vl2-tiny"))
    parser.add_argument("--port", type=int, default=11500)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--dtype", default="float32", choices=["float32", "bfloat16"])
    parser.add_argument("--no-load", action="store_true", help="只起服务不加载模型（用于验证协议）")
    args = parser.parse_args()

    STATE["model_name"] = os.path.basename(args.model.rstrip("/\\")) or "deepseek-vl2-tiny"
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"OpenAI 兼容端点：http://{args.host}:{args.port}/v1")
    if args.no_load:
        STATE["loading"] = False
        STATE["error"] = "以 --no-load 启动，未加载模型"
    else:
        threading.Thread(target=load_model, args=(args.model, args.dtype), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("退出")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
