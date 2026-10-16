# ImageClip · AABB 透明区域自动裁剪

Node + Vue 的图片处理应用。当前版本聚焦一个功能：

> **AABB 自动识别透明区域并切割图片** —— 扫描图片所有不透明像素，算出最小外接矩形
> （axis-aligned bounding box），把四周的透明区域整块切掉。

界面参考 Figma：左侧素材面板、中间棋盘格画布（带选择框 + 8 个手柄 + 尺寸标签，
被裁掉的区域会压暗显示）、右侧检查器、底部状态栏。

![界面：源图 + 裁剪框](docs/ui-source-view.png)

![界面：裁剪结果](docs/ui-result-view.png)

---

## 1. 快速开始

```bash
npm install          # 安装 server + web 两端的依赖
npm run dev          # 同时启动 Node API(8787) 和 Vite 前端(5173)
# 打开 http://127.0.0.1:5173
```

生产模式（同一个 Node 进程同时托管 API 和前端产物）：

```bash
npm run build        # 构建 web/dist
npm start            # http://127.0.0.1:8787
```

打开后点 **载入示例** 会把 `samples/` 里的三张蝴蝶图读进来看效果；也可以直接把图片
拖进画布、`Ctrl+V` 粘贴、或点「导入图片」。

其它命令：

| 命令 | 作用 |
| --- | --- |
| `npm test` | 算法单测 + 服务端接口集成测试（33 项） |
| `npm run verify` | 用 `samples/` 真图跑一遍，打印各阈值下的 AABB 并输出裁剪结果 |
| `npm run dev:web` / `npm run dev:server` | 只启动前端 / 只启动后端 |

---

## 2. 目录结构

```
image-clip/
├─ shared/aabb.js          ★ 核心算法：AABB 检测（零依赖，前后端共用同一份源码）
├─ shared/aabb.test.js       算法单测（19 项，构造像素级 fixture）
├─ server/
│  ├─ src/imaging.js          sharp 解码 → RGBA → 调 shared/aabb → 裁剪编码
│  ├─ src/index.js            Express API + 生产环境静态托管
│  └─ test/api.test.js        真实起 HTTP 服务的集成测试（14 项）
├─ web/
│  ├─ src/components/         TopBar / AssetPanel / StageCanvas / InspectorPanel / StatusBar
│  ├─ src/composables/useWorkspace.js   全部状态与动作
│  ├─ src/lib/imaging.js      浏览器解码 / 检测 / 裁剪导出
│  ├─ src/lib/engine.js       浏览器引擎 ↔ Node 引擎的统一契约
│  ├─ src/lib/zip.js          纯 JS 打包 ZIP（批量导出，无第三方依赖）
│  ├─ scripts/vite-runner.mjs 受限环境下的 Vite 启动器（见 §6）
│  └─ vite.noesbuild.config.js 无 esbuild 构建配置（见 §6）
├─ samples/                  示例图片（用户提供的三张蝴蝶，含 alpha）
└─ scripts/verify-samples.mjs 真图回归脚本
```

---

## 3. 算法：AABB 透明区域检测

`shared/aabb.js` 只做一件事，但被严格定义：

```js
detectBounds(rgba, width, height, options) → {
  bounds:  { x, y, width, height },     // 要保留的矩形（像素）
  trimmed: { left, top, right, bottom },// 四边各切掉多少像素
  empty, contentPixels, contentRatio, options
}
```

* **输入是“直通 RGBA”字节**：`width*height*4`，与浏览器 `canvas.getImageData()`、
  Node `sharp().ensureAlpha().raw()` 的输出完全一致。**同一份源码同时跑在两端**，
  这是客户端与服务端结果可以逐像素对齐的根本原因（见 §5 验证）。
* **判定规则**：`alpha > alphaThreshold` 的像素算内容（默认阈值 1，即“非全透明就算内容”）。
  颜色背景模式下追加一条：不透明但 RGB 与 `backgroundColor` 的三通道最大差值 ≤
  `colorTolerance` 的像素也算背景 —— 用于没有 alpha 的白底 JPG/截图。
* **逐像素精确扫描**，不做抽样加速。抽样的“加速版”会漏掉细小的孤立内容、
  甚至把整张图判成空，因此被明确移除（`aabb.test.js` 里有对应的回归用例）。
* `padding` 支持正负：正数向外扩（保留呼吸位），负数向内收（裁掉抗锯齿边缘）。
  结果会被夹取在图片范围内。
