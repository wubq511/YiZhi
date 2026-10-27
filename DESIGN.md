---
name: 绎知 YiZhi
description: 简约的操作外壳，端正的手绘学习内容。
colors:
  paper: '#fff'
  edit-paper: '#fffefa'
  ink: '#27343e'
  muted: '#68717a'
  border: '#e5e5eb'
  surface: '#f6f6f9'
  purple: '#6965db'
  focus: '#eeedff'
  blue: '#345d88'
  blue-line: '#7798bc'
  blue-fill: '#f0f5fc'
  green: '#286b58'
  green-line: '#5f967e'
  green-fill: '#edf7f1'
  amber: '#79551f'
  amber-line: '#bc9a5b'
  amber-fill: '#fff7e5'
  ui-muted: '#626b79'
  ui-muted-tint: '#5f6479'
  ui-placeholder: '#687080'
  course-priority: '#5c6f80'
  learning-reminder: '#8f4e2e'
  learning-reminder-line: '#c58d74'
  learning-reminder-fill: '#fff4ec'
  learning-assist: '#2f6f73'
  learning-assist-line: '#8fb9b6'
  learning-assist-fill: '#edf7f6'
  review-weak: '#92516d'
  review-weak-fill: '#fbf2f6'
  review-mastered: '#286b58'
  review-mastered-line: '#5f967e'
  review-mastered-fill: '#edf7f1'
  personal-note: '#79551f'
  personal-note-line: '#bc9a5b'
  personal-note-fill: '#fff7e5'
  content-draft: '#52677a'
  content-draft-line: '#b6c3cf'
  content-draft-fill: '#f4f7fa'
  system-info: '#41627e'
  system-info-line: '#a9bdce'
  system-info-fill: '#f0f5fa'
  system-danger: '#a13737'
  system-danger-line: '#d9a3a3'
  system-danger-fill: '#fdf0f0'
typography:
  canvas-theme:
    fontFamily: ReviewExcalifont, PrototypeXiaolai, "Kaiti SC", "PingFang SC", sans-serif
    fontSize: 50px
    fontWeight: 400
    lineHeight: 1.4
  canvas-title:
    fontFamily: ReviewExcalifont, PrototypeXiaolai, "Kaiti SC", "PingFang SC", sans-serif
    fontSize: 34px
    fontWeight: 400
    lineHeight: 1.5
  canvas-lead:
    fontFamily: ReviewExcalifont, PrototypeXiaolai, "Kaiti SC", "PingFang SC", sans-serif
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.85
  canvas-body:
    fontFamily: ReviewExcalifont, PrototypeXiaolai, "Kaiti SC", "PingFang SC", sans-serif
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.85
  title:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: 21px
    fontWeight: 600
  body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: .875rem
    fontWeight: 400
  label:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: .75rem
    fontWeight: 400
  math:
    fontFamily: KaTeX_Main, KaTeX_Math, serif
    fontSize: 1.08em
  mono:
    fontFamily: ui-monospace, SFMono-Regular, Consolas, monospace
    fontSize: .875rem
    lineHeight: 1.8
  control:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: .8125rem
    fontWeight: 400
  prose:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.85
  table-body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: 21px
    lineHeight: 1.65
    fontFeature: '"tnum" 1'
  table-head:
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: 19px
    lineHeight: 1.65
