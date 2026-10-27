# 绎知桌面 · 单元阅读与连续编辑

本切片在独立 Electron 窗口阅读既有 `KU-001` 的完整内容，同一正文上下文支持跨段编辑、拆合、复制、原块移动与 MathLive 公式编辑。输入通过 preload IPC → 宿主拥有的共享 Node Worker → 课程 SQLite 保存；区分“草稿已保留”与“已保存”，只有覆盖当前输入的实际事务回执才显示后者。失败保留屏幕输入，支持重试；正常关闭和退出会先收齐最新输入，失败保留窗口。

## 运行

```sh
cd desktop
npm ci
npm start
```

首次使用 Electron 时会下载锁定的运行时。不启动 Python、HTTP 服务或外部浏览器。默认在 Electron `userData/courses/digital-logic-t01` 初始化独立课程副本；后续启动读取该数据库，不重复导入或覆盖。`--course=/absolute/copied-course-directory` 可指定另一个课程副本目录；`YIZHI_DATA_HOME` 可隔离应用资料目录（主要用于测试）。不要将这些路径指向原课程。

关闭学习窗口后宿主和 Worker 仍存活，从 Dock 或“窗口 → 继续阅读”接回；“绎知 → 退出绎知”退出应用。应用单实例锁阻止重复宿主；Worker 对课程目录做 `realpath` 规范化并复用会话，独立 `ownership.sqlite` 的排他事务还会拒绝不同应用资料目录中的第二个写入者，进程结束后由 SQLite 释放锁。

## 验证

```sh
npm run typecheck
npm test
npm run test:electron
npm run test:smoke
```

`test:electron` 在锁定 Electron 的内置 Node 中运行同一组真实 Worker／SQLite 测试；`test:smoke` 自动发现 `**/*.spec.ts`，使用 Playwright 驱动真实 Electron、公开 preload IPC 和编辑区，验证连续输入／拆合／复制与移动、公式内外撤销、独立外部更新后撤销、完整结构重开、失败保留／重试、关闭保存屏障、强杀后的草稿恢复、应用单实例与跨应用课程锁。Node 测试仍只发现 `*.test.ts`。所有写入和故障注入均使用临时课程副本。测试截图和构建产物不进入 Git。

已验证运行组合为 Electron **45.0.0**、Node **24.22.0**、SQLite **3.53.4**，实际连接启用 WAL、外键和 `synchronous=FULL`。外部 Node 仅是测试驱动，不代替该 Electron 组合验收。

顶栏“可控生产者 · 验证入口”连接真实 preload IPC、CourseService、Worker 和同一课程数据库。先读取前提与目标，再修改首段并等待自动保存，提交可控候选会保留旧候选并说明依据变化；“重读并整合”用当前正文重新形成候选。停止后拒绝新提交，原成功回执仍可核对。此入口是固定规则的验证工具，未接入真实 Agent。展开面板内可滚动，Escape 收起并返回入口。

复习状态按知识单元 B 写入课程 SQLite，严格取“待复习／薄弱／已掌握”之一；新单元缺省为待复习。主题 A 只显示下属 B 的状态数量。状态控件、主题汇总与筛选均不写课程星级、主题评级或单元峰值。命令组可带版本化 `semanticImpact` 元数据；只有正文已提交且明确标记重要结论或方法发生实质变化时，已掌握单元才出现询问。询问保存内容 revision 和复习状态 version，学生之后改变状态会使旧确认失效。可控生产者中的勾选项仅用于展示此接线，不代表真实 Agent 已接入。

## 边界与后续接口

`src/core/course-service.ts` 是宿主公共边界，`src/shared.ts` 定义请求与回执。每个应用一个 `CourseService`／Worker，课程按规范目录持有唯一连接和写入资格。`open`／`read` 返回完整单元、会话、正式确认进度、未吸收草稿及事件游标。保留 T01 `save`；新增 `saveDraft`、`commitEdit`、`queryOperation`、`history` 与 `readEvents`，均已连接 preload IPC。

`saveDraft` 按会话覆盖保存最新输入和原始依据，只保留当前序号摘要，不永久保存逐键正文。`complete: false` 的输入可恢复但不晋升。`commitEdit` 将实际变化、拆分对应、正式历史、回执、事件与草稿消耗放进同一事务；同 operationId 相同载荷返回原结果，不同载荷拒绝。较新的相交草稿阻止旧稿晋升；独立旧提交只消耗自己的实际进度，不能删除较新草稿。重开使用新会话，旧消息失效，恢复时显式接管原草稿并保留原基线。

`ParagraphSaveChannel`（亦导出为 `SaveChannel`）保留 `input(text)`／`flush()` 供已有界面使用，`edit({ changes, splits, complete })` 接收多块增量。通道合并所有未确认变化；默认空闲 250ms、最长等待 1000ms，不因持续输入无限推迟。单个在途操作失败后先查询原身份再重试；响应和事件只推进其实际序号，不回填旧文本。`text(blockId)` 提供恢复输入，`synchronize()` 补读持久事件，`dispose()` 清理定时器；正常关窗仍等待 `flush()` 的真实确认，未完成但已持久保存的草稿也可安全关窗。

事件由同一 Worker 串行发布，保留最近 256 条，默认每 300ms 有界补读（每页最多 128 条）。游标过期明确返回 `reset` 与同一边界的当前快照；客户端先核对未知操作，再通过 `onSnapshot` 交给编辑适配层。事件不永久复制正文。冲突不自动换 revision 重发旧值，输入和原始依据保留供后续编辑整合。

