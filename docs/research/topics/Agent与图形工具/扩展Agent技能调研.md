# 数字逻辑复习：扩展 Agent 技能与可视化工作流调研

调研日期：**2026-10-24，Asia/Shanghai**。Stars 为本次直接读取 GitHub API 的快照；提交与发布日期统一使用 **UTC**。范围是用户确认的数字逻辑 **01—06**：简介、进制与码制，逻辑代数，卡诺图，组合逻辑分析与设计，组合模块 1 与代码，组合模块 2 与代码。

本报告使用 web 检索定位，再核对原作者仓库、技能正文、关键源码、许可证与 GitHub API。**未安装、未运行 demo、未查询 X、未使用其他子 Agent。** 文中的适配判断不是实测结论。仅补充原报告，不重复 Obsidian、draw.io、官方 Excalidraw MCP 等既有调查。

## 结论：应改变原推荐的展示层，并增加真正的抽取候选

**原先“markmap + Mermaid 优先”的推荐，对目录导航与简单依赖图仍成立，但不足以覆盖用户要比较的实际复习效果。** 新证据支持三项调整：

1. **讲清楚概念和解题过程：优先比较 `nicobailon/visual-explainer`。** 它是包含交互讲解、图形、渲染检查和反馈的工作流，不只是 Mermaid 的美化包装。
2. **生成可持续修改的图：把 `fireworks-tech-graph` 纳入 SVG 首选比较；同时区分 `baoyu-diagram` 的 SVG 与 `baoyu-infographic` 的 PNG。** 需要手工拖拽编辑时，`coleam00/excalidraw-diagram-skill` 的原生 `.excalidraw` 交付也值得比较，但其仓库许可证当前未明确。
3. **从课件提出关系候选：`Graphify-Labs/graphify` 应列为重点。** 它确实覆盖文档、PDF、图像的语义抽取和图查询；但默认通用关系、置信标签和聚类结果都不等于课程前置关系。

以上推荐依据见下文逐项核验。共同底座仍应是一份带来源、方向、理由和审核状态的课程关系表；讲解页面、白板、SVG 和查询视图读取同一份已核对内容。不能用图形校验通过、效果漂亮或高 Stars 替代教学关系核对。

## 1. 身份、许可证与维护快照

以下六组为本轮核心候选。新增 fireworks 和 coleam00 项目替换了较外围的候选，不继续扩展列表。六个仓库本次 API 均为 `archived: false`。Stars 不代表正确性或学习效果；默认分支提交和 GitHub Release 分开记录，不把 Release 日期当作全部维护活动。

