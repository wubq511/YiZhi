---
version: 1
slug: "desktop-src-renderer-workspace-tsx"
primary_target: "desktop/src/renderer/workspace.tsx"
related_targets: ["desktop/src/renderer/style.css","desktop/src/renderer/agent-panel.tsx","desktop/src/renderer/source-panel.tsx","desktop/src/renderer/drawings.tsx"]
---

# 桌面学习工作区操作外壳

Mode: Operate。目标为 `desktop/src/renderer/workspace.tsx` 及其左侧入口、顶栏、悬浮工具条与辅助面板。学生以连续阅读、练习为主；选中内容请教 Agent 或请求修改是重点能力。用户已选定结构并授权主代理决定视觉、独立审核，由唯一的 gpt-6.1-terra 子代理实现。

## Direction contract

**THESIS:** 把课程管理、定位、画板操作和学习辅助分别放回稳定位置，让学生在阅读中自然找到下一步。一个常驻左侧菜单栏和一条顶部悬浮工具条组织操作，避免功能模块各自占据顶栏。

**OWN-WORLD:** 浅灰紫操作背景、白纸画板、石墨文字、克制紫色选中态。采用 shadcn/ui Base UI 版的 Nova 密度，统一 Lucide 线性图标、规则中文系统字、细边界和柔和浮影。交互外壳紧凑精致，学习内容继续端正手绘及既有语义配色。强调色只用于选中、焦点和当前主动作。面板开合及菜单栏选中指示连续衔接，尊重减少动态效果。

**STORY:** 打开课程后从目录定位并连续阅读；在左侧切换搜索、目录、笔记和原文，现场保留；选中内容直接提问或修改，在右侧学习对话继续，关闭后回到完整画板。自动保存提供一个可靠状态，失败明确说明影响与实际恢复动作。

**FIRST VIEWPORT:** 顶部为合并系统窗口控制的约 48px 顶栏：交通灯、课程名称菜单、保存状态和右侧学习对话入口同处一行，其下直接开始入口栏与面板。左边约 64px 的菜单栏，搜索图标在最上方，目录/笔记/资料在下面，左侧面板共用一条可拖动宽度（默认约 330px）；学习对话同样可拖动，两处宽度在下次打开时保留。画板顶栏下留有间距的悬浮工具条按中央可用画板居中：阅读/选择/平移，荧光笔/图形二级选择，关系二级菜单，撤销/重做。小地图和缩放/全图在右下角。面板收起归还空间，不主动重置相机。辅助区同时展开空间不足时优先最后主动使用者并保留其他现场。

**FORM:** 用户选择的左侧入口轨（原结构候选第 7 项），按用户修订为可展开/收起的菜单栏，画板工具移至顶部悬浮条。seed:539d357e48446604。用户已批准视觉库与实现，不再进行方案抽选。Operate 使用 code-led。主代理亲自完成最终视觉和行为审核，仅使用用户指定的一个实施子代理。

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 学习对话面板 · Agent 输出层方向合同

**THESIS:** 一条时间线，两层深度。消息流是唯一主角；回答**怎样**产生——推理摘要、每个 `yizhi_*` 工具调用、保存组回执、并发修改的送达——全部收成附着在该条回答上的 Trace 折叠行，按需展开。只有失败和真正可执行的动作才允许打破折叠。面板不再是状态控制台。

**OWN-WORLD:** 沿用外壳的浅灰紫与石墨。过程层只用 `shell-muted` 一族，**不借**条件蓝（＝知识引用与来源入口）与结论青绿（＝答案与验证结果），否则模型推理会被学生读成课程依据。组件语言为 shadcn/ui radix Nova 的对话族原语加 AI Elements pattern 源码（pattern 是复制进仓库的自己代码，非安装包）。

**STORY:** 学生选中一段问「这是什么」：看到自己的提问气泡、一行「已思考 · 展开」、几行人话写的工具调用，然后才是课程依据／补充解释正文；出处以内联引用长在句子里，悬停展开。修改落地那一刻，Trace 行变成「已改 N 处 · 查看实际修改」，画板相机已在跟随——这一行就是整个产品主张的焦点时刻。

**FIRST VIEWPORT:** 面板头只有一行（标题＋合并后的对话列表入口＋收起）。其下 Chat 消息流占满剩余高度，Prompt Input 固定在底部。空状态用一行引导文案，不预置常驻说明、不预置开发信息。

**FORM:** 无方案抽选：视觉世界已由 DESIGN.md 定稿，结构由用户逐轮选定（一条消息流＋默认折叠；思考流式时展开、本段结束自动折叠、事后按需展开；生成子流程收进输入框展开区；出处只保留 Inline Citation 不做 Sources 卡片；纳入 reasoning effort）。seed: none (shaped directly; established world, user-pinned structure)。Operate 走 code-led。

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

### 按真实使用删除（同一条尺子也管组件选型）

删：逐条消息的「消息已保存」（顶栏已聚合）、「旧版原消息 · 未记录任务关联」（开发核对）、`unitId`／正文版本号／`operationId`／`changedObjectIds`（内部 ID）、「本机 Codex CLI · 已连接」＋版本＋路径、常驻「草稿已保存」（仅留未保存）、「引导／排队」常驻下拉（PRODUCT.md 定义为设置项，移入课程设置）、`.agent-task` 灰底平铺块。
移位：「加入画板」从提交前意图改为该条回答的尾部动作；停止／核对／继续合成一个条件化动作行；生成小主题整块收进展开区。
不加：avatar、sheet／drawer、context-menu、skeleton／spinner、hover-card 之外的第二处浮层、Confirmation（PRODUCT.md 明确不加「先预览再采纳」门槛）、Terminal／File Tree／Test Results／Subagent／Stack Trace（沙箱禁用 shell 与 apply_patch，无真实数据源）。

### 不可动的既有契约

草稿与保存协议、`useSaveReport` 通道、驱动画板相机的 `onMutation` 回调、窄窗焦点陷阱、搜索跳转定位、课程内容与 SQLite 语义、出处可定位 PDF。只按实际持久化结果显示状态；不伪造 token 级速度；不把开发核对变成学生按钮。

## 验收边界

正常阅读、菜单切换、二级菜单展开、Agent 打开、窄窗口、键盘焦点及失败状态都需要看真实渲染。覆盖 1440×900 与 1024×768 桌面，以及现有窄窗口行为；不开展 Windows 实机/打包。保持课程身份、内容、编辑与保存协议、个人状态、独立手动备份/历史恢复语义。只按实际持久化结果显示保存状态，不把错误降级为会消失的 toast。图形箭头与正式关系分开。撤销遵守实际编辑上下文，不假装全局历史恢复。原始课程、个人数据库与日常安装不作为破坏性测试目标。

学习对话另需看：流式接收中、推理展开与自动折叠、工具行展开、思考块展开时视口锚点不跳、已排队／等待整合、部分完成、失败、已停止、结果未知待核对、执行器缺失、草稿未保存、窄窗模态。典型 1–3 轮、长会话约 20 条、每次回答 1–6 个工具调用、出处附件上限 8 个。

实现接入 Tailwind 时应保护现有正文/编辑器样式免受全局重置影响。屏幕固定控件不进入画板缩放层。数据加载/搜索/草稿状态不能因面板关闭而无意丢失。实现前及收尾分别对照 PRODUCT.md、系统设计定稿和 DESIGN.md；现有底层功能继续由正式服务接口承担。本任务证据统一在原仓库 `artifacts/evidence/modern-workspace-shell/`。
