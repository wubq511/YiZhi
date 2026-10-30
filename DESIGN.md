---
name: "绎知 YiZhi"
description: "有序的现代操作外壳，端正的手绘学习内容。"
colors:
  paper: "#fff"
  edit-paper: "#fffefa"
  ink: "#27343e"
  muted: "#68717a"
  border: "#e5e5eb"
  surface: "#f6f6f9"
  purple: "#6965db"
  focus: "#eeedff"
  blue: "#345d88"
  blue-line: "#7798bc"
  blue-fill: "#f0f5fc"
  green: "#286b58"
  green-line: "#5f967e"
  green-fill: "#edf7f1"
  amber: "#79551f"
  amber-line: "#bc9a5b"
  amber-fill: "#fff7e5"
  ui-muted: "#626b79"
  ui-muted-tint: "#5f6479"
  ui-placeholder: "#687080"
  course-priority: "#5c6f80"
  learning-reminder: "#8f4e2e"
  learning-reminder-line: "#c58d74"
  learning-reminder-fill: "#fff4ec"
  learning-assist: "#2f6f73"
  learning-assist-line: "#8fb9b6"
  learning-assist-fill: "#edf7f6"
  review-weak: "#92516d"
  review-weak-fill: "#fbf2f6"
  review-mastered: "#286b58"
  review-mastered-line: "#5f967e"
  review-mastered-fill: "#edf7f1"
  personal-note: "#79551f"
  personal-note-line: "#bc9a5b"
  personal-note-fill: "#fff7e5"
  content-draft: "#52677a"
  content-draft-line: "#b6c3cf"
  content-draft-fill: "#f4f7fa"
  system-info: "#41627e"
  system-info-line: "#a9bdce"
  system-info-fill: "#f0f5fa"
  system-danger: "#a13737"
  system-danger-line: "#d9a3a3"
  system-danger-fill: "#fdf0f0"
  shell-surface: "#f5f4f8"
  shell-panel: "#faf9fc"
  shell-ink: "#30303b"
  shell-muted: "#696575"
  shell-line: "#e6e3ec"
  shell-accent: "#6555be"
  shell-selected: "#eeebfa"
  control-primary: "#6255c5"
  control-ring: "#7568cd"
typography:
  canvas-title:
    fontFamily: "ReviewExcalifont, PrototypeXiaolai, \"Kaiti SC\", \"PingFang SC\", sans-serif"
    fontSize: "34px"
    fontWeight: 400
    lineHeight: 1.5
  canvas-lead:
    fontFamily: "ReviewExcalifont, PrototypeXiaolai, \"Kaiti SC\", \"PingFang SC\", sans-serif"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: 1.85
  canvas-body:
    fontFamily: "ReviewExcalifont, PrototypeXiaolai, \"Kaiti SC\", \"PingFang SC\", sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1.85
  title:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "-.01em"
  body:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  control:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  rail-label:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
  math:
    fontFamily: "KaTeX_Main, KaTeX_Math, serif"
    fontSize: "1.08em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: ".875rem"
    lineHeight: 1.8
  table-body:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "21px"
    lineHeight: 1.65
    fontFeature: "\"tnum\" 1"
  table-head:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif"
    fontSize: "19px"
    lineHeight: 1.65
rounded:
  sm: "6px"
  control: "8px"
  panel: "10px"
  floating: "12px"
  dialog: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.control-primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 10px"
    typography: "{typography.body}"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.shell-ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 10px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.shell-muted}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 10px"
    typography: "{typography.body}"
  input-search:
    backgroundColor: "#f8f8fa"
    textColor: "{colors.ink}"
    rounded: "9px"
    padding: "10px"
    typography: "{typography.control}"
  nav-item-active:
    backgroundColor: "{colors.shell-selected}"
    textColor: "{colors.shell-accent}"
    rounded: "{rounded.panel}"
    width: "50px"
    height: "56px"
    padding: "6px"
    typography: "{typography.rail-label}"
  canvas-toolbar:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.shell-muted}"
    rounded: "{rounded.floating}"
    height: "50px"
    padding: "5px"
  card-reading:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "0px"
    padding: "35px 38px"
    typography: "{typography.canvas-body}"
  material-disclosure:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.blue}"
    rounded: "0px"
    padding: "20px 0"
  personal-note-disclosure:
    backgroundColor: "{colors.personal-note-fill}"
    textColor: "{colors.personal-note}"
    rounded: "6px"
---

# Design System: 绎知桌面学习工作区

## Overview

**Creative North Star: "有序工作台，手绘推演"**

学生在白色画板上持续阅读、练习和修改。操作外壳以浅灰紫底、规则字形和精确间距提供稳定位置；学习内容保留端正手绘笔触、完整讲解与语义配色。现代感来自层级、密度、焦点和状态的一致性。

