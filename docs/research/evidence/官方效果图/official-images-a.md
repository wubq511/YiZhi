# 官方效果图检索清单 A

核验日期：2026-10-24。来源范围为官方产品网页、官方帮助页及官方 GitHub README。图片 URL 直接指向来源方托管文件；只通过 HTTP Range 读取了开头字节以确认响应类型、像素尺寸和总字节数，没有将远程图片保存到工作区。

状态：9 组均有可用官方图片。NotebookLM 条目新增一张静态 Mind Map 效果图，并附一张官方功能演示 GIF；所有远程图片保留原托管链接，后续总报告可直接引用。

## NotebookLM Mind Maps — 已核验

![NotebookLM 根据 Google Cloud Next 2025 资料生成的 Mind Map，展示主题分支和概念关系](https://storage.googleapis.com/gweb-cloudblog-publish/images/5458i_Get_more_out_of_Gemini_inline_image_.max-2000x2000.jpg)

- 来源页：[Beyond the prompt: Mastering the “deep end” with generative AI](https://workspace.google.com/blog/ai-and-machine-learning/beyond-prompt-mastering-deep-end-generative-ai)。正文说明作者把 Google Cloud Next 25 的会议资料上传到 NotebookLM，并称图中为 NotebookLM 生成的 Mind Map。
- 图片内容：真实生成结果示例，静态 JPEG，展示主题分支与概念关系；不是品牌主视觉或普通产品首页。
- HTTP/MIME：HTTP 206，`image/jpeg`，2000 × 1445 px，106,140 bytes。以 `Range: bytes=0-65535` 读取 65,536 bytes 核验，未保存完整图片。
- 补充官方动图：[NotebookLM Mind Map GIF](https://storage.googleapis.com/gweb-cloudblog-publish/original_images/NotebookLM_-_mind_map_1.gif)，来源页：[May Workspace feature drop](https://workspace.google.com/blog/product-announcements/may-workspace-feature-drop-new-ai-features)。该页在 NotebookLM 功能段落配有“Generate and use Mind Maps to get a visual overview of your sources.”图注。HTTP 206，`image/gif`，960 × 540 px，15,508,187 bytes；同样仅读取前 65,536 bytes。

## Obsidian Canvas / Graph — 已核验

![Obsidian Canvas 画布界面：卡片与连接线组成的可视化工作区](https://obsidian.md/images/canvas/obsidian-canvas-cookies.png)

- 来源页：[Obsidian Canvas](https://obsidian.md/canvas)；Graph 关系说明见 [Graph view 帮助](https://obsidian.md/help/plugins/graph)。
- 表达能力：空间卡片、分组和连接线；Graph 是独立的内部链接网络视图。
- 类型与 HTTP：静态 PNG，`image/png`，3028 × 2120 px，2,601,027 bytes；Range 响应 HTTP 206。

## Heptabase — 已核验

![Heptabase 白板上的主题思维导图，由可复用概念卡组织研究主题](https://wiki.heptabase.com/assets/images/the-best-way-to-acquire-knowledge-from-readings-Untitled%209-b7d4185f838da7712dc3b86283ac72da.png)

- 来源页：[Learn & research a topic](https://wiki.heptabase.com/the-best-way-to-acquire-knowledge-from-readings)。
- 表达能力：官方案例将多本书中抽取的概念卡复用于 Dynamic Medium 白板，并组织为 mind map。
- 类型与 HTTP：静态 PNG 白板示例，`image/png`，3456 × 2160 px，1,346,578 bytes；Range 响应 HTTP 206。

## TheBrain — 已核验

![TheBrain 知识网络示意：一个 thought 连接到项目、人物、文件、决定与 AI 洞察](https://thebrain.com/images/homepage/one-thought.png)

- 来源页：[TheBrain 官方主页](https://thebrain.com/)。
- 表达能力：一个 thought 与项目、人物、文件、决定和 AI 洞察建立跨主题关系。
- 类型与 HTTP：静态 PNG 产品界面示意，`image/png`，1194 × 1194 px，355,611 bytes；Range 响应 HTTP 206。

## draw.io / diagrams.net + 官方 MCP — 已核验

![draw.io 官方 MCP 效果：AI 助手在聊天中生成可编辑的退款流程图](https://www.drawio.com/img/mcp/drawio-mcp-hero-poster.jpg?v=7)

- 来源页：[draw.io for AI assistants](https://www.drawio.com/mcp/)；依赖图例另见 [Dependency graphs](https://www.drawio.com/docs/diagram-types/dependency-graphs/)。
- 表达能力：聊天中根据提示生成流程图，可继续在 draw.io 打开和编辑；此图满足官方 MCP 生态的主效果图需求。
- 类型与 HTTP：静态 JPEG MCP 效果截图，`image/jpeg`，1280 × 720 px，70,336 bytes；Range 响应 HTTP 206。

## Next AI Draw.io — 已核验

![在线商店 ER 图示例，包含实体及关系](https://raw.githubusercontent.com/DayuanJiang/next-ai-draw-io/2788253c65a2df0796cdb6954785b96c12b2fa00/public/gallery/er-shop.svg)

- 来源页：[官方 README（固定到核验提交）](https://github.com/DayuanJiang/next-ai-draw-io/blob/2788253c65a2df0796cdb6954785b96c12b2fa00/README.md)。
- 表达能力：在线商店实体关系图；README 将它列为 Claude Opus 5.5 配合 MCP Server 生成的图例。
- 类型与 HTTP：静态 SVG 示例图，`image/svg+xml`，782 × 586 px，86,530 bytes；Range 响应 HTTP 206。

## Drawnix — 已核验

![Drawnix 官方 README 中的白板产品展示图](https://raw.githubusercontent.com/plait-board/drawnix/b138ff867943ddff6c4c79560e10ab6ee3b5600e/apps/web/public/product_showcase/case-2.png)

- 来源页：[官方 README（固定到核验提交）](https://github.com/plait-board/drawnix/blob/b138ff867943ddff6c4c79560e10ab6ee3b5600e/README.md)。
- 表达能力：白板产品的实际编辑界面示例；项目功能说明覆盖思维导图、流程图与自由画。
- 类型与 HTTP：静态 PNG 产品展示图，`image/png`，3248 × 2112 px，251,988 bytes；Range 响应 HTTP 206。

## AFFiNE — 已核验

![AFFiNE 官方 README 中的产品界面演示动图](https://user-images.githubusercontent.com/79301703/230891830-0110681e-8c7e-483b-b6d9-9e42b291b9ef.gif)

- 来源页：[官方 README（固定到核验提交）](https://github.com/toeverything/AFFiNE/blob/fbf2cebfa012a7c92b08af7bfa0340177308b2a6/README.md)；AI Mind Map 能力说明见 [官方 Mind Map Generator 页面](https://affine.pro/ai/mind-map-generator)。
- 表达能力：README 中的通用产品界面演示，作为文档与画布工作区的整体体验图；README 未将这段 GIF 标注为 AI Mind Map 专用流程。
- 类型与 HTTP：动图 GIF，`image/gif`，1167 × 722 px，4,978,786 bytes；Range 响应 HTTP 206。

## DeepTutor — 已核验

![DeepTutor v1.6.5 Chat 工作区，侧边栏显示各功能入口](https://raw.githubusercontent.com/HKUDS/DeepTutor/a31d82624c27d75f4e771d4fcb78dce16470b383/assets/figs/web-1.6.5/OVERVIEW.png)

- 来源页：[官方 README（固定到核验提交）](https://github.com/HKUDS/DeepTutor/blob/a31d82624c27d75f4e771d4fcb78dce16470b383/README.md)。
- 表达能力：DeepTutor 当前 Chat 工作区与应用功能侧栏；README 标注该主页截图对应 v1.6.5。
- 类型与 HTTP：静态 PNG 界面截图，`image/png`，1440 × 900 px，125,011 bytes；Range 响应 HTTP 206。