rounded:
  sm: 6px
  control: 8px
  md: 9px
  panel: 11px
  lg: 12px
  dialog: 14px
  compact-control: 7px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '#3f454d'
    rounded: '{rounded.control}'
    padding: 7px 12px
    typography: '{typography.label}'
  button-secondary-hover:
    backgroundColor: '#f6f5ff'
    textColor: '#514db5'
  button-primary:
    backgroundColor: '{colors.focus}'
    textColor: '{colors.purple}'
    rounded: '{rounded.compact-control}'
    padding: 6px 13px
  button-primary-hover:
    backgroundColor: '#e7e4ff'
    textColor: '{colors.purple}'
  input-search:
    backgroundColor: '#f8f8fa'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: 8px 10px
    height: 40px
    typography: '{typography.control}'
  nav-item-active:
    backgroundColor: '{colors.focus}'
    textColor: '{colors.purple}'
    rounded: '{rounded.sm}'
    padding: 7px 8px 7px 17px
    typography: '{typography.control}'
  chip-scope:
    backgroundColor: '#fbfbfc'
    textColor: '{colors.ui-muted}'
    rounded: 16px
    padding: 5px 10px
    typography: '{typography.label}'
  card-reading:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: 0px
    padding: 35px 38px 28px
  card-condition:
    backgroundColor: '#f1f6fb'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: 13px 16px
  card-conclusion:
    backgroundColor: '#f0f8f3'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: 13px 16px
  material-disclosure:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.blue}'
    rounded: '{rounded.sm}'
    padding: 13px 4px
  editing-toolbar:
    backgroundColor: '{colors.edit-paper}'
    textColor: '{colors.blue}'
    rounded: '{rounded.panel}'
    padding: 7px
  personal-note-disclosure:
    textColor: '{colors.personal-note}'
    backgroundColor: '{colors.personal-note-fill}'
    rounded: '{rounded.sm}'
  learning-reminder:
    backgroundColor: '{colors.learning-reminder-fill}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
    padding: 13px 16px
---

# Design System: 数字逻辑复习画板

## Overview

**Creative North Star: "手帐推演"**

在一张安静的白纸上组织清楚的推演。顶栏、目录、表单和侧栏是低干扰的操作外壳；知识正文、图示、关系和个人标注承载手绘个性。简约意味着操作克制、信息层级明确，同时备齐必要的讲解、条件与题解。

屏幕坐标中的界面使用 PingFang、细边界、小圆角和淡紫交互状态；画板世界中的学习内容由 Excalifont 承担拉丁字符、Xiaolai 承担中文，配合稳定的 Rough.js 线条和浅底语义色。MathLive 使用本地 KaTeX 数学字形。共享的石墨文字与留白把操作区和阅读区连接起来。

远景、单元全览和正文阅读改变信息密度，保持知识身份与阅读顺序。主题总览可按画板可用宽度重新分列；单元正文仍使用稳定的局部坐标。动效解释相机、面板、消息与展开反馈；边框种子保持稳定。

**Key Characteristics:**
- 白色画布、浅色系统控件、端正排版。
- 拉丁手写、中文手写和专业数学字形各司其职。
- 操作状态、课程语义、个人内容与系统异常有明确的色彩分工。
- 屏幕界面与画板世界使用独立字号尺度。
- 浮动层轻量，焦点可见，动效尊重减少动态效果设置。

本次记录以 `legacy/review-board/web/` 的最终样式覆盖、`app.js` 与真实页面采样为准；继承样式来自 `experiments/content-depth-prototype/style.css`，不能只读原型前段规则推断现状。2026-10-27 的复验见 [audit-fixes 验收记录](legacy/review-board/验收/audit-fixes-2026-10-27/results.json)。本文记录可复用规则，不将一次性的样式字面量全部提升为设计 token。

## Colors

颜色先说明操作或学习含义。当前是一套浅色主题；同一色系可由不同语义 token 引用，但不得因此合并其业务含义。具体值以 frontmatter 为准。

### Primary
- **交互紫 / 聚焦淡紫**（`purple` / `focus`）：选中、当前导航、主要提交和键盘焦点。等待学生决定的助手提示也使用这一操作色系。

### Secondary
- **条件蓝**（`blue` 及其 line / fill）：输入条件、规则、知识引用、来源入口与相关图示。
- **结论青绿**（`green` 及其 line / fill）：输出、答案和验证结果；文字和内容标签说明具体含义。
- **学习提示青**（`learning-assist` 及其 line / fill）：练习提示，与正式答案、个人笔记分开。
- **系统信息蓝灰**（`system-info` 及其 line / fill）：未落盘草稿、读取提示及系统信息，不作为课程知识分类。

### Tertiary
- **个人笔记暖黄**（`personal-note` 及其 line / fill）：学生自己的记录，当前别名沿用 amber 色系。
- **学习提醒赭色**（`learning-reminder` 及其 line / fill）：课程正文中的易错点与学习提醒。
- **薄弱玫瑰 / 已掌握青绿**（`review-weak`、`review-mastered` 及浅底）：复习状态；始终显示“薄弱”“已掌握”等文字。“待复习”使用内容辅助灰。
- **系统异常红**（`system-danger` 及其 line / fill）：保存失败、冲突与错误；不要用个人笔记暖黄替代。

