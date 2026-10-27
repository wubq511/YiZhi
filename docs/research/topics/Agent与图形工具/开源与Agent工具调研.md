# 数字逻辑复习知识依赖图：开源项目、Agent Skills 与 MCP 调研

调研日期：**2026-10-24，Asia/Shanghai**。GitHub 元数据为当日直接读取 API 的快照；下文提交、发布日期统一使用 **UTC**。研究方式：官网、仓库 README、许可证、关键源码和 GitHub API；未运行 demo，未安装工具，未使用其他子 Agent，未查询 X。

期中范围按用户确认限定为 **01—06**：简介、进制与码制；逻辑代数；卡诺图；组合逻辑分析与设计；组合模块 1 与代码；组合模块 2 与代码。章节名称已与本地课件文件名和[资料说明](../../../../courses/digital-logic/资料说明.md)对照。本报告评估工具适配，不声称已经逐页抽取或审核课程依赖关系。

## 结论与选型

**本轮复习优先采用“markmap 章节导航 + Mermaid 前置关系图”；需要回答“我还缺哪些前置知识”时，再用 Cytoscape.js。** Obsidian Skills 适合长期积累带来源的概念卡片；draw.io 与 Excalidraw 适合作为可编辑的讲解输出。React Flow 已核验，但仅在确实要开发节点编辑器时进入下一轮。

筛选保留六组核心候选：**draw.io MCP、Excalidraw MCP、Obsidian Skills、markmap、Mermaid、Cytoscape.js**。Excalidraw 在同一组内比较官方与一个社区实现；React Flow 单列为未进入首选的备选，避免把不同层次的工具堆成清单。

关键边界是：**渲染图、操作画布、解析 Markdown 层级、从教材识别学习前置关系，是四种不同能力。** 核验到的这些项目都没有提供足以直接认定“自动抽取出的数字逻辑前置关系正确”的证据。MCP 连接绘图工具，Skill 教 Agent 使用格式；概念识别、关系判断和课程来源核对仍须由上层流程承担。以下“适配”“迁移”“建议”均为基于所引能力的研究判断，不是实测结果。

## 1. 仓库、许可证与维护快照

Stars 只表示关注度快照，不证明正确性、学习效果或维护质量。下表 Stars 链接指向对应仓库 API 的 `stargazers_count` 来源。默认分支提交与 Release 分别核验；没有 GitHub Release 不代表没有 npm 发布，`updated_at` 也不当作代码维护证据。表内仓库当次 API 均为 `archived: false`。

