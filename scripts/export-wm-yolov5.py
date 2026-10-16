"""
把 YOLOv5 水印检测权重导出为 ONNX（**构建期一次性**跑，运行期不需要 Python）。

为什么要导出而不是运行 PyTorch
-----------------------------
运行期必须离线、零 Python 依赖：服务端只用 `onnxruntime-node`（本来就是 LaMa
的依赖）。所以这里只在构建机上跑一次 PyTorch → ONNX，产物
`models/watermark-yolov5.onnx` 交给 Node 侧推理。

为什么不用 YOLOv5 仓库的 `export.py`
------------------------------------
官方 export.py 会拉一大串依赖（pandas/seaborn/opencv/matplotlib…）。
这里只加载模型定义 + `torch.onnx.export`，把依赖压到 torch/torchvision/pyyaml。

用法：
  models\\venv\\Scripts\\python.exe scripts\\export-wm-yolov5.py
  # 可选：--imgsz 640 --opset 12 --simplify
"""
from __future__ import annotations

import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
YOLOV5_SRC = ROOT / "models" / "yolov5-7.0"
WEIGHTS = ROOT / "models" / "watermark-yolov5.pt"
OUTPUT = ROOT / "models" / "watermark-yolov5.onnx"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--imgsz", type=int, default=640, help="导出时固定的输入边长（检测时按此 letterbox）")
    parser.add_argument("--opset", type=int, default=12)
    parser.add_argument("--weights", default=str(WEIGHTS))
    parser.add_argument("--output", default=str(OUTPUT))
    args = parser.parse_args()

    weights = pathlib.Path(args.weights)
    if not weights.exists():
        print(f"✗ 找不到权重：{weights}\n  先跑：node scripts/download-wm-model.mjs --weights")
        return 1
    if not (YOLOV5_SRC / "models" / "yolo.py").exists():
        print(f"✗ 找不到 YOLOv5 源码：{YOLOV5_SRC}\n  先跑：node scripts/download-wm-model.mjs --source")
        return 1

    sys.path.insert(0, str(YOLOV5_SRC))

    import torch  # noqa: E402

    # 直接从 checkpoint 里取出 nn.Module：它就是个 YOLOv5 DetectionModel，
    # 反序列化需要 models.yolo 的类定义（所以上面把仓库根目录放进 sys.path）。
    print(f"… 加载权重 {weights.name}")
    ckpt = torch.load(str(weights), map_location="cpu", weights_only=False)
    model = ckpt["model"] if isinstance(ckpt, dict) and "model" in ckpt else ckpt
    model = model.float().eval()

    names = getattr(model, "names", None)
    if names:
        print(f"  类别：{names}")

    # 输出层设为推理模式（YOLOv5 的 Detect.forward 在 export 时会走 anchor 解码分支）
    try:
        model.model[-1].export = True  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    for m in model.modules():
        if hasattr(m, "inplace"):
            m.inplace = False

    imgsz = args.imgsz
    dummy = torch.zeros(1, 3, imgsz, imgsz)
    output = pathlib.Path(args.output)
    print(f"… 导出 ONNX（imgsz={imgsz}, opset={args.opset}）→ {output.name}")

    # YOLOv5 v7 的 Detect 层在 eval 模式下返回 (解码后的预测, 原始特征图) 两个输出，
    # 包一层只暴露第一个：(1, N, 5+nc)，坐标已经是 letterbox 图上的像素值。
    class SingleOutput(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, x):
            out = self.inner(x)
            return out[0] if isinstance(out, (list, tuple)) else out

    wrapped = SingleOutput(model).eval()

    with torch.no_grad():
        torch.onnx.export(
            wrapped,
            dummy,
            str(output),
            opset_version=args.opset,
            input_names=["images"],
            output_names=["predictions"],
            dynamic_axes=None,  # 固定尺寸：检测时我们自己 letterbox 到 imgsz
            do_constant_folding=True,
        )

    import onnx  # noqa: E402

    proto = onnx.load(str(output))
    onnx.checker.check_model(proto)
    size_mb = output.stat().st_size / 1048576
    print(f"✓ 完成：{output}（{size_mb:.1f}MB）")
    for inp in proto.graph.input:
        dims = [d.dim_value for d in inp.type.tensor_type.shape.dim]
        print(f"  输入 {inp.name}: {dims}")
    for out in proto.graph.output:
        dims = [d.dim_value for d in out.type.tensor_type.shape.dim]
        print(f"  输出 {out.name}: {dims}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