### Neutral
- **画布白 / 暖白编辑纸**（`paper` / `edit-paper`）：阅读背景与编辑浮层。
- **石墨墨色**（`ink`）：正文与关键标题。
- **内容辅助灰**（`muted`）：画板来源、内容注释等次级信息。
- **界面辅助灰 / 浅底辅助灰 / 输入提示灰**（`ui-muted` / `ui-muted-tint` / `ui-placeholder`）：界面说明、浅底目标摘要和 placeholder。
- **课程重要性灰蓝**（`course-priority`）：星级独立表达课程重要性，不能沿用个人笔记暖黄。
- **内容草稿蓝灰**（`content-draft` 及其 line / fill）：待完善内容，以虚线框与文字说明身份。
- **细线灰 / 浅灰面板**（`border` / `surface`）：输入边界与轻分层。

**The Two Palettes Rule.** 操作外壳使用灰白与淡紫，正文按具体学习含义使用蓝、绿、暖黄及扩展语义色；不要让课程语义色接管所有按钮。

**The Meaning Before Hue Rule.** 重要性、复习状态、个人笔记、学习提醒、内容草稿和系统异常分别命名；保留标签、边界或图形线索，不用颜色独自传达含义。

辅助文字与 placeholder 在实际背景上按普通字号至少 4.5:1 检查。已复验的五个关键界面样本为 4.979–5.477:1；这是这些样本的证据，不是整站无障碍认证。侧车 tonalRamp 是设计面板的色相预览，生成的中间色不自动成为可用文字色。

## Typography

**Canvas Font:** `ReviewExcalifont, PrototypeXiaolai, "Kaiti SC", "PingFang SC", sans-serif`。Excalifont 通过 `unicode-range` 限于拉丁字符和选定标点，中文继续由 Xiaolai 提供。  
**UI Font:** PingFang SC，回退到 Microsoft YaHei、system-ui、sans-serif。编辑工具自身采用 system-ui。  
**Math Font:** MathLive 本地资源中的 KaTeX_Main / KaTeX_Math 及配套数学字形。普通公式容器继承正文，内部数学 span 使用专门字体。  
**Source / Mono Font:** ui-monospace、SFMono-Regular、Consolas。

**Character:** 手写字形服务清楚的推演。系统控件和数字表格保持规则字体；公式符号、上下标和结构由数学排版负责。

### Hierarchy
- **Canvas Theme / Title**：主题与单元标题使用世界坐标字级；frontmatter 的 canvas-theme 是阅读模式主题标题，不是远景总览卡片的大字号。
- **Canvas Lead / Body**：导语与连续正文；普通阅读段落与导语行高 1.85。标题平衡换行，正文允许自然折行和长词断行。
- **Title**：侧栏标题，屏幕坐标字级。
- **Label / Control / Body / Prose**：分别对应 `--type-label`、`--type-control`、`--type-body`、`--type-prose`。默认根字号下为 12 / 13 / 14 / 16px；短标签、控件、说明、助手长文各用自己的层级。助手草稿行高 1.75，回答正文 1.85。
- **Table Body / Head**：画板表格使用 UI 字体与等宽数字，正文 21px、表头 19px；表格横向滚动而不挤压公式。
- **Math**：相对正文的 1.08em 缩放，保持专业数学字形。
- **Mono**：来源原文与结构化数据，不取代普通讲解。

**The Two Registers Rule.** 屏幕控件与画板世界分别使用各自字级；世界坐标中的字号经过相机缩放，不能直接搬给普通屏幕标题或按钮。

## Layout

桌面由顶栏、左侧课程目录、中央连续画板和按需侧栏组成。目录默认宽 224px；关系、来源、助手默认宽度分别为 330 / 420 / 360px，可调宽。操作围绕当前画板展开，保持正文、图示、公式与解释相邻。

顶栏使用自然高度与可换行操作组：桌面最小高度 70px，窄屏最小高度 62px；它们不是固定高度。工作区用 flex 填充剩余空间，保存提示根据测得的顶栏高度定位。字体增大时先重排，不能把按钮挤出窗口。

### 窗口与画板宽度