屏幕界面不随画板缩放；目录、搜索、笔记、资料与学习对话按需让出空间。控件靠近所作用的内容，课程级操作归于课程菜单；选中内容后直接提问、修改或批注。用户的阅读位置、输入和真实保存结果决定反馈。

**Key Characteristics:**
- 浅灰紫操作区、白色画板、石墨文字和紫色当前状态。
- 规则系统控件与端正手绘学习内容使用两套字级。
- Lucide 线性图标、紧凑菜单、柔和浮影与清楚焦点。
- 面板切换保留现场，常用操作稳定可见，低频操作逐层展开。
- 保存异常持续可见，颜色之外还有图形与文字表达状态。

本规范以当前 Electron renderer 的 `shell/`、`components/ui/`、正文与编辑器样式为依据；当前操作外壳采用 shadcn/ui Base UI Nova、Tailwind 与 Motion。Tailwind 不启用全局 preflight，正文与 MathLive 保持各自排版。历史 Python/Web 基线的截图和测量仍属于其原版验收，不代表当前桌面实现。

## Colors

浅灰紫承担操作区的区域分层，白纸承载课程；强调色集中于当前操作、焦点与选中。具体值以 frontmatter 与源码 token 为准。

### Primary
- **操作紫 / 选中淡紫**（`shell-accent` / `shell-selected`）：外壳当前入口与工具；组件主按钮使用 `control-primary`。
- **正文交互紫**（`purple` / `focus`）：课程内部既有控件和编辑焦点，保留其范围。

### Secondary
- **条件蓝**（`blue` 与 line / fill）：条件、知识引用和来源入口。
- **结论青绿**（`green` 与 line / fill）：答案、输出与验证结果。
- **学习提示青**（`learning-assist` 与 fill）：练习提示，区别于答案。

### Tertiary
- **个人笔记暖黄**（`personal-note` 与 line / fill）：个人记录与图形。
- **学习提醒赭色**（`learning-reminder` 与 line / fill）：易错点与提醒。
- **复习状态**（`review-weak` / `review-mastered`）：薄弱与已掌握，用图形和可访问文字共同表达。
- **异常红 / 信息蓝灰**（`system-danger` / `system-info`）：失败与保存过程，不能充当知识分类。

### Neutral
- **外壳 / 面板**（`shell-surface` / `shell-panel`）：框架与辅助内容区域。
- **界面石墨 / 辅助灰**（`shell-ink` / `shell-muted`）：控件与次要说明。
- **画布白 / 编辑纸**（`paper` / `edit-paper`）：正文与活动编辑区。
- **正文墨色 / 细线**（`ink` / `shell-line`）：内容与区域边界。

**The Two Palettes Rule.** 操作状态与课程语义分开命名；不能把条件、答案、个人笔记和异常合成同一种强调色。

**The Meaning Before Hue Rule.** 当前入口同时有选中底色和状态属性；复习状态有不同图形及可访问名称；保存状态有图标、文字和恢复操作。

## Typography

**UI Font:** PingFang SC、Microsoft YaHei、system-ui、sans-serif。Base UI 组件继承屏幕字级；操作区为规则字体。

**Canvas Font:** ReviewExcalifont、PrototypeXiaolai、Kaiti SC、PingFang SC、sans-serif。拉丁与中文由本地字体分别承担。**Math Font:** MathLive 本地 KaTeX 数学字形；公式内部字形独立于手写正文。

正文 24px、单元标题 34px、导语 28px 均为世界坐标字号；公式、表格与材料保持相邻。外壳正文 14px，面板标题 15px / 600，菜单与目录 13px，辅助状态 12px，入口短标签 11px；紧凑字级只用于短标签，不用于长篇学习内容。缩放数值、页码与表格使用等宽数字。

**The Two Registers Rule.** 屏幕控件与世界内容分别使用各自字级；不能把缩放前的正文尺寸直接搬到普通界面标题。

## Layout

当前桌面外壳由 52px 顶栏、64px 左侧入口栏、可展开左面板、中央画板和按需学习对话组成。左面板的目录 / 搜索 / 笔记 / 资料宽度为 250 / 330 / 330 / 440px；学习对话为 360px。课程标题在空间不足时省略，菜单和关键入口保持可操作。

画板顶部工具条距画板顶边 16px，按可用画板居中，高 50px；阅读/选择/平移、标注、正式关系和当前编辑撤销以间隔分组。导航控件位于右下角，小地图在其上方。主动目录定位给工具条预留标题空间；学生主动平移不被强制纠正。

