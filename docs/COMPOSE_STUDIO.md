# 合成工作室（Photoshop / After Effects 能力落地说明）

新增的「合成」工作区（图片处理 → 工具栏最后一项）把 PS 的图层/选区/调色与 AE 的关键帧/特效栈能力做成了纯前端模块，
不改动任何既有工具的行为。所有算法集中在 `shared/`，浏览器与 Node 共用同一份实现。

## 目录与模块

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 掩膜与选区 | `shared/maskops.js` | 灰度掩膜、魔棒（漫水+容差+连通开关）、布尔运算（并/减/交/替换）、羽化（三次盒式模糊近似高斯）、扩展/收缩、反相、包围盒、覆盖率 |
| 调色 | `shared/color/lut.js` | 33³ 3D LUT：曝光/对比度/饱和度/色温/色调/高光/阴影/白场/黑场/RGB 曲线，`.cube` 解析与导出 |
| 关键帧 | `shared/anim/keyframes.js` | 三次贝塞尔缓动（Newton 迭代）、7 个预设 + hold、轨道采样、loop / pingpong / once、帧时间表 |
| 文档模型 | `shared/compose/doc.js` | 图层模型、17 种图层混合模式（映射到 canvas composite op）、命中测试、局部坐标、序列化、快照撤销栈 |
| 图集 | `shared/atlas/meta.js` | 排版（列数/间距/外边距/extrude/2 的幂/上限）、TexturePacker JSON hash/array、Phaser、Cocos plist、九宫格 |
| 渲染 | `web/src/lib/studio/render.js` | 逐层合成、旋转/缩放/透明度/混合模式、调整层对下方已合成结果施加 LUT、蒙版、文字层、trim、图集导出、`.ora` 打包 |
| 状态编排 | `web/src/composables/useStudio.js` | 素材↔图层、选区、调色、动画播放与关键帧、导出、撤销/重做 |
| 界面 | `web/src/components/StudioStage.vue` / `StudioPanel.vue` | 舞台（移动/魔棒/手柄/缩放平移/播放头）与五页签面板 |
| 视频特效 | `server/src/effects.js` | FFmpeg 参数化特效与渲染路由 |

## 功能对照

### 来自 Photoshop

- **图层**：新建/复制/删除/上下移、可见性、重命名、混合模式、不透明度、缩略图。
- **调整层**：曝光/对比度/饱和度/色温/色调/高光/阴影/白场/黑场/RGB 曲线，作用于它下面的所有图层；可导入/导出 `.cube`。
- **选区**：魔棒（容差 + 是否只选连通区域）、选区叠加显示与虚线框、并/减/交/替换、羽化、扩展/收缩、反相、转图层蒙版、由图层 alpha 建选区。
- **变换**：位移、缩放、旋转、水平/垂直翻转、还原；舞台 8 个手柄拖动（Shift 缩放、Alt 旋转），滚轮缩放、空格/中键平移。
- **文字层**：内容、字号、颜色、描边、对齐。
- **导出**：PNG（可直接存入资源库）、分层 `.ora`（OpenRaster）、文档 JSON、图集 ZIP。

### 来自 After Effects

- **关键帧与缓动**：x / y / scaleX / scaleY / rotation / opacity 六条轨道；linear、ease、easeIn、easeOut、easeInOut、strongIn、strongOut、hold；时间轴打点、删除、逐帧预览。
- **播放控制**：帧率、时长、循环方式（loop / pingpong / once）、播放头拖动、播放/暂停、回到 0。
- **图集/序列帧导出**：按帧渲染精灵图集，附 TexturePacker（hash 与 array）、Phaser、Cocos plist 与九宫格信息，可选 trim 与 extrude。
- **视频特效栈（服务端）**：eq、colorTemp、blur、sharpen、glow、vignette、invert、lut、retime，支持链式组合与后台任务。

## 快捷键

- `0`：适合窗口；滚轮：以指针为中心缩放。
- 舞台空白处拖动：平移；空格 / 中键拖动：平移。
- 图层拖动：位移；`Shift` 拖动：缩放；`Alt` 拖动：旋转。
- `Ctrl+Z` / `Ctrl+Shift+Z`、`Ctrl+Y`：撤销 / 重做（已接入全局撤销分发，合成栈优先）。

## 服务端接口

`GET /api/effects/health` 返回 ffmpeg 可用性与各特效参数范围。

`POST /api/effects/render`

```json
{
  "path": "子目录/素材.mp4",
  "effects": [
    { "type": "eq", "brightness": 0.1, "contrast": 1.2, "saturation": 1.3 },
    { "type": "glow", "radius": 12, "opacity": 0.4 }
  ],
  "format": "mp4",
  "name": "输出名",
  "background": false
}
```

- 参数按白名单夹紧，未知特效类型直接报错。
- `background` 缺省且有 jobs 服务时返回 `202` 与任务 id；`background: false` 同步渲染并返回输出条目。
- 渲染结果写入资源库（默认 `视频特效/`），返回 `entry` 可直接播放。

## 测试

```bash
node shared/compose/maskops.test.js   # 7
node shared/color/lut.test.js         # 9
node shared/anim/keyframes.test.js    # 10
node shared/atlas/meta.test.js        # 10
node shared/compose/doc.test.js       # 12
node server/test/effects.test.js      # 10
npm run test:runner                    # 以上全部自动纳入
```

构建：`cd web && npx vite build`。Windows 上若 esbuild 清理临时文件被拒，先把 `TEMP`/`TMP` 指到项目内目录，例如
`$env:TEMP='D:\sgames\image-clip\.tmp\esbuild2'`。

## 已知限制

- 未实现 PSD 分层二进制解析（项目内没有可靠的第三方解析依赖），分层交换改用 **OpenRaster `.ora`**：ZIP 内含 `mimetype`、`stack.xml`、`data/layer-*.png`、`mergedimage.png` 与缩略图，GIMP / Krita 可直接打开。
- 图集与 `.ora` 导出走浏览器下载；大批量导出建议先落资源库再处理。
- 调整层按「下方已合成结果」整体调色，与 PS 的逐层剪贴蒙版行为略有差异。