* 越界参数会被**收敛**而不是抛错（`alphaThreshold` 夹到 0–255，`padding` 取整…），
  原始参数快照会随结果一起返回，便于复现。

### 阈值怎么选

三张示例图在各阈值下的实测结果（`npm run verify`）：

| 图片 | 阈值 | 原始 | 裁剪后 | 四边去除 (左/上/右/下) | 保留面积 |
| --- | --- | --- | --- | --- | --- |
| 蝴蝶-01.webp | 0/1/8 | 1186×802 | **964×654** | 170 / 114 / 52 / 34 | 66.3% |
| 蝴蝶-01.webp | 16/32 | 1186×802 | 962×654 | 170 / 114 / 54 / 34 | 66.1% |
| 蝴蝶-02.webp | 0/1 | 1060×802 | **964×636** | 48 / 116 / 48 / 50 | 72.1% |
| 蝴蝶-02.webp | 8/16 | 1060×802 | 962×636 | 50 / 116 / 48 / 50 | 72.0% |
| 蝴蝶-03.webp | 0/1 | 1020×802 | **884×630** | 68 / 122 / 68 / 50 | 68.1% |
| 蝴蝶-03.webp | 8/16 | 1020×802 | 882×630 | 70 / 122 / 68 / 50 | 67.9% |

这类素材边缘干净，阈值 0~16 差别只有 1–2 像素；**默认 1** 最保守（不切内容），
若素材带很淡的投影噪点，把「透明阈值」往上调即可丢弃。

---

## 4. HTTP API（Node 侧）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 引擎能力：`sharp` 版本、算法标识、限制、默认参数 |
| GET | `/api/options` | 默认检测参数契约 |
| GET | `/api/samples` | `samples/` 清单（含中文文件名） |
| GET | `/api/samples/:name` | 读取示例原图（带路径穿越防护） |
| POST | `/api/analyze` | 检测 AABB → JSON |
| POST | `/api/crop` | 裁剪 → 图片二进制（`?response=json` 返回 dataURL） |
| POST | `/api/crop/batch` | 批量裁剪 → 逐张结果（单张失败不影响其它） |

请求体支持两种形式：

```bash
# ① 原始二进制 + query 参数
curl -X POST 'http://127.0.0.1:8787/api/crop?alphaThreshold=8&padding=2&format=png' \
     -H 'Content-Type: image/webp' --data-binary @samples/蝴蝶-01.webp \
     -o out.png

# ② JSON + dataURL
curl -X POST http://127.0.0.1:8787/api/analyze \
     -H 'Content-Type: application/json' \
     -d '{"image":"data:image/png;base64,...","options":{"matchColor":true,"colorTolerance":30}}'
```

检测参数（query 或 `options` 均可）：`alphaThreshold`、`padding`、`matchColor`、
`backgroundColor`、`colorTolerance`、`sample`（已无此参数）；输出参数：
`format`（`png`/`webp`/`jpeg`/`avif`/`source`）、`quality`。
二进制响应会带 `X-Image-Clip-Bounds`（base64 JSON）、`X-Image-Clip-Engine`、
`X-Image-Clip-Algorithm` 头。

错误统一为 `{ "error": { "code", "message" } }`：`UNSUPPORTED_FORMAT`(415)、
`EMPTY_CONTENT`(422)、`BAD_FORMAT`(400)、`PAYLOAD_TOO_LARGE`(413)…

---

## 5. 双引擎与一致性验证

界面上可以切换 **浏览器引擎**（`browser-canvas`，本地即时、不上传图片）和
**Node 引擎**（`node-sharp`，POST 到服务端）。两者调用同一个 `shared/aabb.js`，
所以在同一张图上会给出**完全相同**的 AABB —— 实测（蝴蝶-03，阈值 1）：

```
浏览器引擎: 1020×802 → 884×630 @ (68, 122)   5.6ms
Node 引擎 : 1020×802 → 884×630 @ (68, 122)   45ms
```

如果 Node 服务没启动，切到 Node 引擎会自动回退到浏览器引擎并在结果里标注，
不会让界面卡在错误状态。

### 已验证的行为（不是"应该能跑"）