| 核心候选 / 仓库 | Stars，2026-10-24 快照 | License 证据 | 默认分支最新提交，UTC | GitHub Release / 维护判断 |
| --- | ---: | --- | --- | --- |
| ① [jgraph/drawio-mcp](https://github.com/jgraph/drawio-mcp) | [5,697](https://api.github.com/repos/jgraph/drawio-mcp) | [Apache-2.0 正文](https://github.com/jgraph/drawio-mcp/blob/main/LICENSE) | [2026-10-22，`05c1747`](https://github.com/jgraph/drawio-mcp/commit/05c17479ec84157266cb36017dbd50a908e9c8ac)：标签间距修复 | [Release API 返回空列表](https://api.github.com/repos/jgraph/drawio-mcp/releases?per_page=2)；近期有具体修复，不能因无 Release 判定停更 |
| ②a [excalidraw/excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp)，官方 | [5,564](https://api.github.com/repos/excalidraw/excalidraw-mcp) | README、[package.json](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/package.json)声明 MIT；未见独立 LICENSE 正文，API `license: null` | [2026-03-24，`157aa23`](https://github.com/excalidraw/excalidraw-mcp/commit/157aa23ceb1976008aadc89eb05e3444060f09d6)：移动端全屏及导出按钮修复 | [v0.3.2，2026-02-09](https://github.com/excalidraw/excalidraw-mcp/releases/tag/v0.3.2)；所见代码更新已间隔约 7 个月，不能据此断言托管服务停止维护 |
| ②b [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)，社区对照 | [2,566](https://api.github.com/repos/yctimlin/mcp_excalidraw) | [MIT 正文](https://github.com/yctimlin/mcp_excalidraw/blob/main/LICENSE) | [2026-10-22，`774a70c`](https://github.com/yctimlin/mcp_excalidraw/commit/774a70c1b3f0c7b9901fbbbf66b432d1a8dbbfe7)：自托管分享目标可配置 | [v2.1.2，2026-10-04](https://github.com/yctimlin/mcp_excalidraw/releases/tag/v2.1.2)；有近期发布与功能提交 |
| ③ [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | [49,972](https://api.github.com/repos/kepano/obsidian-skills) | [MIT 正文](https://github.com/kepano/obsidian-skills/blob/main/LICENSE) | [2026-09-15，`3ccff53`](https://github.com/kepano/obsidian-skills/commit/3ccff5338ea700537839b21900aa5358a0402c98)：合并技能描述文档修改 | [Release API 返回空列表](https://api.github.com/repos/kepano/obsidian-skills/releases?per_page=2)；它是技能文件集合，应观察指令文件演进，而非要求应用式发版 |
| ④ [markmap/markmap](https://github.com/markmap/markmap) | [13,190](https://api.github.com/repos/markmap/markmap) | [MIT 正文](https://github.com/markmap/markmap/blob/master/LICENSE) | [2026-09-12，`122bf05`](https://github.com/markmap/markmap/commit/122bf0500ee7aca4f023c2465f7e26bf023eec52)：JSON 选项支持 autoFit | [v0.18.0，2024-12-19](https://github.com/markmap/markmap/releases/tag/v0.18.0)；GitHub Release 较旧，但默认分支仍有修复，且 [CLI 包清单已为 0.18.12](https://github.com/markmap/markmap/blob/122bf0500ee7aca4f023c2465f7e26bf023eec52/packages/markmap-cli/package.json)，不可混同这三种版本信号 |
| ⑤ [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) | [90,827](https://api.github.com/repos/mermaid-js/mermaid) | [MIT 正文](https://github.com/mermaid-js/mermaid/blob/develop/LICENSE) | [2026-10-19，`6d8921f`](https://github.com/mermaid-js/mermaid/commit/6d8921f94f9a12b76586eddcf45a566080d4767e)：合并 flowchart 边 ID 空白处理修复 | [mermaid@12.2.0，2026-10-13](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.2.0)；近期发布与具体修复均可见 |
| ⑥ [cytoscape/cytoscape.js](https://github.com/cytoscape/cytoscape.js) | [11,247](https://api.github.com/repos/cytoscape/cytoscape.js) | [MIT 正文](https://github.com/cytoscape/cytoscape.js/blob/unstable/LICENSE) | [2026-10-15，`9aab1b4`](https://github.com/cytoscape/cytoscape.js/commit/9aab1b4489645c15e82fce71fdce738f58d8165d)：更新版本文档 | [v3.34.4，2026-10-15](https://github.com/cytoscape/cytoscape.js/releases/tag/v3.34.4)；有近期版本发布；默认分支名为 `unstable`，不把默认分支直接等同稳定发行包 |

这些时间是“本次实际看到的维护信号”，不是维护者响应速度或质量评分。License 指所列仓库，不外推为 Obsidian 应用、Excalidraw+ 服务或第三方扩展的许可证。

## 2. 六组候选：能力、跨领域迁移与局限

### ① draw.io MCP：把工程制图流程迁移为复习讲解图

**身份已核实：`jgraph/drawio-mcp` 是官方项目。** draw.io 官网直接链接该仓库，并列出 MCP App、MCP Tool Server 和 Skills/Plugins 三类入口；不能把搜索到的任意 drawio MCP 都视为官方。[官网入口](https://www.drawio.com/mcp/)

仓库区分四种使用方式。MCP App 的 `create_diagram` 接收 XML 或 Mermaid；Tool Server 支持 XML、CSV、Mermaid；插件可产生原生 `.drawio` 文件，图片或 PDF 导出依赖本地 draw.io Desktop。`search_shapes` 是图形库检索，`get_drawio_reference` 是格式指导，均不是教材检索或知识抽取工具。[官方 README](https://github.com/jgraph/drawio-mcp#readme)

**迁移价值：**借用软件架构图、流程图的“节点—带标签的边—分组”，画出概念、题型和前置技能；若一页需要同时放模块示意、推导步骤和依赖箭头，原生可编辑画布较合适。可把已审核的 Mermaid 图导入后人工整理，用于复习讲解或打印。

**局限与取舍：**XML/画布编辑能力不等于依赖查询。课件中的电路线表示信号连接，学习图中的箭头表示前置要求，两者必须分层。当前目标若只是维护 01—06 的小型依赖图，直接写 Mermaid 的成本通常更低；需要精细排版时才增加 draw.io。未验证中文排版、往返转换和导出效果。

### ② Excalidraw：官方 MCP 用于交互讲解，社区实现用于持续编辑工作台

**官方仓库必须认准 `excalidraw/excalidraw-mcp`。** 除仓库归属外，Excalidraw 自有域名文档明确把它列为开源 MCP；同页说明 Excalidraw+ MCP 是连接 Plus workspace 的另一项服务，目前为 public beta。官方开源端点为 `https://mcp.excalidraw.com`；Plus 文档端点为 `https://api.excalidraw.com/api/v1/mcp`，两者不应混写。[官方 Plus 文档的仓库交叉引用](https://plus.excalidraw.com/docs/mcp) · [开源仓库 README](https://github.com/excalidraw/excalidraw-mcp#readme)

| 对照点 | 官方 `excalidraw/excalidraw-mcp` | 社区 `yctimlin/mcp_excalidraw` |
| --- | --- | --- |
| 定位 | 支持 MCP Apps 的宿主内流式绘图、镜头移动、全屏交互编辑 | 持续运行的画布工作台，提供 CLI、MCP、REST 与 Agent Skill |
| 编辑方式 | 模型可用 `read_me`、`create_view`；支持 checkpoint 恢复、追加和删除，保留用户编辑状态 | 文档列出元素级增删改查、截图、布局操作、快照与文件导入导出 |
| 导出与持久化 | 源码含由 widget 调用的导出和 checkpoint 工具；不能说“完全不能导出” | 文档支持 `.excalidraw` 和 Obsidian `.excalidraw.md`；适合把图作为项目文件保存 |
| 复习用途 | 一边解释概念关系，一边分步展开，学生再手改 | 多轮修订同一张图，Agent 截图检查遮挡后继续调整 |

官方能力依据是直接读取的 [server.ts 固定提交](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/server.ts)：`create_view` 支持 `restoreCheckpoint` 和删除标记；`export_to_excalidraw`、`save_checkpoint`、`read_checkpoint` 标记为 app 可见。社区能力来自其[自身 README](https://github.com/yctimlin/mcp_excalidraw#readme)，属于文档声称，未实测。**不照搬社区比较表对官方“一次性出图”的概括。**

**迁移价值：**把白板上的架构讲解迁移为“概念关系讲解—追问—改图”。这种交互适合澄清为什么一个概念需要另一个概念，而不是一次展示全课程大图。

**局限与取舍：**画布元素之间的连线并不自带 `prerequisite` 语义，也不自动计算未掌握的全部前置项。官方版公开源码近期更新较少，MIT 声明与缺少独立 LICENSE 正文的情况须如实保留，不能借用 Excalidraw 编辑器本体的许可证来补证。[README 许可声明](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/README.md) · [package.json](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/package.json) · [该提交完整文件树](https://api.github.com/repos/excalidraw/excalidraw-mcp/git/trees/157aa23ceb1976008aadc89eb05e3444060f09d6?recursive=1)

### ③ kepano/obsidian-skills：把个人知识管理迁移为可追溯的概念卡片

它是遵循 Agent Skills 格式的**技能集合**，不是 MCP，也不是独立知识图谱引擎。README 列出 `obsidian-markdown`、`obsidian-bases`、`json-canvas`、`obsidian-cli`、`defuddle`、`knap`。与本任务直接相关的是 Markdown 概念笔记和 JSON Canvas 连线；没有必要为复习一次启用全部技能。[仓库 README](https://github.com/kepano/obsidian-skills#readme)

`obsidian-markdown` 教 Agent 编写属性、wikilink、嵌入和 Markdown；`json-canvas` 教它维护节点、边及引用完整性。JSON Canvas 规范有 `fromNode`、`toNode`、箭头端点和 `label`，能够表达有向、带标签的连接，并引用文件或笔记块。[Markdown Skill](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/obsidian-markdown/SKILL.md) · [Canvas Skill](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/json-canvas/SKILL.md) · [JSON Canvas 1.0 规范](https://jsoncanvas.org/spec/1.0/)

**迁移价值：**每个概念一张卡，保存定义、前置技能、典型错题、教材页与课件页；Canvas 只负责把这些卡片连接起来。跨领域可复用的是知识卡片和来源管理，而不只是 Obsidian 外观。多父节点能用多条边表示，不必把概念重复塞进目录树。

**局限与取舍：**普通 wikilink 只证明“笔记链接”，不自动证明“学习前置”。Canvas 规范没有内建课程依赖、证据、置信度字段，应把这些语义保存在笔记或独立边表，再映射为画布标签。`defuddle` 只是网页正文清洗，不能据其“extract”一词宣称能从教材推导依赖。[Defuddle Skill 源文](https://github.com/kepano/obsidian-skills/blob/3ccff5338ea700537839b21900aa5358a0402c98/skills/defuddle/SKILL.md)

还有一个小而有用的规范差异：该 Canvas Skill 建议 16 位十六进制 ID，但 JSON Canvas 规范只要求唯一字符串；迁移时应区分技能约定与格式硬要求。对本次期中复习，若尚未使用 Obsidian，不必仅为画图迁移全部资料。

### ④ markmap：把文档大纲迁移为复习导航，不作为依赖图底座

官方定义非常明确：解析 Markdown 已有的层级结构，再渲染交互式思维导图；`markmap-lib` 处理数据，`markmap-view` 渲染 SVG。它的自动化是**结构解析**。[官方说明](https://markmap.js.org/docs/markmap)

**迁移价值：**把 01—06 作为一级分支，向下放概念、典型题和来源链接，利用折叠、缩放、节点宽度与初始展开层级控制做快速扫盲和范围核对。[配置文档](https://markmap.js.org/docs/json-options)

**局限与取舍：**层级树不适合作为多对多学习依赖的唯一表示：同一概念同时支撑多个后续知识点时，重复写入多个分支会丢失统一身份；章节归属也不等于先修关系。应把 markmap 定位为目录投影，把跨章节依赖交给 Mermaid 或 Cytoscape.js。上游 README 虽链接第三方 MCP/技能，但“被列入 Related Projects”不等于官方实现，也不证明增加了知识抽取能力；本报告不扩大候选名单。[仓库 README](https://github.com/markmap/markmap#readme)

### ⑤ Mermaid：把软件文档中的 diagrams-as-code 迁移为可审查依赖图

Mermaid flowchart 支持节点、箭头、边标签和子图，可直接表达一个知识点具有多个前置节点。源文本适合比对修改；节点可以关联链接或回调，但交互受宿主及 `securityLevel` 配置约束，不能假定所有 Markdown 预览器都能点击跳转。[Flowchart 官方语法](https://mermaid.js.org/syntax/flowchart.html)

**迁移价值：**采用 `flowchart` 表达前置关系，按 01—06 或学习目标分组；每次只展示一个主题及其必要前置知识。相较于思维导图的树结构，这能保留共享前置节点，并清楚标出关系类型。作为 Agent 输出，文本差异比大段画布坐标更容易审查。

**局限与取舍：**Mermaid 是声明式图形语言，不是关系抽取器或通用图查询库。它会画出给定边，不会证明某条边在课程中成立；能画有向图也不意味着自动验证为 DAG。学习状态筛选、全部前置项查询、来源检查需要上层数据处理。布局可读性和中文长标签仍待实际 demo 验证。

版本也会影响展示。当前官网为 12.2.0，文档说明 12.x flowchart 默认布局等行为已有改变；嵌入宿主可能仍带旧版。比较 demo 时应记录实际使用版本，而不是把官网当前行为泛化给所有平台。[Flowchart 默认配置说明](https://mermaid.js.org/syntax/flowchart.html#default-theme-look-and-layout-v12-0-0) · [12.2.0 发布](https://github.com/mermaid-js/mermaid/releases/tag/mermaid%4012.2.0)

### ⑥ Cytoscape.js：把生物网络与图分析迁移为学习依赖查询

这是六组里最贴近“关系计算”的候选：它同时提供图数据模型、可选渲染器和图算法，原项目明确面向生物数据、社会网络等关系数据，而不限于这些领域。[仓库说明](https://github.com/cytoscape/cytoscape.js#readme)

官方 API 的 `nodes.predecessors()` 查递归上游，`nodes.successors()` 查递归下游；还有有向搜索及 Tarjan 强连通分量算法。因此可以在已经确认的学习依赖图上实现“复习这个目标还缺什么”“一个基础概念薄弱会影响哪里”和依赖循环检查。[遍历 API](https://js.cytoscape.org/#collection/traversing) · [强连通分量 API](https://js.cytoscape.org/#eles.tarjanStronglyConnected)

**迁移价值：**生物网络里对节点邻域、路径、属性和子图的分析，可迁移为概念关系、掌握状态和复习范围筛选。无需把“生物学本体”搬进数字逻辑，只复用图模型与查询方法。

**局限与取舍：**它不从 PDF 自动生成概念或判断边是否为先修关系，也不是现成复习应用；来源面板、状态编辑、文件保存等界面需要开发。图上的度数或 PageRank 不是考试重要性，最短路径也不是“学会目标所需的全部前置项”。这里推荐的是查询能力，不是自动学习规划。

一个与实现直接相关的细节：`predecessors(selector)` 的 selector 过滤返回结果，不等于限制遍历只经过某类边。应先构建只含已审核 `requires` 边的图，或在相应边集上执行有向搜索，再计算前置集合；不要混入“相关”“同一章节”等边。`ancestors()` 对应复合节点的包含层级，也不应拿来代替学习前置查询。[遍历与复合节点 API](https://js.cytoscape.org/#collection/traversing)

## 3. 已核验但暂不进入首选：xyflow React Flow

[xyflow/xyflow](https://github.com/xyflow/xyflow) 的 React Flow 是节点界面库，适合拖拽、连线、自定义节点和交互编辑。它的 MIT 核心与 Pro 服务须区分；仓库同时包含 React Flow、Svelte Flow 和共享库，所以仓库 Stars 不是单独某个 npm 包的使用量。[README](https://github.com/xyflow/xyflow#readme) · [MIT 正文](https://github.com/xyflow/xyflow/blob/main/LICENSE)

本次快照为 [38,759 Stars](https://api.github.com/repos/xyflow/xyflow)；默认分支最新提交为 [2026-10-22，`8523d8d`](https://github.com/xyflow/xyflow/commit/8523d8dd9f1551954bc221dccabd6a3119ef9e22)；React 包对应发布为 [@xyflow/react@12.12.0，2026-09-24 UTC](https://github.com/xyflow/xyflow/releases/tag/%40xyflow/react%4012.12.0)。这三项均已直接核验。

**推迟采用的原因是任务适配，而非项目质量：**当前主要问题是组织和查询前置关系，暂未要求制作带表单、按钮和拖拽编辑的完整应用。React Flow 官方明确把自动布局交给 Dagre、ELK 等外部库；防止成环也需要用校验回调实现，官方提供了示例。[布局说明](https://reactflow.dev/learn/layouting/layouting) · [防环示例文档](https://reactflow.dev/examples/interaction/prevent-cycles)

若后续目标变为“每张知识卡直接编辑掌握度、题目和关系”，React Flow 值得重新入选；依赖语义、图查询和来源模型仍需自行实现。此时可以让它负责编辑界面，但不必一开始同时维护 React Flow 与 Cytoscape 两套画布。

## 4. 三条可落地搭配方案

### 方案 A：本次期中优先——markmap + Mermaid + 带来源的关系表

**目标：最快形成能复习、能查错的 01—06 知识导航。**

1. 以教师 01—06 课件及对应作业建立章节目录，markmap 展示范围与概念索引。
2. 单独维护概念与关系表；每条前置关系记录方向、成立理由和课件页 / 教材页，暂不确定的边不混入确定依赖。
3. 从同一关系表生成分主题 Mermaid flowchart，保留共享前置节点；课程顺序只用作章节分组，不直接全部连接成先修链。

**产物与验收：**一个课程导航、若干局部依赖图、可追溯边表；抽查一条边时能回答“为什么要先会这个”和“证据在哪”。成本判断为低，主要工作量在课程关系核对。markmap 的层级解析与 Mermaid 的一般有向连线分别有[官方依据](https://markmap.js.org/docs/markmap)和[官方语法依据](https://mermaid.js.org/syntax/flowchart.html)；将它们组合为两个视图是本报告建议。

### 方案 B：长期积累——Obsidian Skills + 概念卡片 + JSON Canvas

**目标：让依赖图能持续连到定义、例题、错题和来源。**

每个概念保留稳定 ID 和一张 Markdown 卡片；Agent 使用 `obsidian-markdown` 维护笔记，用 `json-canvas` 组织关系视图。`requires`、`related`、`applies_to` 等关系保存在属性或边表中，Canvas 标签作为展示；用来源和审核状态约束 Agent 增边。必要时在笔记中嵌入 Mermaid 局部图。

**产物与验收：**点击图中概念能回到解释与题目；更新概念卡后无需重写多份内容；多条入边能指向同一概念身份。成本判断为中，适合已有 Obsidian 使用习惯或准备跨课程复用时。文件格式与技能写入能力有[仓库技能](https://github.com/kepano/obsidian-skills#readme)和[JSON Canvas 规范](https://jsoncanvas.org/spec/1.0/)支持，但前置语义约定是新增的课程层设计。

### 方案 C：按薄弱点复习——Cytoscape.js + 审核后的依赖数据 + 可选讲解画布

**目标：输入一个不会的目标，得到全部必要前置项及薄弱点。**

让 Cytoscape.js 读取方案 A / B 的概念与边数据，只对已审核的 `requires` 子图计算前置闭包、影响范围和循环；结合掌握状态筛选需要复习的节点。需要讲解某个局部时，再把该子图交给 **draw.io MCP 或官方 Excalidraw MCP 二选一**：前者便于精细编辑，后者适合逐步展开与白板追问。两者均为可选输出端，不承担关系计算。

**产物与验收：**选择一个目标可显示全部直接与间接前置，而非仅一条最短路径；“相关”边不改变前置结果；图上每条依赖能回溯证据。成本判断为中到高，值得在出现真实查询需求后开发。查询、绘图能力分别来自 [Cytoscape API](https://js.cytoscape.org/#collection/traversing)、[draw.io 官方说明](https://www.drawio.com/mcp/)和 [Excalidraw 源码](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/server.ts)，组合架构为本报告建议，尚未实测。

## 5. 跨领域迁移应保留什么

**最值得迁移的是“概念身份、边的语义、证据、查询与视图分离”，不是某一种图形风格。** 以下是本任务建议的数据约定，不是声称某个候选已经内建这些能力。

| 对象 | 最小内容 | 解决的问题 |
| --- | --- | --- |
| 概念 | `id`、`label`、`chapter`、`source_refs`、`mastery` | 同一概念出现在多个章节 / 视图时仍保持同一身份 |
| 依赖边 | `source`、`target`、`type`、`reason`、`source_refs`、`review_status` | 区分真实前置、章节归属、实现方式和泛相关 |
| 来源 | 文件路径、课件 PDF 页序、教材书页与 PDF 页序 | 能定位依据，避免把 OCR 文本位置当成教材页码 |
| 展示信息 | 坐标、颜色、分组、折叠状态 | 换渲染器不改变课程知识内容 |

方向统一约定为 **`A → B` 表示学习 B 需要先掌握 A**。只对严格 `requires` 关系检查 DAG；“相关”关系可以有环。若出现不同学习路线中的替代前置，应显式记录路线或 OR 条件，不能把两条入边一概理解为都必需。

对 01—06 的具体落地，可以先分别整理章节树和局部依赖，例如逻辑代数、卡诺图、组合逻辑设计之间的概念连接，再逐条核对教师资料。这只是待核对的结构示意：不能因为课件编号相邻，就认定存在严格前置；不能把某种电路实现使用了某模块，就自动认定学习该模块是唯一先修路线。

本地资料还提示第 04 次作业存在额外网页补充要求，第 06 次作业包含被引用的前置函数题页。构建概念—题目—来源链时应保留这些联系；这类联系先标为“题目引用 / 资料引用”，经课程判断后才可转成学习依赖。[本地资料说明](../../../../courses/digital-logic/资料说明.md)

自动化流程建议是：**读取课程材料 → 提出概念与关系候选 → 附来源和理由 → 人工核对 → 生成多种视图**。现有工具主要覆盖最后一步、部分结构化编辑和图计算；缺失的课程语义判断不能用 MCP 名称、技能宣传或 Stars 补足。

## 6. 证据边界与交接

本报告已完成六组核心候选及 React Flow 备选的官网 / 仓库核验，核查了 Stars、许可证证据、默认分支提交和 GitHub Release。官方 Excalidraw 与社区实现、官方开源 MCP 与 Plus MCP、开源库与托管 / Pro 服务均已区分。

实际 demo 由主 Agent 另行运行。尚未验证的是：中文长标签与公式表现、节点密集时的可读性、嵌入宿主的版本和点击能力、导出再编辑的保真度、特定规模的性能。本文没有把 README 功能声明写成这些项目已经通过实测的结论。

主 Agent 另提供了两条通过 Robert 已登录 Chrome 读取的 X 证据；本专题研究未独立打开或查询，主 Agent 的直接读取记录见总报告：

- [Excalidraw 官方帖](https://x.com/excalidraw/status/2021284377506742331)：主 Agent 读取的日期为 2026-02-11、内容为官方 MCP 发布、约 6.2k likes。官方仓库身份已由官网文档和 GitHub 另行核实，不依赖点赞量。
- [Ben Dicken 帖文](https://x.com/BenjDicken/status/2107319845905944997)：主 Agent 读取的日期为 2026-10-06，展示实际学习讲解后再编辑的用法。它可作为交互复习场景线索，不是依赖关系自动抽取正确性或学习效果的验证。