左右辅助区同时展开后若中央剩余不足 480px，优先最后主动使用的面板；被暂时隐藏的现场保留。窗口不大于 760px 时，辅助面板覆盖画板，背景控件退出键盘访问；工具条收紧到 44px 高。关闭面板或菜单后焦点回入口。面板开合不重置相机。

资料操作位于面板标题旁的菜单；版本选择、页序与缩放紧凑排列，印刷页登记与解析按需展开，原页阅读占据主体。学习对话的消息区和输入区可滚动，长选段限制高度，发送动作保持可达。

**The Scope Before Placement Rule.** 课程级操作进入课程菜单；内容操作靠近选区；画板工具保持在画板；开发验证与自动维护不产生学生界面入口。

## Elevation & Depth

面板以背景色和单条细边界分区，浮动工具与菜单用有偏移的柔和投影表示层级。画板知识框以手绘边界和内容结构表达身份。

- **工具浮影：** `0 4px 18px #2f234014, 0 1px 3px #2f23400a`。
- **菜单浮影：** `0 8px 30px #2f23401a, 0 2px 6px #2f23400a`。

面板宽度开合使用 180ms、`cubic-bezier(.22, 1, .36, 1)`，入口选中底色随当前入口衔接；减少动态效果时取消这段运动。动效用于表达空间变化，不重复装饰每个控件。

**The Floating Only Rule.** 阴影说明浮动层级；知识重要性由内容、关系与评级表达。

## Shapes

常用控件 8px 圆角，入口、菜单和导航组 10px，主悬浮条 12px。平面面板保持直角。Lucide 图标采用一致线宽，主要工具约 19px；不使用字符或 emoji 代替系统图标。

知识框保留稳定身份决定的 Rough.js 种子，单元边界线宽 1.5、粗糙度 1.45；个人图形使用自身笔触。手绘变化在线条中，文字、公式和排版保持端正，输入与相机移动不让边框随机跳动。

## Components

### Buttons

外壳按钮与菜单使用 Base UI 交互语义，区分 primary、outline、ghost；常驻工具以 ghost 为主，选中态由淡紫底和紫色图标表达。图标按钮有完整可访问名称，禁用保留原生语义。正文既有按钮保持作用域，不被外壳全局重置覆盖。键盘焦点用紫色轮廓或 ring。

### Inputs / Fields

搜索、资料页序、选择器和对话草稿使用规则字体。输入边界轻而清楚，placeholder 保持可读，长文本可以滚动。公式保留 MathLive 专业排版与独立输入历史。

### Navigation

入口栏始终使用图标和短标签；搜索保留图标入口与 ⌘K。目录主题可展开，当前单元使用淡紫底和 `aria-current`。目录复习状态有独立形状与可访问文字，不逐行重复统计。隐藏面板保留查询、草稿与原页现场，同时退出键盘和辅助技术访问。

### Canvas Toolbar

常用工具直接可见，图形与关系各有二级菜单；个人箭头不创建正式关系。撤销/重做对应最近活动的正文、公式、批注或画板历史；原生输入没有可桥接历史时保持不可用，不伪装全局历史恢复。

### Reading Content

正文、条件、答案、例题、个人笔记与学习提醒保留既有语义色和材料结构。展开在所属单元原位进行。新增界面不以减少字数为理由删除讲解、适用条件或操作实际结果。

### Agent Composer

目标以单元名称为主，选段作为可移除引用，问题与修改意图明确。关闭对话保留草稿；正在执行、暂停跟随和查看结果保持真实状态。面板标签避免重复说明选择器已经表达的信息。

### Save Status

顶栏聚合真实通道，优先级为失败、保存中、草稿、已保存。失败持续可见，并在展开层显示具体影响与实际重试；正常通道在详情中查看。聚合不能把局部失败变成成功，也不能用短暂 toast 代替恢复路径。

## Do's and Don'ts

### Do:
- **Do** 按操作作用范围组织入口，以布局和间距解释关系。
- **Do** 保留规则操作外壳与端正手绘内容的分工。
- **Do** 让焦点、当前状态和保存结果有明确且可访问的反馈。
- **Do** 保留面板现场、稳定内容身份、语义色与专业数学字形。
- **Do** 从实际渲染与相称的行为检查更新本规范。

### Don't:
- **Don't** 让功能模块各自添加常驻顶栏按钮或重复说明。
- **Don't** 用颜色单独表达状态，或隐藏真实失败与待处理输入。
- **Don't** 把个人箭头当作正式知识关系，把更新意图当作已完成修改。
- **Don't** 将学习正文缩成普通小号界面文字，或给系统控件套手写字体。
- **Don't** 把旧版、开发构建、安装包或未运行的平台验证互相替代。