* `npm test` —— 33 项全绿：
  * 算法 19 项：四周边距、单像素角落、不规则形状、整图透明、阈值边界（`>` 与 `>=` 的区别）、
    正负 padding 夹取、颜色背景模式及容差、非法缓冲区报错、参数收敛。
  * 服务端 14 项：真实 HTTP 服务上的检测/裁剪/批量/多格式输出/错误码，
    以及 **CMYK JPEG**（若不转 sRGB，K 通道会被误当 alpha → 整张图被判成全透明）和
    **调色板 PNG** 的规范化路径。
* `npm run verify` —— 真实示例图跑通并输出裁剪结果到 `probe-out/`。
* 浏览器端到端（Chrome 155 + Playwright 驱动真实点击）：
  导入三张示例 → 浏览器引擎得出 884×630 @(68,122) → 切 Node 引擎得到同一结果 →
  切「裁剪结果」视图 → 状态栏显示 `Node 服务端已连接 · sharp 0.34.5`。

---

## 6. 受限环境（沙箱 / 无子进程 CI）

Vite 默认依赖 esbuild，而 esbuild 每次都会 **spawn 一个原生子进程**；在禁止派生进程的
环境里会直接 `EPERM`。本仓库为此提供了两条不碰 esbuild 的等价链路（正常环境仍然用
标准的 `npm run dev` / `npm run build`）：

```bash
npm --workspace web run build:restricted   # = node scripts/vite-runner.mjs build --configLoader runner --config vite.noesbuild.config.js
npm --workspace web run dev:restricted
```

它们做了三件事：

1. `--configLoader runner`：配置不再用 esbuild 打包，改用原生运行时加载。
2. `vite.noesbuild.config.js`：关掉 esbuild（`esbuild: false`）、关掉压缩与语法降级
   （`target: esnext`、`minify: false`），并用一个小插件提前替换掉
   `process.env.NODE_ENV` / `__VUE_*__` 这些本来由 esbuild 负责的 define 常量
   （Vite 的 `vite:define` 插件只在源码命中这些标识符时才调 esbuild）。
3. `scripts/vite-runner.mjs`：Vite 在 Windows 上会执行 `exec('net use')` 探测网络驱动器，
   该调用点没有 try/catch，spawn 失败会直接崩掉进程；启动器只把这一条命令替换成
   “没有网络映射盘”的空结果。注意补丁必须用 CJS `require` 并在 **任何 ESM 命名导入之前**
   完成，否则 Node 已经建好 `node:child_process` 的命名导出快照，补丁不生效。

另外仓库根 `.npmrc` 里设了 `ignore-scripts=true`：唯一带 install script 的依赖是
`sharp`，其脚本只是校验已经作为可选依赖下载好的预编译二进制，跳过它可以保证在
限制子进程的环境里 `npm install` 也能成功（`sharp` 本身功能不受影响，已实测）。
如果你的环境不限制子进程，删掉这一行即可。

如果在受限环境里 `npm install` 报用户级缓存目录不可写：

```bash
npm install --cache .npm-cache     # npm 不接受 .npmrc 里的相对 cache 路径，需显式指定
```

---

## 7. 已知边界

* 检测基于 **alpha 通道**（和可选的背景色匹配）。纯白底 JPG 需要打开「颜色背景模式」，
  容差要自己调；浅色主体贴白底时容易误伤，这类素材更适合先用抠图工具处理。
* 不做 EXIF 自动旋转：浏览器 `createImageBitmap` 默认与 `sharp` 一样按原始像素方向处理，
  两端一致；带旋转信息的手机照片需要在导入前自行矫正。
* 单张上限：64MB / 6400 万像素（两端都有校验，服务端返回 413）。
* 批量导出 ZIP 使用 store 模式（不二次压缩）—— 图片本身已是压缩格式，
  这样还能省掉一个依赖。
* 目前只实现「透明区域裁剪」这一个功能，其余功能（缩放、水印、批量重命名等）未开发。

---

## 8. 界面快捷键

| 操作 | 说明 |
| --- | --- |
| 拖放 / `Ctrl+V` | 导入图片 |
| `Ctrl+O` | 打开文件选择框 |
| 滚轮 | 以光标为中心缩放 |
| 拖拽画布 | 平移 |
| `0` | 适应窗口 |
| `R` | 源图 ↔ 裁剪结果 |
| `Delete` / `Backspace` | 移除当前素材 |

画布左下角会实时显示光标处的图像坐标与 RGBA（`A 0` 高亮），
调阈值时可以直接看着 alpha 判断边界。
