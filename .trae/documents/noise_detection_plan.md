# 背景去除噪点检测功能 实现计划

## 需求背景
用户反馈：背景去除后，主体内部还残留一些"像背景色一样的小噪点"（透明化后仍显示为孤立的 1~数十像素点）。这些噪点因为被主体边缘完全包围，**不与图片边缘连通**，所以 `buildBackgroundMask` 的"从边缘向内漫水填充 → 只抠与边缘连通的区域"这条规则天然把它们保护起来了（这其实是连通性开关的正确行为）。用户需要一种方法：在不破坏主体整体抠图效果的前提下，**检测这些"被完全包围的小孔洞"并把它们一并去除**，并且可以在 UI 里**逐个点击勾选要去掉的噪点**。

## 调研结论

| 能力 | 现状 | 复用可能性 |
|------|------|-----------|
| 背景掩膜构建 | `shared/bgremove.js::buildBackgroundMask` 已做连通性漫水填充 | 直接在其**输出 mask 之后**跑"孔洞填充" |
| 形态学工具 | 已有 `erodeMask` / `blurMask`（shared） | 孔洞填充可以作为形态学链的一步，加在 `blurMask` 之后 |
| 连通分量分析 | 仓库现有代码没有，但算法非常标准（Two-Pass Union-Find / BFS 都可） | 在 `shared/bgremove.js` 里新增一个 `fillMaskHoles` 函数；浏览器与 Node 端共用 |
| UI 工具条 | `useBgRemoval.state.tool` 已含 `pan/lasso/pick` | 新增 `hole` 工具；点选单个孔洞 → 在 mask 中把这一片改成去除 |
| 预览分辨率 | 最长边 1600px；原图分辨率在"应用"时重算 | 孔洞检测可在预览 mask 上做，交互完后重新走一次 applyMaskToRgba |
| 历史撤销 | `entry.history` / `recordEntryHistory`（group 合并） | "应用去噪孔洞"作为一次可撤销操作，group='holes' |

## 核心算法：孔洞检测 + 可视化

### 1. 共享算法（`shared/bgremove.js` 新增）

```js
/**
 * 反向连通分量：找出「掩膜中被 255 像素完全包围的 0 值孤岛」。
 * 输入 mask：255=要去除，0=要保留
 * 输出：每个孤岛 { id, area, bbox{x,y,width,height}, pixels:Int32Array(采样) }
 *       其中 bbox 用于列表里显示"这块在图上的哪里"
 */
export function detectHolesInMask(mask, width, height, options = {}) {
  // 两趟 BFS 或者 Two-Pass Union-Find，O(N)
  // 第一趟：从 mask=0 的边缘像素出发，漫水填充，标记所有与边缘连通的"保留区域"（这些不是孔洞）
  // 第二趟：遍历所有 mask=0 且未被标记的像素，把每一段 4-连通像素作为一个孔洞
  // 过滤：面积 < minArea 的才算（默认 1 像素，但建议用户可调 1~100）
}
```

**为什么用"边缘像素泛洪"而不是 Union-Find 直接扫全图？**
边缘像素数 = `2·(w+h)`，远小于 `w·h`；对于大图（哪怕 1600×1200 预览），BFS 栈最大也只到 3.8M，安全。

### 2. 共享算法（自动去噪）

```js
/**
 * 把「小面积孔洞」直接填进 mask（改 0→255）。
 * 用于"参数抠图"模式的自动清理：用户勾上"自动去噪"选项后实时生效。
 */
export function fillMaskHoles(mask, width, height, options = {}) {
  // 复用 detectHolesInMask 的内部标记数组，直接把未连通到边缘的 0 写回 255
}
```

## 实现步骤（依赖顺序）

### Step 1 · 共享算法（`shared/bgremove.js` 新增）
- 导出 `detectHolesInMask` 和 `fillMaskHoles`；
- 单元自测：构造几个含孔洞的小 mask，验证识别正确、填孔后覆盖率上升。

### Step 2 · useBgRemoval composable
- 新增状态：`entry.holes: { id, area, bbox }[] | null`（当前预览 mask 上识别到的孔洞列表）；
- 新增参数 `entry.options.minHoleArea = 2`（UI 里滑块调，默认去掉 ≥2px 的洞）；
- `recompute(entry)` 里生成 `built.mask` 之后：
  1. 如果 `minHoleArea > 0`，先 `fillMaskHoles(mask, ..., { minArea: minHoleArea })`；
  2. 再 `holes = detectHolesInMask(mask, ..., { minArea: 1 })`（用于 UI 显示所有孔洞，让用户逐个勾）；
- 新增 action：`removeHole(holeId)`：在**当前 mask 的一份副本**上，把 holeId 对应的所有像素（从孔洞的 bbox 里重新扫 mask 拿到精确像素）写成 255 → scheduleRecompute；
- 新增 action：`applyAllHoles()`：遍历 holes 直接写 mask；
- 历史快照 `entrySnapshot` 扩展 `holesRemoved: number[]`（或直接把当前 mask 摘要写入）；**这里 mask 不进快照（太大）**，改用"记录 holeIds"——撤销时重跑 `recompute`，但根据 holeIds 反推要填哪些洞。或者更简单：撤销/重做只影响参数和选区，不记录"已去掉哪些洞"——毕竟洞的识别会随参数变化而变化。