| 条件 | 当前行为 |
| --- | --- |
| 窗口 ≤1180px / ≤950px | 逐步收紧目录、顶栏间距与操作内边距，收起次要信息。 |
| 窗口 ≤760px | 目录与各侧栏改为互斥覆盖层；正在使用的面板优先，背景画板退出 Tab 序列，编辑浮层暂时隐藏，关闭后恢复。 |
| 窗口 ≤650px | 编辑工具组可滚动，最大高度 112px；面板按动态视口约束高度。 |
| 窗口 ≤480px | 收起非必要文字，保留核心操作。 |
| 画板实际宽度 <620px / <1000px / ≥1000px | 主题总览分别使用 2 / 3 / 6 列；仅影响总览主题框，不表示正文分栏。 |
| 画板查询容器宽度 ≤1000px | 画板工具与小地图避开编辑入口或工具组，桌面打开侧栏导致画板变窄时同样生效。 |
| 短窗口 | 高度 ≤820px 压缩总览；≤680px 调整助手消息区与滚动；≤640px 进一步压缩小地图与侧栏。 |

窄屏单元阅读保留 650px 世界宽度，再由相机缩放和平移显示；不会把整套公式内容挤成手机宽度的常规文章。默认单元宽度和用户保存的尺寸属于画板布局，不能与屏幕 CSS 宽度混为一谈。

### 浮层与滚动

助手面板自身允许纵向滚动，任务和提示保留最小可操作高度；长目标与选段各限制到 84px 后内部滚动。草稿默认 112px、最小 92px、最大 30vh，可手动调整。发送区不被消息列表挤没；短窗口允许滚动到它。

编辑浮层根据画板实际边界居中，宽度和高度随当前面板与工具组测量。画板底部控件用编辑工具的实际高度避让，不能只按整个浏览器窗口居中或使用固定估算。

上述断点来自源码；393×852 的根字号 200% 顶栏路径已复验。系统字号、浏览器真实缩放、真实双指触摸、Safari 和屏幕阅读器不据此视为已验证。

## Elevation & Depth

以细边界和浅底分层为主，阴影说明浮动层级。知识内容不通过厚重阴影表达重要性；总览 hover 和侧栏可以有很淡的状态/分隔投影。

### Shadow Vocabulary
- **Floating Low**（`0 1px 2px #27343e04, 0 4px 14px #27343e07`）：画板工具、小地图与轻量入口。
- **Floating Medium**（`0 8px 30px #27343e0d, 0 2px 8px #27343e06`）：Toast、保存异常和高层提示。
- **Editing**（`0 5px 20px #27384a12, 0 1px 3px #27384e08`）：编辑工具与编辑面板。
- **Dialog**（`0 24px 80px #27343e26`）：历史版本等模态对话框，配合轻量 backdrop。

**The Floating Only Rule.** 阴影说明层级与状态，不说明知识重要性；知识框优先使用手绘边界与语义浅底。

状态过渡采用 140ms，面板和列表采用 220ms，曲线为 `cubic-bezier(.2, .75, .25, 1)`；材料展开 180ms。相机移动为独立的 180ms 三次减速，键盘定位即时完成。减少动态效果设置会取消 CSS 动画/过渡与相机动画。

## Shapes

界面控件使用小到中等圆角；常用按钮、输入和面板采用 frontmatter 的圆角尺度。知识单元保持端正矩形，由 Rough.js 形成轻微复描。正文中的提醒、练习和交互块可以使用规则圆角边框；不要把手绘单元边框机械套到每个内部块。

手绘框基础参数为线宽 1.5、粗糙度 1.45、弯曲 1.35、solid 填充；关系路径粗糙度 1，普通手绘线路 0.8。绘制尺度随显示深度调整，种子由稳定对象身份决定。

**端正手绘。** 轻微变化在线条中，文字、公式与布局保持端正；连续输入和相机移动不能让边线随机跳动。

## Components

### Buttons
- **Secondary:** 白底、细灰边、石墨文字；hover 浅紫，active 下移 1px。
- **Primary:** 淡紫底、交互紫文字，用于助手发送等当前主动作；hover 加深同一色系。
- **Focus / Disabled:** 屏幕控件通常使用 2px 紫色轮廓、3px 偏移；远景总览与单元全览的世界控件使用放大的轮廓以抵消相机缩放。禁用保留原生 disabled、文字和透明度反馈。

