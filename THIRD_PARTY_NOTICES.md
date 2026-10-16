# 第三方组件与开源代码声明

本项目**自己实现**的部分（`shared/watermark/**`、`server/src/watermark.js`、
`server/src/lama.js`、`scripts/*.mjs`、前端组件）为原创代码，未复制任何开源项目的源码。
下面列出的是**运行时依赖**，以及实现过程中参考其算法/论文思想的公开工作。

## 运行时依赖

| 组件 | 用途 | 许可证 | 上游 |
| --- | --- | --- | --- |
| [@techstark/opencv-js](https://github.com/techstark/opencv-js) | OpenCV 的 WebAssembly 构建，水印检测（形态学背景、α-map、模板匹配、修补）与本地裁剪引擎都跑在它上面 | Apache-2.0 | OpenCV 本体亦为 Apache-2.0（4.x/5.x 起） |
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) | 在 Node 里跑 ONNX 推理（LaMa 深度修补引擎） | MIT | Microsoft |
| [sharp](https://github.com/lovell/sharp) | 图片解码/编码、通道规范化（libvips 绑定） | Apache-2.0 | libvips 为 LGPL-2.1 |
| [Express](https://github.com/expressjs/express) | HTTP 服务 | MIT | — |
| [Vue 3](https://github.com/vuejs/core) / [Vite](https://github.com/vitejs/vite) | 前端框架与构建 | MIT | — |

## 模型权重（不随仓库分发）

| 模型 | 用途 | 许可证 | 下载方式 |
| --- | --- | --- | --- |
| LaMa（`lama_fp32.onnx`，198 MB） | 深度修补引擎：大面积/不透明水印的内容修复 | Apache-2.0 | `npm run model:lama`（脚本从 hf-mirror.com 分块断点续传下载；仓库 `.gitignore` 已排除 `models/`） |

模型来源为 ONNX 导出：[Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX)（Apache-2.0，
基于 Samsung AI 的 [LaMa](https://github.com/advimman/lama)，论文 *Resolution-robust Large Mask
Inpainting with Fourier Convolutions*）。

## 算法与论文参考（仅参考思路，代码自写）

- **反混合（un-blending）还原半透明水印**
  Dekel et al., *On the Effectiveness of Visible Watermarks* (CVPR 2017) ——
  水印可建模为 `I = α·W + (1−α)·B`，因此 `B = (I − αW)/(1 − α)`；
  本项目用**边界接缝能量最小化**来估 α（不需要多张同水印图片），实现见
  `shared/watermark/unblend.js`。
- **形态学背景估计**：用开运算/闭运算（结构元大于笔画宽度）替代高斯模糊来估计低频背景，
  避免笔画间隙出现负向鬼影；实现见 `shared/watermark/detect.js` 的 `detectOverlay`。
- **周期性平铺水印检测**：DFT 频谱找峰值 → 按位移做自相似性检验；见 `detectPeriodic`。
- **模板匹配定位水印**：多尺度 `matchTemplate` + 自写的零均值归一化相关复核对，
  用于解决归一化相关在平滑背景上的退化；见 `detectTemplate`。
- **OpenCV 修补**：Telea / Navier-Stokes INPAINT（`cv.inpaint`），用于不透明标记。
- **LaMa 推理**：固定 512×512 输入，按原生分辨率做重叠窗口切片（`planPatches`），只回贴掩膜内像素。

以上均为论文/算法层面的参考，仓库内不含其源码。