`renderer/editor/` 使用锁定 Tiptap 3.32.0、ProseMirror 和 MathLive 0.111.1。每个活动 B 有一个临时编辑投影；段落和顶层公式可编辑，表格、例题、未展开题解、实验和未知类型沿用原阅读组件并完整保留原载荷与子对象。剪贴板复制递归分配新 ID，明确的原块移动保持身份；拆合记录存续／退出身份及 Unicode 对应，已保存的撤销结果继续自动保存。未知类型显示“保留的内容”，不会导出成纯文本。

`DraftInput.patch` / `EditorDelta.patch` 的合同在 `src/editor-api.ts`：`updates` 仅含变化块的前后载荷；`structure` 仅含同一 B 的前后身份列表与新增对象；`correspondence` 记录实际结构动作。核心检查原始依据，正文、身份退出证明、命令组投影、必要依赖、历史、回执、事件和草稿进度共同提交。未变化的隐藏对象不进入保存载荷或历史，不另存永久 PM 整文。通道保留原最长等待和精确确认规则，合并在途操作之后的全部未确认增量；取消动作或公式回到原值也能持久确认并清除已完成草稿。

公式对象及位置由 PM 持有，内部输入／选区／Undo 由 MathLive 持有，快捷键只消费一次。内部变更不进入外层正文 Undo，也不从保存回执反复 `setValue`。`formulaDrafts` 保存包含占位符或语法未完成的输入，并使用 `complete:false`；原正式公式保持可读。重开恢复草稿，不重建整套 Undo 栈。字体与许可均打包到本地，声音关闭。

外部更新以 `addToHistory:false` 的范围事务更新，保留当前编辑实例和可映射的学生 Undo。光标停顿、窗口失焦都保持当前段落保护；跨段选文保留实际显示的范围和版本，独立范围继续更新。离开前先取得最新输入的持久确认，再调用 `commands.recheck`，重新检查任务资格、所有读取前提、关系／依赖和草稿；只整合有依据的独立字段或文本范围，歧义与冲突保留双方，界面只呈现需要选择的部分。共同成立的命令组不拆成半组。外部已先提交时，其正式历史保留，学生原始差量作为草稿持久保留后再整合；回执的 `basedOnRevision` 仍关联原输入依据。

`commands.protect` 接收独立编辑实例身份、单调序号、实际块范围、`editing`／仅视觉保护的 `selection` 和输入进度；解除范围前核心检查实际持久进度。`resolveInput`／`resolveCandidate` 的显式冲突选择仍核对当前版本，不能绕过停止或变化的读取前提。窗口关闭／渲染器消失由宿主解除临时保护，持久草稿继续守卫同处写入。`ContinuousEditor.captureSelection()`（亦为 `editor.storage.courseSelection.capture()`）给后续批注返回实际显示的块、内容版本、正式修订、Unicode 码点投影与有序选段；选文滞后期间不替换为 `open()` 的最新正文。未确认输入明确标为 `student-draft`。

当前仅覆盖真实 KU-001 和可控外部修改；批注、复杂实验与实际运行器状态分别属后续票。物理中文输入法、触控板和系统字号尚未实机验收；合成组合事件仅作回归，关窗保留未完成组合输入现场并要求完成输入。异常退出前尚未取得持久确认的输入不承诺恢复。当前不是整课迁移、真实 Agent、安装包或 Windows 交付。

T03 的 `CourseService.commands` 与 preload `commands` 共用 `src/command-api.ts`：`startAttempt`、`read`、`commit`、`stop`、`query`、`candidates`、`history`。`read` 返回核心保存的不可修改依据身份，包含所读块、祖先与顺序、引用和依赖闭包的版本；`commit` 按对象写入，独立块不因整单元 revision 变化而冲突。关系新增也使旧读取失效，内容改回原值不复活旧凭据。被拒候选保留原命令与原因；重读后的整合必须使用新操作身份。历史只保存实际变化对象的前后值与共同提交事实。正式块、必要顺序、引用、依赖状态、历史和回执在同一事务提交，存储故障整组回滚。

当前命令组限定到已复制的 `KU-001`，支持块自身载荷替换、同一父块下的身份保留重排，以及显式引用／依赖记录；不包含插入、拆合、删除、跨单元历史恢复或实际实验算法验证。任务在应用重开后标为中断，需要明确继续来建立新尝试；旧尝试与旧代际不能继续提交，已成功操作可跨重开查询或按原操作重试。命令组在同一事务核对 T02 最新草稿、读取闭包、结构范围及单调输入版本；独立草稿可继续，冲突候选保留。学生正式提交同时推进命令组版本投影，生产者提交向同一保存事件流追加真实组事件与回执游标，不推进学生输入序号。正文始终只有 units.payload 一份权威；草稿、投影、历史与去重各保留原职责。

画板样本与来源页见 `fixtures/t04-provenance.json`；单元复制与本地字体来源见 `fixtures/provenance.json`、`fixtures/font-provenance.json` 和 [第三方资源](THIRD-PARTY-NOTICES.md)。

T14 顶栏“原文资料”支持不可变 PDF／图片版本、双页码、真实选文与区域引用和本地离线阅读；API、发布顺序与验收范围见 [本地不可变来源](docs/sources.md)。

T29 在已导入的一个 PDF 版本上提供逐页解析、停止／明确继续、结构化产物查看与人工修正；保留原页和旧产物，不改写画板，不执行 OCR 或 Agent 生成。能力、API 与资源保护接口见 [可恢复来源解析](docs/parsing.md)。