| 候选与准确仓库 | Stars，2026-10-24 | 许可证证据 | 默认分支最新提交，UTC | GitHub Release / 维护信号 |
| --- | ---: | --- | --- | --- |
| ① [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer) | [10,604](https://api.github.com/repos/nicobailon/visual-explainer) | [MIT](https://github.com/nicobailon/visual-explainer/blob/main/LICENSE) | [2026-10-19，`5f37886`](https://github.com/nicobailon/visual-explainer/commit/5f378868e0ea745a6284b51e710c390f0c76f72c)，发布版本提交 | [v0.14.0，2026-10-20](https://github.com/nicobailon/visual-explainer/releases/tag/v0.14.0)，有近期发布 |
| ② [lukilabs/beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) | [11,224](https://api.github.com/repos/lukilabs/beautiful-mermaid) | [MIT](https://github.com/lukilabs/beautiful-mermaid/blob/main/LICENSE) | [2026-05-06，`2ac8bbb`](https://github.com/lukilabs/beautiful-mermaid/commit/2ac8bbbb060ca0a65a6a21f3200bd99b1587b488)，编辑器路径修复 | [v1.1.2，2026-02-26](https://github.com/lukilabs/beautiful-mermaid/releases/tag/v1.1.2)，所见默认分支更新已有数月 |
| ③ [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills) | [26,901](https://api.github.com/repos/JimLiu/baoyu-skills) | [MIT](https://github.com/JimLiu/baoyu-skills/blob/main/LICENSE) | [2026-09-10，`1567581`](https://github.com/JimLiu/baoyu-skills/commit/1567581c26ec29f4216c6e6835415bf30343b0e3)，图像后端模型更新 | [v2.5.2，2026-06-18](https://github.com/JimLiu/baoyu-skills/releases/tag/v2.5.2)；Stars 属于整个技能集合，不是单项信息图技能 |
| ④ [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | [133,723](https://api.github.com/repos/Graphify-Labs/graphify) | [Apache-2.0](https://github.com/Graphify-Labs/graphify/blob/v8/LICENSE) | [2026-10-22，`c588b72`](https://github.com/Graphify-Labs/graphify/commit/c588b72d936927790a87ad009955078ed40562a3)，版本更新；默认分支为 `v8` | [v0.9.94，2026-10-22](https://github.com/Graphify-Labs/graphify/releases/tag/v0.9.94)，近期持续发布 |
| ⑤ [yizhiyanhua-ai/fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph) | [11,828](https://api.github.com/repos/yizhiyanhua-ai/fireworks-tech-graph) | [MIT](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/main/LICENSE) | [2026-10-21，`1ca1ff9`](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/commit/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f)，赞助文档调整 | [v1.2.0，2026-07-17](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/releases/tag/v1.2.0)；另核验到 [2026-09-05 的校验、排版与导出功能更新](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/commit/31fea364eda5f1852b1175f3d9e29ea31d22dcb4)，不把文档提交冒充新功能 |
| ⑥ [coleam00/excalidraw-diagram-skill](https://github.com/coleam00/excalidraw-diagram-skill) | [5,096](https://api.github.com/repos/coleam00/excalidraw-diagram-skill) | **未明确**：API `license: null`；[当前文件树](https://api.github.com/repos/coleam00/excalidraw-diagram-skill/git/trees/main?recursive=1)无 LICENSE，README 未声明 | [2026-03-01，`8646fcc`](https://github.com/coleam00/excalidraw-diagram-skill/commit/8646fcc9f74f38539c6cdb4c969723336a96ddcd)，setup 改进 | [Release API 为空](https://api.github.com/repos/coleam00/excalidraw-diagram-skill/releases?per_page=1)；所见默认分支约七个多月未更新 |

特别校正：Graphify 的数字来自上述正式仓库 API，不采用第三方 `graphiffy` 网站或旧帖的 103k；coleam00 项目是社区技能，不是 `excalidraw/excalidraw-mcp`，不能继承后者或 Excalidraw 主项目的许可证。

## 2. 真实产物与可编辑性

下表能力依据为各项后文链接的 README、技能文件和源码；“可编辑”细分为修改源文件、画布编辑和重新生成，避免混为一谈。

| 候选 | 真实交付 | 可编辑到什么程度 | 是否内建课程前置抽取 |
| --- | --- | --- | --- |
| visual-explainer | HTML 源文件与渲染页面，内含 SVG、分步交互等 | Agent 修改 HTML/SVG；读者可点选、提问和反馈；不等于通用拖拽画布 | 无；内容理解由 Agent 承担 |
| beautiful-mermaid | Mermaid → SVG 或 ASCII/Unicode；编辑器可导出 SVG/PNG | 改 Mermaid 文本与主题后重渲染 | 无；核心是渲染库 |
| baoyu-skills | `baoyu-infographic`：PNG 与分析/提示词；`baoyu-diagram`：独立 SVG | PNG 修改通常需再生成；SVG 可改源代码或用支持 SVG 的编辑器处理 | 无课程专用抽取或验证 |
| Graphify | `graph.json`、交互 `graph.html`、`GRAPH_REPORT.md`，CLI/Skill/MCP 查询 | 结构化图可处理和更新；浏览、搜索不等于完整画布编辑器 | 有通用关系抽取，未内建经验证的课程前置模型 |
| fireworks-tech-graph | SVG 为主文件，另有 PNG、离线交互 HTML、受约束的 GIF | 改 JSON IR 或 SVG；HTML 提供浏览与导出，不应当作节点编辑器 | 无；检查图形结构及特定工程约束 |
| coleam00 技能 | 原生 `.excalidraw` JSON 与预览 PNG | 可在 Excalidraw 中继续编辑节点、文字和连线 | 无；设计方法和视觉检查不等于教学验证 |

## 3. 六组候选的迁移价值与限制

### ① visual-explainer：从工程讲解迁移为交互复习页

准确仓库是 **`nicobailon/visual-explainer`**。当前 v0.14.0 技能要求先写 `.src.html`，再通过配套渲染器生成 HTML；默认手绘 SVG，并支持 stepper、replay、live figure。**Mermaid 目前是用户明确要求或提供其源代码时的选择，不应继续概括为“Mermaid 美化技能”。** 它还提供本地 MCP 的 `visual_explainer_prepare`、`visual_explainer_render_html` 入口。[当前技能](https://github.com/nicobailon/visual-explainer/blob/5f378868e0ea745a6284b51e710c390f0c76f72c/plugins/visual-explainer/SKILL.md) · [原作者 README](https://github.com/nicobailon/visual-explainer#readme)

**适配判断：**对 01—06，更适合解释“输入如何变成输出”“某一步为何能化简”“改变选择信号会发生什么”，而非一开始就画整门课的大网。可将一个已经核对的多路选择器例子做成输入变化、路径高亮和结果说明，让图形随步骤变化。这是建议的课程迁移，不是项目自带数字逻辑教材或已通过本次实测。

读者能选中文字或图中部分提问、评论，再将反馈交给 Agent；修改仍依赖源文件与渲染流程。技能要求检查渲染错误和图像效果，这能发现布局问题，不能证明真值表、公式或前置边正确。生成 HTML 也不自动保证完全离线：实际页面使用的库和资源仍需检查。[交付、反馈与校验规则](https://github.com/nicobailon/visual-explainer/blob/5f378868e0ea745a6284b51e710c390f0c76f72c/plugins/visual-explainer/SKILL.md)

### ② beautiful-mermaid：可靠保留文本源的渲染选择

**`lukilabs/beautiful-mermaid` 的主体是 TypeScript 渲染库与编辑器，不是自动构建知识图的 Agent。** README 列出 flowchart、state、sequence、class、ER、XY 六类图及 SVG、ASCII/Unicode 输出；不应据此承诺兼容全部 Mermaid 图型与语法。配套编辑器的导出源码提供 SVG 和 PNG。[README](https://github.com/lukilabs/beautiful-mermaid#readme) · [编辑器导出实现](https://github.com/lukilabs/beautiful-mermaid/blob/2ac8bbbb060ca0a65a6a21f3200bd99b1587b488/editor/js/export.js)

**适配判断：**若主线程已经有正确的 Mermaid 学习依赖源，它值得作为另一种外观的渲染对照；无需为改视觉而重做课程知识。它不会从 PDF 判定哪些概念必需，也不会因为箭头能渲染就检查依赖真假。仅凭它不能替代交互讲解工作流或图查询层；本轮不把渲染速度等宣传写成实测优势。

### ③ baoyu-skills：必须把 PNG 信息图与 SVG 图解分开

`baoyu-infographic` 会分析内容、生成 `analysis.md`、`structured-content.md` 和提示词，最终交付 `infographic.png`。当前技能明确要求使用栅格图像后端，不能用 SVG/HTML 静默代替；文字错误的处理是修正提示词后再生成等方式，不是把 PNG 当可编辑知识图。[infographic 技能正文](https://github.com/JimLiu/baoyu-skills/blob/1567581c26ec29f4216c6e6835415bf30343b0e3/skills/baoyu-infographic/SKILL.md)

**新发现会影响选型：同仓库还有 `baoyu-diagram`，直接输出独立 `.svg`。** 它覆盖架构、流程、结构、思维导图与概念图，包含布局、箭头和字体规则。因此不能把整个 baoyu-skills 归类为“只有不可编辑图片”。该技能靠 SVG 代码制图，与 infographic 的图像生成后端是两条路径。[diagram 技能正文](https://github.com/JimLiu/baoyu-skills/blob/1567581c26ec29f4216c6e6835415bf30343b0e3/skills/baoyu-diagram/SKILL.md)

**适配判断：**PNG 适合已校对的考前总结卡；需要准确修改反相符号、变量和依赖标签时，优先比较 SVG 路径。SVG 源码可改不等于每个编辑器都会保留全部布局语义。技能的字体示例包含 Google Fonts `@import`，所以“单文件”不能直接写成“所有资源完全离线”。两项技能都未提供数字逻辑前置关系验证器。

### ④ Graphify：真正的通用抽取候选，但不是现成课程先修引擎

正式项目是 **`Graphify-Labs/graphify`**；README 中 Python 包名是 `graphifyy`，命令为 `graphify`。官方文档区分代码 AST 提取和文档语义提取：代码结构可本地解析，文档/PDF/图像内容需要相应解析依赖及语义/视觉后端。README 的核心产物是交互图、结构化 JSON 与报告；源码还提供 stdio MCP 图查询服务。[README](https://github.com/Graphify-Labs/graphify#readme) · [支持输入](https://docs.graphify.com/concepts/supported-inputs) · [架构说明](https://docs.graphify.com/concepts/architecture) · [MCP 源码](https://github.com/Graphify-Labs/graphify/blob/c588b72d936927790a87ad009955078ed40562a3/graphify/serve.py)

**为什么值得入选：**它覆盖了此前渲染工具不负责的“材料 → 实体/关系候选 → 可查询图”。**为什么不能直接视作前置图：**核验的 Codex 抽取规范主要使用 `calls`、`implements`、`references`、`cites`、`conceptually_related_to`、`shares_data_with`、`semantically_similar_to` 等关系；没有给出数字逻辑学习前置的判定准则。[抽取规范](https://github.com/Graphify-Labs/graphify/blob/c588b72d936927790a87ad009955078ed40562a3/graphify/skills/codex/references/extraction-spec.md)

同一规范还有三个对课程应用关键的细节：

- `EXTRACTED` 表示关系在来源中明确出现；其分数固定为 `1.0`。`INFERRED` 等分数是提示词规定的等级，不是经过课程数据校准的正确概率，不能写成“100% 学习依赖正确”。
- `source_file` 必填，但 `source_location` 可以为 `null`；因此不能保证每条边自动带有可核对的课件页码。
- `deep` 模式鼓励更积极地推断间接关系。此时新增的关系应作为待审核候选，不能自动并入确定前置图。

方向也必须明确：源码 `build_from_json` 的默认参数为 `directed=False`，技能提供有向构图选项；构建课程图时应显式保留并检查方向，不从页面有箭头就推定后端已保留先修语义。[构图实现](https://github.com/Graphify-Labs/graphify/blob/c588b72d936927790a87ad009955078ed40562a3/graphify/build.py) · [技能工作流](https://github.com/Graphify-Labs/graphify/blob/c588b72d936927790a87ad009955078ed40562a3/graphify/skill.md)

**代码知识图的精确迁移点：**项目存在 Verilog 提取器，能识别 module、function、task、package import、实例化等结构，并记录文件与行。它可辅助 05—06 的模块代码导航；但 `parent module → child module` 的 `instantiates` 是实现关系，既不等于“学习 child 才能学 parent”，也不证明电路功能或逻辑等价。[Verilog 提取器](https://github.com/Graphify-Labs/graphify/blob/c588b72d936927790a87ad009955078ed40562a3/graphify/extractors/verilog.py)

**建议定位：**先用少量课程材料检查候选边及来源，再另行归类为 `requires`、`related`、`implements`、`cites`。若要进入前置查询，须增加课程范围、成立理由、证据页与审核状态。社区聚类和代码检索能力不能当成课程顺序或教学效果证据。

### ⑤ fireworks-tech-graph：较完整的 SVG 生产与校验工作流

这是原作者 **`yizhiyanhua-ai/fireworks-tech-graph`** 的 Agent Skill，当前技能明确以 SVG 为主产物，PNG、离线 HTML 和支持的 GIF 为导出路线。多数风格可由 JSON 生成，Dark Luxury 路线由 Agent 编写 SVG；不能把所有风格都称为同一确定性生成器。离线 HTML 提供平移缩放、主题、源码复制和多格式导出，并非通用节点编辑器。[README](https://github.com/yizhiyanhua-ai/fireworks-tech-graph#readme) · [技能正文](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f/SKILL.md)

**其可核验优势不只是配色：**版本化 IR 会检查重复 ID、端点引用、坐标和路由数据；SVG 校验覆盖 XML、marker、碰撞、几何与布局预算。该结论已读实现，不只复述 README。[IR 实现](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f/scripts/diagram_ir.py) · [SVG 校验实现](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f/scripts/validate_svg.py)

项目还包含工程语义约束，例如 C4 层级、云部署归属、事件拓扑、运维四个 golden signals。源码的 `semantic_profile` 枚举为 `generic`、`c4-review`、`cloud-fabric`、`event-transit`、`ops-pulse`；**这不是教学前置关系或数字电路功能校验。** 它能拒绝某些工程结构不合规输入，不能证明“必须先会卡诺图才能学某个模块”。[Schema](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f/schemas/diagram-v1.schema.json) · [工程约束实现](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f/scripts/semantic_contracts.py)

**适配判断：**适合已审核的局部依赖、组合模块构成和解题流程，尤其值得与自由编写 SVG 的方案比较长标签、连线和修改后的稳定性。课程图应使用合适的通用模型，不能硬套云架构角色。字体宽度存在启发式估计，技能仍要求看最终 PNG；不能为满足零交叉等几何约束删改真实关系。GIF 路线依赖受支持的语义与运动约束，不能默认任意新课程图都能直接动画化。[输出与视觉检查规则](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f/SKILL.md)

### ⑥ coleam00/excalidraw-diagram-skill：以可编辑白板承载讲解

它是 **Cole Medin 的社区技能**，交付 `.excalidraw` JSON；README 与技能强调用分叉、汇合、时间线等形式表达关系，并在技术图里加入真实代码、数据或示例。技能包含“生成 → PNG 渲染 → 看图 → 修正”的工作流，适合将工程讲解方法迁移到真值表、模块连接和推导示例。[README](https://github.com/coleam00/excalidraw-diagram-skill#readme) · [技能正文](https://github.com/coleam00/excalidraw-diagram-skill/blob/8646fcc9f74f38539c6cdb4c969723336a96ddcd/SKILL.md)

**可编辑性是实际区别：**原生文件保留 Excalidraw 元素，可继续在画布中改字、移动和重连；PNG 只是预览。渲染依赖 Python 3.11+、Playwright 与 Chromium，HTML 模板还从 `esm.sh` 导入 Excalidraw，当前实现不能称为完全离线渲染。[依赖清单](https://github.com/coleam00/excalidraw-diagram-skill/blob/8646fcc9f74f38539c6cdb4c969723336a96ddcd/references/pyproject.toml) · [渲染模板](https://github.com/coleam00/excalidraw-diagram-skill/blob/8646fcc9f74f38539c6cdb4c969723336a96ddcd/references/render_template.html)

**校验边界尤其需要说清：**Python 的 `validate_excalidraw` 主要检查 `type`、非空 `elements` 等基本结构；布局质量主要靠 Agent 看渲染图迭代。技能的“教育性检查”和“证据示例”是设计要求，不是可执行的课程正确性证明。它也没有 fireworks 那一套已核验的通用几何检查链。[渲染脚本](https://github.com/coleam00/excalidraw-diagram-skill/blob/8646fcc9f74f38539c6cdb4c969723336a96ddcd/references/render_excalidraw.py)

**适配判断：**如果复习过程需要本人不断圈画、改布局、补注释，它比只交付 PNG 的方案更直接；若只要快速静态流程图，则不必额外承担完整渲染环境。当前属于公开源码但许可证未明确的候选，不能列作“已确认 MIT 开源技能”。

## 4. 对 01—06 的三条实际搭配建议

以下是基于能力的组合建议，未在本专题运行。它们解决不同问题，不建议一次安装全部工具。

| 目标 | 组合 | 为什么改变或保留原方案 | 比较实际效果时的关键问题 |
| --- | --- | --- | --- |
| 理解一个概念或解题过程 | 已校对的例题/真值表 + **visual-explainer**；Mermaid 保留作静态对照 | 将交互讲解提到前排，补足原目录树与静态依赖图 | 改输入是否真的改变结果；每一步是否说明原因；中文公式与长标签是否清楚 |
| 边讲边改、形成可打印图解 | 同一份内容交给 **fireworks** 输出 SVG；与 **coleam00 原生 Excalidraw** 比较；baoyu-diagram 为另一种 SVG 风格 | 增加工程化 SVG 和原生编辑两条实用路线；不再把 baoyu 全部归为 PNG | 修改一条边/一个变量后的成本；源文件能否继续编辑；布局是否稳定；不要以 PNG 预览冒充可编辑源文件 |
| 从课件找候选联系、按薄弱点查前置 | **Graphify** 提出候选 → 课程关系审核 → Mermaid/Cytoscape 查询或展示 | 新增真实抽取层；保留原方案中已审核关系与图计算的价值 | `related`、`cites`、`instantiates` 是否误入前置图；页码能否回查；方向和替代学习路线是否保留 |

公平比较应复用同一份已核对的 MUX 内容：输入与选择信号、真值表、实现或使用步骤、必要前置、常见错误，并分别检查内容准确、交互是否有教学作用、编辑代价和来源可追溯性。**不能用不同题目、不同信息量的截图直接排“最好看”名次。** 这是本报告建议的评估方法，不是任一工具已完成的课程验证。

对于前置关系，建议统一 `A → B` 为“学习 B 需要先掌握 A”，另存 `type`、`reason`、`source_refs`、`review_status`；资料引用、实现关系和泛相关单独保留。只有已审核 `requires` 子图进入前置闭包计算。若存在可替代路线，应显式记录条件，避免把所有入边都解释为必需。

## 5. 交接与证据边界

用户指定 X 帖的五个候选中，**`cathrynlavery/diagram-design` 与 `tt-a1i/archify` 的 MUX 实测样例见总报告**。另三项 **fireworks、coleam00 技能、visual-explainer** 的当前 Stars、能力、产物、编辑性与限制已在本报告完整覆盖。帖子日期和旧 Stars 未用作当前维护或热度证据。

本报告的完成依据是官网/仓库与源码核验。尚未经本专题实测的是中文字体与公式、实际生成耗时、课程内容准确率、交互效果、导出往返保真度，以及技能在当前宿主中的完整运行。几何检查通过只证明其检查范围内的约束成立；IR 合法只证明结构满足约定；可编辑只证明可以改动；这些都不能单独证明教学关系正确。

**最终调整：保留 markmap/Mermaid 的低成本基础视图，但撤回把它们视为所有复习效果首选的笼统排序。** 交互讲解优先比较 visual-explainer，可编辑图解认真比较 fireworks 与 Excalidraw 技能，材料关系发现重点评估 Graphify；具体效果胜负由主线程同题样例决定。
