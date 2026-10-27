# 官方效果图检索清单 B

核验时间：2026-10-24（Asia/Shanghai）。页面与版本优先采用已有调研固定的官方 GitHub 提交；图片保留官方远程地址，未下载到项目。已对 9 个图片地址使用 HTTP Range 读取文件头：均返回 206 Partial Content，内容类型和像素尺寸记录在对应项下。Markmap 没有找到合适的官方静态图片，保留官方交互演示链接。

## Graphify

![Graphify 的 FastAPI 代码知识图，含社区图例](https://raw.githubusercontent.com/Graphify-Labs/graphify/c588b72d936927790a87ad009955078ed40562a3/docs/graph-hero.png)

[来源页：官方 README，graphify v0.9.94 / commit c588b72](https://github.com/Graphify-Labs/graphify/blob/c588b72d936927790a87ad009955078ed40562a3/README.md)。README 将图描述为其交互式 graph.html 中展示 FastAPI 代码库的力导向知识图和社区图例；此处嵌入的是静态效果图，不是徽标。HTTP：image/png，1400×692。

## NodeGraph

![NodeGraph 将原文引用连到 PDF 中高亮的对应句子](https://raw.githubusercontent.com/Jeong-jin-Han/NodeGraph/2cf3a77df8d358ced3563ce348b024b39f30d817/resources/screenshot-pdf-jump.png)

[来源页：官方 README，版本 2.4.0 / commit 2cf3a77](https://github.com/Jeong-jin-Han/NodeGraph/blob/2cf3a77df8d358ced3563ce348b024b39f30d817/README.md)。README 的 PDF quote-jump 截图展示原文引用与 PDF 句子高亮的关系；属于静态界面截图。HTTP：image/png，2420×1356。

## LightRAG

![LightRAG API Server 部分的官方界面截图](https://raw.githubusercontent.com/HKUDS/LightRAG/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/README.assets/iShot_2025-03-23_12.40.08.png)

[来源页：官方 README，v1.5.7 / commit aaebfe1](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/README.md)。README 在介绍提供 Web UI 的 API Server 段落后直接嵌入该图。文件名日期为 2025-03-23；只描述为 README 中的 UI 截图，不推断其具体面板内容或当前版本外观。HTTP：image/png，2336×1400。

## cognee

![cognee 官方 README 动图演示](https://raw.githubusercontent.com/topoteretes/cognee/37f788bd287750e10d7610173e5332b3843f6ebd/assets/cognee-demo.gif)

[来源页：官方 README，v1.6.6rc1 / commit 37f788b](https://github.com/topoteretes/cognee/blob/37f788bd287750e10d7610173e5332b3843f6ebd/README.md)。README 以 Cognee Demo 标记此动图。另有 remember/recall 的 SVG 架构示意，但此处选用动图作为产品演示。HTTP：image/gif，1200×390。

## baoyu-skills

![baoyu-infographic 的 Bridge 布局预览](https://raw.githubusercontent.com/JimLiu/baoyu-skills/1567581c26ec29f4216c6e6835415bf30343b0e3/screenshots/infographic-layouts/bridge.webp)

[来源页：官方 README，v2.5.2 / commit 1567581](https://github.com/JimLiu/baoyu-skills/blob/1567581c26ec29f4216c6e6835415bf30343b0e3/README.md)。这张图是 README 的 infographic 布局预览，不是应用界面，也不应误称为 baoyu-diagram 的产物。

- [baoyu-infographic 技能说明](https://github.com/JimLiu/baoyu-skills/blob/1567581c26ec29f4216c6e6835415bf30343b0e3/skills/baoyu-infographic/SKILL.md)：图片类流程，最终输出 PNG；README 公开了多张信息图布局预览。
- [baoyu-diagram 技能说明](https://github.com/JimLiu/baoyu-skills/blob/1567581c26ec29f4216c6e6835415bf30343b0e3/skills/baoyu-diagram/SKILL.md)：独立 SVG 代码制图流程，输出自包含 SVG。检查的官方仓库文件树没有找到可嵌入的 baoyu-diagram SVG 成品样图，因此保留缺口，不用信息图预览冒充。

HTTP：image/webp，1376×768。

## beautiful-mermaid

![beautiful-mermaid 的 sequence diagram 渲染示例](https://raw.githubusercontent.com/lukilabs/beautiful-mermaid/2ac8bbbb060ca0a65a6a21f3200bd99b1587b488/hero.png)

[来源页：官方 README，v1.1.2 / commit 2ac8bbb](https://github.com/lukilabs/beautiful-mermaid/blob/2ac8bbbb060ca0a65a6a21f3200bd99b1587b488/README.md)。README 的 alt text 将它标为 sequence diagram example；这是静态渲染示例，不是编辑器 UI。HTTP：image/png，1568×907。

## Mermaid

![Mermaid Live Editor 的代码、配置与预览面板](https://mermaid.js.org/assets/Code-Preview-Config.DjJHMydJ.png)

[来源页：Mermaid 官方 Getting Started 文档，页面显示版本 12.2.0](https://mermaid.js.org/intro/getting-started.html)。这是官方文档嵌入的编辑器界面截图，说明代码、配置与图形预览如何并列显示。HTTP：image/png，1440×793。

## Markmap

本轮未找到合适的官方静态效果图，按缺口处理，不用徽标替代。官方文档描述它把 Markdown 层级渲染为可交互思维导图，并链接了[官方 try-it-out 演示](https://markmap.js.org/repl)。

[来源页：Markmap 官方文档](https://markmap.js.org/docs/markmap)。项目包含多个包；已有核查记录为 README commit 122bf05、markmap-cli 0.18.12，以及 GitHub Release v0.18.0，不能把仓库内各包版本合并成一个统一版本。

## Cytoscape.js

![Cytoscape.js 的东京铁路站点网络静态图](https://raw.githubusercontent.com/cytoscape/cytoscape.js/9aab1b4489645c15e82fce71fdce738f58d8165d/documentation/img/tokyo-big.png)

[来源页：官方 README，v3.34.4 / commit 9aab1b4](https://github.com/cytoscape/cytoscape.js/blob/9aab1b4489645c15e82fce71fdce738f58d8165d/README.md)。README 明确说明此图是 Tokyo railway stations network，并另给 live demo 和源码；图本身是静态网络图示，不是界面截图。HTTP：image/png，1200×505。

## React Flow（xyflow）

![React Flow 官方 Showcase 中的 CircuLearn 界面截图](https://reactflow.dev/img/showcase/189f4645-2242-8185-a5fe-ca2dfcebe5b1.png)

[来源页：React Flow 官方 Showcase](https://reactflow.dev/showcase)。CircuLearn 是该 Showcase 收录的第三方项目，页面描述为教学逻辑电路的交互模拟器；图片属于被展示项目的真实界面，不是 React Flow 自带编辑器截图。已有版本核查记录为 @xyflow/react 12.12.0、仓库 commit 8523d8d。HTTP：image/png，2879×1559。

## Excalidraw 手绘风格证据（供主线程讨论）

- Excalidraw 官方 [constants.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts) 将 roughness 定义为 0 = architect、1 = artist、2 = cartoonist；普通元素默认是 artist（1）。同一文件的 FRAME_STYLE 将真正的 frame 设为 roughness 0。
- 官方 [字体常量](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts) 中 fontFamily 3 是 Cascadia，5 是 Excalifont；[字体说明](https://github.com/excalidraw/excalidraw/blob/master/dev-docs/docs/%40excalidraw/excalidraw/api/constants.mdx)称 Excalifont 为 hand-drawn 字体，且它是默认字体。
- 官方[程序化元素文档](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton)说明箭头可通过 start/end 绑定到形状；frame 通过 children 元素 ID 组织内容。

因此，现有 MUX 样例的 roughness 0 + fontFamily 3 是 architect 线条与等宽代码字体，观感会偏工整，不能当作用户喜欢的手绘风格终稿。若后续做手绘版，主内容方框可用 rectangle、箭头绑定到框并将两者设 roughness 1，文字用 fontFamily 5；真正的 frame 可用于分组，但官方默认边框是直线风格。
