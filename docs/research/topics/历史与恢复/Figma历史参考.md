# Figma 历史与恢复参考

核查日期：2026-10-27。范围：Figma Design 设计文件；Dev Mode、插件 API 和 Design Agent 仅补充相关边界，不把 Figma Make 的代码项目历史混入。仅查阅官方帮助、开发者文档和官方工程文章；未访问用户账户、安装插件或操作实际文件。因此，下文“界面事实”指官方文档描述的行为，并非登录实测。

本报告保留研究依据，不将 Figma 全套能力转为首期需求。适用范围、简约取舍及后来确认的单元恢复默认值统一见[历史管理与恢复设计](../../../architecture/历史管理与恢复设计.md)。

## 结论

值得借鉴的是：持续保存与可读历史分开、恢复前后都可追溯、先预览再决定、讨论信息不随画布一起倒退。不能直接照搬的是：整文件恢复充当选择性撤回，以及云端协作的技术前提。**“旧状态还能找回”不等于“后来个人内容仍留在当前画板”。**

对本地课程画板，应分别回答四个问题：意外退出后能否继续；哪次正式修改改变了什么；能否只撤回这次修改；是否要把整课恢复到某个时点。一个“恢复版本”按钮无法同时准确表达这四件事。这是本项目的设计判断，不是 Figma 的功能声明。

## 1. 官方公开的产品行为

### 版本历史、命名与整文件恢复

