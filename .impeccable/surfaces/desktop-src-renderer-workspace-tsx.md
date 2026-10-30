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

**STORY:** 打开课程后从目录定位并连续阅读；在左侧切换搜索、目录、笔记和原文，现场保留；选中内容直接提问或修改，在右侧学习对话继续，关闭后回到完整画板。自动保存提供一个可靠状态，失败明确说明影响和实际恢复动作。

**FIRST VIEWPORT:** 顶部为一行约 52px 的课程名称菜单、保存状态和右侧学习对话入口。左边约 64px 的菜单栏，搜索图标在最上方，目录/笔记/资料在下面，默认目录面板约 250px；资料面板按阅读需要加宽。画板顶栏下留有间距的悬浮工具条按中央可用画板居中：阅读/选择/平移，荧光笔/图形二级选择，关系二级菜单，撤销/重做。小地图和缩放/全图在右下角。面板收起归还空间，不主动重置相机。辅助区同时展开空间不足时优先最后主动使用者并保留其他现场。

**FORM:** 用户选择的左侧入口轨（原结构候选第 7 项），按用户修订为可展开/收起的菜单栏，画板工具移至顶部悬浮条。seed:539d357e48446604。用户已批准视觉库与实现，不再进行方案抽选。Operate 使用 code-led。主代理亲自完成最终视觉和行为审核，仅使用用户指定的一个实施子代理。

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 验收边界

正常阅读、菜单切换、二级菜单展开、Agent 打开、窄窗口、键盘焦点及失败状态都需要看真实渲染。覆盖 1440×900 与 1024×768 桌面，以及现有窄窗口行为；不开展 Windows 实机/打包。保持课程身份、内容、编辑与保存协议、个人状态、独立手动备份/历史恢复语义。只按实际持久化结果显示保存状态，不把错误降级为会消失的 toast。图形箭头与正式关系分开。撤销遵守实际编辑上下文，不假装全局历史恢复。原始课程、个人数据库与日常安装不作为破坏性测试目标。

实现接入 Tailwind 时应保护现有正文/编辑器样式免受全局重置影响。屏幕固定控件不进入画板缩放层。数据加载/搜索/草稿状态不能因面板关闭而无意丢失。实现前及收尾分别对照 PRODUCT.md、系统设计定稿和 DESIGN.md；现有底层功能继续由正式服务接口承担。本任务证据统一在原仓库 `artifacts/evidence/modern-workspace-shell/`。