### Chips
- **Scope:** 课程规模等短元信息采用辅助文字色，不承担主导航。
- **Search Scopes:** 原生复选框配短标签，交互紫表示选中，输入保持可操作。

### Cards / Containers
- **Reading Unit:** 稳定的手绘边界与白底，按单元阅读顺序组织。
- **Condition / Conclusion:** 蓝、绿浅底表达条件与输出，保留标签和文字。
- **Learning Reminder:** 赭色标签、浅底与规则边框，正文仍用石墨色。
- **Personal Note:** 暖黄标题与展开内容，属于原位材料收纳，不与课程提醒或系统警告混同。
- **Draft / Error:** 草稿有蓝灰虚线框；系统错误使用异常红与具体说明。

### Inputs / Fields
- **Search:** 浅灰底、轻边界，focus-within 转为白底、淡紫边和轻光晕；placeholder 使用专用颜色。
- **Text Area / Select:** 使用 UI 字体；目标摘要使用浅底辅助文字色，长内容可以折行或滚动。
- **Math Field:** MathLive 的可视化结构编辑，使用专用数学字形、淡紫聚焦与淡蓝选择区。

### Navigation and Keyboard
- **Course Navigation:** 当前单元以淡紫底、紫色文字和窄标记线定位；主题入口定位该主题的首个单元。
- **Canvas:** 阅读模式的 Tab 只进入当前单元；滚动公式、表格与自定高度单元的隐式焦点入口同样受控。焦点移动时先处理内部滚动，再把画布目标带入可见范围。
- **Continue Reading:** 键盘激活后聚焦下一单元标题，再继续 Tab 到其控件；鼠标可继续操作画板中的其他单元。
- **Assistant:** 键盘打开助手进入草稿框，关闭返回助手入口。窄屏面板覆盖期间背景画布与其工具 inert。
- **Knowledge References:** 明确表示前往知识主位置，与打开来源资料区分。

### Material Disclosure and Interactive Examples
- **Materials:** 在所属单元原位展开已备内容；展开反馈为短暂透明度与位移。摘要允许换行。
- **Exercises:** 提示青与答案绿分工明确，并显示“学习提示”“答案与步骤”等标签。
- **Interactive Controls:** 使用面向学习任务的标签；卡诺图为“显示跨边圈组”，按下状态同步圈组与讲解。S0 / S1 等真实信号名保留，内部字段名不直接充当普通操作文案。

### Agent Messages and Tasks
- **Messages:** 普通回答以分隔线组织，用户消息用浅紫灰容器；正文采用 Prose 字级，引用保留可辨识的来源动作。
- **Composer:** 目标、来源选段、请求方式、草稿、模型与发送依次排列，保持可达。
- **Tasks / Prompts:** 任务用浅灰容器；等待学生选择的提示用交互紫；语义变更提醒可使用带说明的淡黄边界，不等同于个人笔记。状态文字完整显示。

### Editing Toolbar
- **Style:** 暖白纸、蓝色工具文字、细蓝灰边界与轻浮影；当前工具使用淡紫。
- **Layout:** 收起时只保留入口；展开后按功能分组并可换行。窄屏覆盖面板打开时暂时隐藏，面板关闭后恢复编辑状态。

## Do's and Don'ts

### Do:
- **Do** 让操作外壳保持简约，把手绘个性用于知识正文、图示和个人标注。
- **Do** 同时保留手绘笔触、端正排版和有信息含义的内容配色。
- **Do** 按具体语义选择颜色 token，并用文字、位置或边界补足含义。
- **Do** 保留两套字号尺度、稳定身份与边框种子，让相机和焦点协调。
- **Do** 为公式保留 MathLive 的专业数学字形，并尊重 `prefers-reduced-motion`。

### Don't:
- **Don't** 为简约删除必要讲解、隐藏适用条件或移除全部内容颜色。
- **Don't** 给所有系统控件套手写字体，或用手写近似形替换数学符号。
- **Don't** 旋转知识卡片、扭曲文字、添加装饰点阵、渐变、玻璃拟态或厚重阴影。
- **Don't** 合并课程重要性、复习状态、个人笔记与系统异常，也不要把个人箭头表达成已审核关系。
- **Don't** 把画板世界字号和宽度直接当作屏幕 UI 尺寸，或把自动化视口测试写成真机验证。