**最终决定：历史只记录参数/选区/颜色/AI alpha，不记录已去掉的洞。去掉洞的操作本身走"重算一次并强制保存"，这样撤销到"参数改动"时，洞会被重新识别（符合用户心智模型：调参数 → 洞可能会变大/变小/消失）。**

### Step 3 · BgStage.vue 交互
- 工具条加一个 `'hole'` 按钮（跟 pan/lasso/pick 并列）；
- `state.tool === 'hole'` 时指针 hover 高亮"当前光标下的那个孔洞"；
- 点击：调 `actions.removeHole(holeId)`；
- 覆盖层 canvas 绘制：
  - 小圆圈（`ctx.beginArc`）叠加在每个孔洞中心，大小跟面积成比例；
  - hover 的那个画个加粗描边 + 虚线 bbox；
  - 已被用户移除的不再显示（因为 mask 已经变了，下一次 recompute 会重新识别）。

### Step 4 · 参数面板（右栏 Inspector 里）
- "参数抠图" tab 下新增：
  - checkbox **自动去噪**（默认关）；
  - 滑块 **最小孔洞面积（像素）** 1~200，默认 2；
- 孔洞列表（当检测到且未开启自动去噪时显示）：
  - 列出前 20 个最大的洞，显示面积和在图上的相对坐标；
  - 每行一个按钮"移除此洞"；
  - 底部一个"一键移除所有"按钮。
- 状态区新增一行 `检测到 N 个孔洞（最小 M 像素）`。

## 文件清单

| 文件 | 改动 |
|------|------|
| `shared/bgremove.js` | 新增 `detectHolesInMask(mask, w, h, {minArea})` + `fillMaskHoles(mask, w, h, {minArea})`，附带内部的 BFS 工具函数 `floodFilledComponentMask` |
| `web/src/composables/useBgRemoval.js` | 新增 `DEFAULT_OPTIONS.minHoleArea = 0`；`recompute` 在 built.mask 之后调一次 detect；新增 `removeHole(holeId)` / `applyAllHoles()` 两个 action；entry 加 `holes` / `holesRemoved` |
| `web/src/components/BgStage.vue` | 加 `hole` 工具；hover 高亮孔洞；点击移除；覆盖层绘制孔洞标记 |
| `web/src/components/BgInspector.vue`（或叫 `BgRemovePanel.vue`，实际名字需要确认） | 参数面板加"自动去噪 + 孔洞列表 + 一键移除" |

## 依赖与考虑

- **性能**：detectHolesInMask 在预览分辨率（≤1600×1600）上跑一次 BFS + 一次孔洞扫描，预估 <10ms，实时预览不卡；
- **原图重算**：用户点"应用"时，`useBgRemoval` 现在会按原图分辨率重算 mask。孔洞检测如果在原图上跑（例如 8000×6000），BFS 栈可能爆，但原图分辨率通常远小于 48M（项目限制 MAX_PIXELS=64M）。为保险，原图去噪可以降采样到预览分辨率找洞 → 把洞的坐标按 `preview.scale` 反缩放回原图 mask → 在原图 mask 上直接写 255；
- **AI 抠图路径**：`buildSubjectMask` 也会走到"built.mask"，所以孔洞检测对 AI 路径同样生效，不用单独写一份；
- **连通性开关**：用户如果把 `connected: false` 打开，整张图上所有候选像素都被标记为去除，不会有孔洞。这时孔洞检测自然返回空列表，行为正确；
- **feather/erode 顺序**：孔洞检测放在最后（erode → blur → fillHoles → detectHoles）。这样过渡区的半透明像素不会被当成孔洞，避免白边。

## 验证

- 单元：对小 mask（8×8）构造含边缘孤岛的 case，detect 返回孔洞列表、面积正确；
- 单元：大 mask 随机撒 10^6 像素候选，fillMaskHoles 时间 <100ms；
- 手工：去背景后出现主体内部小孔洞 → 开启"自动去噪 → 面积 ≥2" → 预览中孔洞消失；
- 手工：关闭自动去噪 → 工具条选"孔洞" → 在预览图上点某个孔洞 → 它消失；
- 手工：一键移除所有孔洞 → 所有洞消失；
- 手工：调参数（容差/连通性开关/羽化）→ 孔洞列表实时变化；
- 手工：AI 抠图路径同样生效；
- 手工：撤销 / 重做 → 状态正确。

## 风险与处理

| 风险 | 处理 |
|------|------|
| 大图原图 mask 孔洞检测可能爆内存 | 孔洞检测只跑在预览分辨率 mask 上；原图应用时按比例回填洞坐标 |
| 用户把"大孔洞"当成主体（例如主体本身有黑色圆眼睛被误当洞） | 1) 默认自动去噪关；2) 面积阈值可调且会在 UI 上列出最大的洞，让用户确认；3) 点选移除/不移除 |
| 与现有"边缘连通"语义冲突 | 不冲突：连通性解决"主体身上的背景色像素"；孔洞检测解决"主体身上的背景色孤岛"。两者是互补关系 |
| 撤销时 mask 没进快照，用户可能困惑 | 参数 / 选区 / 颜色 / AI alpha 进快照，重算会重新识别洞；这符合"参数是因，洞是果"的心智模型 |