以下依据 [S1：View a file's version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)：

| 事项 | 已确认行为 |
| --- | --- |
| 自动记录 | 官方当前写法是每 30 分钟增加检查点，同时持续更新当前版本；不能写成每 30 分钟才保存，也不能改述为“闲置 30 分钟”。断网或崩溃也涉及自动检查点。 |
| 命名 | 可主动保存带标题、说明的新版本，也可给已有自动版本命名。发布库修改也形成历史条目。 |
| 呈现 | 文件名菜单打开右侧历史栏；自动版本可分组展开，条目显示时间、命名信息和主要贡献者。主要贡献者不等于完整逐操作归属。 |
| 预览 | 选择历史版本在画布查看，可浏览页面、平移；官方“View a version / Copy assets”说明可复制历史对象。 |
| 恢复 | Restore This Version 后生成同一当前时间下的恢复前、恢复后两个检查点；原当前版本仍可访问。 |
| 评论 | 后来评论及已解决评论保留；恢复不能找回已删除评论。 |
| 复制版本 | Duplicate 建立新文件，不携带原文件评论和历史。 |
| 删除版本信息 | 不能删除检查点；Delete Version Info 去掉命名信息，使其按自动版本呈现，不删画布内容。 |
| 访问限制 | Drafts 或 Starter 只能访问最近 30 天历史；文档称升级可立即访问原文件完整历史，不能据此声称 30 天后数据已被物理删除。 |

**文档自身的边界：**S1 的“Share a version”又说历史版本不能选取、复制或导出，与前面复制说明有表述冲突。故仅把“在编辑器历史中预览、按其说明复制”作为参考；不承诺分享历史链接的接收者拥有相同能力。本文未实测消除此处歧义。[S1](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)

2026-10-27 已另行复核 S1 正文的记录间隔及 Restore a previous version 步骤 4：表中的记录时机和恢复前后检查点有直接说明，不是从界面或“非破坏性”措辞猜测的内部实现。

### 自动保存、离线恢复与保存状态

Figma 是云端产品，官方明确离线保护不是完整离线模式。断网后更改可暂存在本机浏览器，重新连接后再同步；关闭浏览器或设备后也有恢复路径。同步离线修改时，历史增加应用前、应用后检查点，有冲突提示可进入历史检查。离线不能浏览文件历史或新建云端历史版本；本地导出的 `.fig` 不包含评论和版本历史。页面列出的离线暂存期限为通常最多 30 天，Safari 为 7 天；这与套餐的历史访问窗口是两回事。[S2：What can I do offline in Figma?](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma)

借鉴的是**让保存状态和恢复入口可见，以及在重新应用修改前后留恢复点**；本项目本来就应离线可用，不应引入“先连云端才能查看历史”的限制。自动保存未完成草稿与正式提交是不同状态；Agent 修改正式提交后自动生效，不要求学生点击接受。

### 预览不等于差异比较

文件历史提供某时点的画布预览；明确的差异比较另见 Dev Mode：选顶层 frame 或 component，Compare changes 可将历史版本与当前版本并排或叠加显示，列表区分 Edited、Added、Deleted；点条目定位图层。叠加透明度可以调整。该页面列明付费方案及 Full / Dev seat 要求，不能宣传成普通文件历史一律自带的能力。[S3：Compare changes in Dev Mode](https://help.figma.com/hc/en-us/articles/15023193382935-Compare-changes-in-Dev-Mode)

Dev Mode focus view 还提供只关注当前设计的历史，状态更新会形成条目并可带修改说明。这说明“文件整体时间轴”与“当前对象的相关历史”可以并存，不必要求用户在整份文件活动中寻找目标。[S4：Dev Mode focus view](https://help.figma.com/hc/en-us/articles/23919923330455-Dev-Mode-focus-view)

对课程画板，更有价值的是先列出知识内容、布局、个人笔记分别变了什么，再按需看局部前后对照。像素叠加适合布局移动，不能代替公式含义、知识关系或文字解释的变化说明。这是本项目建议，不是 Figma 的知识语义能力。

## 2. 多人编辑与 Undo：官方工程证据到哪里为止

### 已公开机制，有明确年代

[S5：How Figma’s multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) 由 Evan Wallace 于 **2019-10-16** 发布。它是当时生产系统的工程说明，不是对 2026 年内部实现完全不变的保证。

- 当时以对象 ID 和属性表达文档；不同属性修改可以并存，同对象同属性冲突按服务器接收顺序取最终值。不能据此说所有文本并发都会自动合并。
- 删除对象的恢复资料在执行删除的客户端 Undo buffer 中。由此可确认存在客户端局部撤销资料；不能推出所有当前操作都具有跨设备、长期保存的个人撤销栈。
- 文章明确：执行 Undo 时会修改 Redo 历史，Redo 时也会修改 Undo 历史。设计原则是“撤销若干次、复制、再重做到现在”后，文档应回到原先状态，避免单人式 Redo 覆盖别人后续工作。
- 文章将评论等数据与画布多人同步分开讨论。此处支持“历史边界可以不同”，不构成把评论等同个人笔记的依据。

**不能过度推断：**上述原则没有证明“撤销 A 的某次修改时，B 后来的同字段修改在所有情形下都不受影响”；也没有定义任意挑选很早一次修改的选择性撤回。本文未找到官方资料完整覆盖同字段覆盖、删除后被他人续写等所有情形，因此不把“按操作者隔离”写成绝对保证。多人同步、Undo/Redo 和长期版本历史是三个不同问题。[S5](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)

### 插件的撤销分组是另一层能力

官方插件 API 的 `commitUndo()` 可显式划分撤销边界：示例先创建 rectangle、提交边界，再创建 ellipse，第一次 Undo 只移除 ellipse；没有中间边界时，两者一起撤销。它证明自动化修改可以按有意义的操作分组；不证明跨用户修改天然隔离，也不等于保存长期命名版本。[S6：commitUndo](https://developers.figma.com/docs/plugins/api/properties/figma-commitundo/)

API 同时区分 `commitUndo()`、`triggerUndo()` 与 `saveVersionHistoryAsync()`：分别涉及撤销记录、执行撤销和保存文件历史版本。只作概念佐证，不建议本项目采用 Figma API。[S7：figma API](https://developers.figma.com/docs/plugins/api/figma/)

### Design Agent 提供了什么，没承诺什么

官方 Design Agent 帮助允许多个 prompt 并行；聊天侧栏保存可导航的会话，并提供 Undo 撤回最近修改。若要看 Agent 修改的前后对照，帮助建议先复制已修改版本，再在原件撤销。该页没有承诺任意历史 Agent 操作可选择性撤回，也没有说明撤销与学生后来同对象编辑的隔离规则，更未承诺所有未发送输入都可恢复。[S8：Work with the Figma agent in design files](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files)

因此，“Figma 有聊天 Undo”足以支持将恢复入口放在修改发生处，但不足以替我们证明“学生后来内容必保留”。

### 本次没有证据确认的内部实现

不从帮助中的 snapshot、checkpoint、non-destructive 等术语推导磁盘格式。本文不声称 Figma 长期历史采用全量快照、差量链、事件溯源、Git、SQLite、特定压缩或清理算法；2019 年多人同步文章也不是长期历史存储格式说明。当前 Undo 保存期限、重启后持久性、恢复进行中与新增编辑的协调策略，本次引用资料不足以给出完整合同。

## 3. 回到本地课程学习画板：建议的产品合同

以下是依据本项目约束提出的设计建议，**不是 Figma 已实现机制，也不是实现方案**。

| 用户真正需要回答的问题 | 建议行为 | Figma 参考与不能照搬处 |
| --- | --- | --- |
| 修改或对话尚未完成，退出后还能继续吗？ | 每课持续保留编辑、布局调整、个人笔记和对话草稿；重开可继续。未发送、未完成、失败或取消的 Agent 草稿有清楚状态；尚未正式提交的部分不混入正式历史，已经正式提交的修改仍保留记录。 | 借鉴持续保存；不能把云端历史检查点当成本地草稿恢复保证。 |
| 今天正式提交了哪些改变？ | 正式历史按一次有意义的已正式提交修改组织，标明学生/Agent、目的、作用范围和结果；Agent 修改正式提交后自动生效，无须用户点击接受。自动保存不逐字灌满时间轴，学生直接编辑可按自然操作形成记录。 | 借鉴命名版本、自动记录折叠及自动化撤销分组；不照搬 30 分钟粒度。 |
| 这次修改究竟改了什么？ | 同一课内预览，明确标注“历史预览”；分别显示内容、布局、个人笔记差异，选择条目可定位对象，退出预览回到当前。 | 借鉴局部相关历史与对照；不强制建立文件副本，不借套餐限制决定能力。 |
| 我只想撤掉那次 Agent 修改。 | “撤回这次修改”只针对其作用范围；后来个人笔记、学生移动和无关内容保留。若学生已改写同一内容，显示具体冲突及可保留部分，不静默还原旧值。 | Figma 公开的多人 Undo 原则提供启发，但不足以作为这项更强合同的证明。 |
| 我想把整课回到那个时点。 | 使用独立入口“恢复整课到此版本”，预览将替换的内容、布局、笔记范围；执行前保留当前状态，执行后形成可识别的恢复记录。对话与草稿不因整课恢复消失，可继续查看。 | 借鉴恢复前后检查点与评论保留；笔记本身属于明确恢复范围，不能未经说明照搬评论的独立语义。 |
| 删除的卡片上还有我后写的笔记，怎么办？ | 选择性撤回时保留笔记及来源定位；正文被撤走也能找到其笔记，不因宿主消失而静默丢失。整课恢复则按预览声明的笔记范围处理。 | Figma 评论保留仅说明信息可有独立生命周期，未证明它自动解决本项目的笔记依附问题。 |

### 必须讲清的并发例子

1. Agent 自动正式提交修改 A：给知识卡补解释；学生随后写笔记 B、移动卡片 C。撤回 A 后，B 和 C 仍在；这是选择性撤回，不是加载 A 之前的整课。
2. Agent 把解释从 X 改成 Y；学生随后把 Y 改成 Z。撤回 Agent 修改不能无提示将 Z 改回 X，应展示同内容已被继续编辑，并让学生决定冲突部分。
3. Agent 新增卡片；学生随后给卡片写笔记。撤回新增时不能连笔记一起销毁；需明确保留笔记的去处，再处理卡片本体。
4. 学生恢复整课到上周。当前整课先成为恢复点；后来对话、未完成草稿仍能找回，但不会自动覆盖刚恢复的正式画板。

这些场景是后续方案的审查标准，不要求永久逐字回放，也不要求把所有中间画面永久保留。正式修改的可理解历史与可恢复草稿都需要，但保存期限、压缩和清理政策仍应单独决定，不能从 Figma 套餐直接搬来。

### 本轮不由 Figma 决定的事项

每课一张持续画板，不为每轮 Agent 对话生成新的主画板；内容、布局、个人笔记保持可区分的修改与恢复范围。macOS 先交付、Windows 后续，核心恢复语义一致；快捷键和文件交互可分别适配。独立桌面交付已接受；Electron 与 SQLite 均仍是候选，本文不据 Figma 作存储选型，也不沿用旧内部技术作为既定前提。

## 4. 证据索引与核查边界

所有链接均于 2026-10-27 联网查阅；S5 的文章发布日期为 2019-10-16。搜索过程中出现的第三方教程与论坛讨论未作为结论依据。未做账户内 UI 实测；S1 复制能力的文内矛盾已在正文保留。

| 编号 | 官方来源 | 本文使用范围 |
| --- | --- | --- |
| S1 | [View a file's version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history) | 检查点、命名、预览、恢复、评论、复制、限制及文档歧义 |
| S2 | [What can I do offline in Figma?](https://help.figma.com/hc/en-us/articles/360040328553-What-can-I-do-offline-in-Figma) | 离线保存和同步恢复边界 |
| S3 | [Compare changes in Dev Mode](https://help.figma.com/hc/en-us/articles/15023193382935-Compare-changes-in-Dev-Mode) | 并排、叠加、图层差异和适用条件 |
| S4 | [Dev Mode focus view](https://help.figma.com/hc/en-us/articles/23919923330455-Dev-Mode-focus-view) | 设计局部历史、状态与说明 |
| S5 | [How Figma’s multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) | 有年代限定的并发、客户端 Undo 和动态 Undo/Redo 原则 |
| S6 | [commitUndo](https://developers.figma.com/docs/plugins/api/properties/figma-commitundo/) | 自动化修改的撤销分组 |
| S7 | [figma API](https://developers.figma.com/docs/plugins/api/figma/) | 撤销接口与保存版本接口不同 |
| S8 | [Work with the Figma agent in design files](https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files) | 并行 prompt、聊天 Undo 与未公开隔离保证 |
