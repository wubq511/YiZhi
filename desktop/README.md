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

顶栏“可控生产者 · 验证入口”连接真实 preload IPC、CourseService、Worker 和同一课程数据库。先读取前提与目标，再修改首段并等待自动保存，提交可控候选会保留旧候选并说明依据变化；“重读并整合”用当前正文重新形成候选。停止后拒绝新提交，原成功回执仍可核对。此入口是固定规则的开发验证工具；真实只读问答使用顶栏「Agent · 学习对话」，见[接入说明](docs/agent.md)。展开面板内可滚动，Escape 收起并返回入口。

复习状态按知识单元 B 写入课程 SQLite，严格取“待复习／薄弱／已掌握”之一；新单元缺省为待复习。主题 A 只显示下属 B 的状态数量。状态控件、主题汇总与筛选均不写课程星级、主题评级或单元峰值。命令组可带版本化 `semanticImpact` 元数据；只有正文已提交且明确标记重要结论或方法发生实质变化时，已掌握单元才出现询问。询问保存内容 revision 和复习状态 version，学生之后改变状态会使旧确认失效。可控生产者中的勾选项仅用于展示此接线，不代表问答会修改画板。

## 边界与后续接口

`src/core/course-service.ts` 是宿主公共边界，`src/shared.ts` 定义请求与回执。每个应用一个 `CourseService`／Worker，课程按规范目录持有唯一连接和写入资格。`open`／`read` 返回完整单元、会话、正式确认进度、未吸收草稿及事件游标。保留 T01 `save`；新增 `saveDraft`、`commitEdit`、`queryOperation`、`history` 与 `readEvents`，均已连接 preload IPC。

`saveDraft` 按会话覆盖保存最新输入和原始依据，只保留当前序号摘要，不永久保存逐键正文。`complete: false` 的输入可恢复但不晋升。`commitEdit` 将实际变化、拆分对应、正式历史、回执、事件与草稿消耗放进同一事务；同 operationId 相同载荷返回原结果，不同载荷拒绝。较新的相交草稿阻止旧稿晋升；独立旧提交只消耗自己的实际进度，不能删除较新草稿。重开使用新会话，旧消息失效，恢复时显式接管原草稿并保留原基线。

`ParagraphSaveChannel`（亦导出为 `SaveChannel`）保留 `input(text)`／`flush()` 供已有界面使用，`edit({ changes, splits, complete })` 接收多块增量。通道合并所有未确认变化；默认空闲 250ms、最长等待 1000ms，不因持续输入无限推迟。单个在途操作失败后先查询原身份再重试；响应和事件只推进其实际序号，不回填旧文本。`text(blockId)` 提供恢复输入，`synchronize()` 补读持久事件，`dispose()` 清理定时器；正常关窗仍等待 `flush()` 的真实确认，未完成但已持久保存的草稿也可安全关窗。

事件由同一 Worker 串行发布，保留最近 256 条，默认每 300ms 有界补读（每页最多 128 条）。游标过期明确返回 `reset` 与同一边界的当前快照；客户端先核对未知操作，再通过 `onSnapshot` 交给编辑适配层。事件不永久复制正文。冲突不自动换 revision 重发旧值，输入和原始依据保留供后续编辑整合。

`renderer/editor/` 使用锁定 Tiptap 3.32.0、ProseMirror 和 MathLive 0.111.1。每个活动 B 有一个临时编辑投影；段落和顶层公式可编辑，表格、例题、未展开题解、实验和未知类型沿用原阅读组件并完整保留原载荷与子对象。剪贴板复制递归分配新 ID，明确的原块移动保持身份；拆合记录存续／退出身份及 Unicode 对应，已保存的撤销结果继续自动保存。未知类型显示“保留的内容”，不会导出成纯文本。

`DraftInput.patch` / `EditorDelta.patch` 的合同在 `src/editor-api.ts`：`updates` 仅含变化块的前后载荷；`structure` 仅含同一 B 的前后身份列表与新增对象；`correspondence` 记录实际结构动作。核心检查原始依据，正文、身份退出证明、命令组投影、必要依赖、历史、回执、事件和草稿进度共同提交。未变化的隐藏对象不进入保存载荷或历史，不另存永久 PM 整文。通道保留原最长等待和精确确认规则，合并在途操作之后的全部未确认增量；取消动作或公式回到原值也能持久确认并清除已完成草稿。

公式对象及位置由 PM 持有，内部输入／选区／Undo 由 MathLive 持有，快捷键只消费一次。内部变更不进入外层正文 Undo，也不从保存回执反复 `setValue`。`formulaDrafts` 保存包含占位符或语法未完成的输入，并使用 `complete:false`；原正式公式保持可读。重开恢复草稿，不重建整套 Undo 栈。字体与许可均打包到本地，声音关闭。

外部更新以 `addToHistory:false` 的范围事务更新，保留当前编辑实例和可映射的学生 Undo。光标停顿、窗口失焦都保持当前段落保护；跨段选文保留实际显示的范围和版本，独立范围继续更新。离开前先取得最新输入的持久确认，再调用 `commands.recheck`，重新检查任务资格、所有读取前提、关系／依赖和草稿；只整合有依据的独立字段或文本范围，歧义与冲突保留双方，界面只呈现需要选择的部分。共同成立的命令组不拆成半组。外部已先提交时，其正式历史保留，学生原始差量作为草稿持久保留后再整合；回执的 `basedOnRevision` 仍关联原输入依据。

`commands.protect` 接收独立编辑实例身份、单调序号、实际块范围、`editing`／仅视觉保护的 `selection` 和输入进度；解除范围前核心检查实际持久进度。`resolveInput`／`resolveCandidate` 的显式冲突选择仍核对当前版本，不能绕过停止或变化的读取前提。窗口关闭／渲染器消失由宿主解除临时保护，持久草稿继续守卫同处写入。`ContinuousEditor.captureSelection()`（亦为 `editor.storage.courseSelection.capture()`）给批注返回实际显示的块、内容版本、正式修订、Unicode 码点投影与有序选段；选文滞后期间不替换为 `open()` 的最新正文。未确认输入明确标为 `student-draft`。

顶栏“个人批注”和正文“批注所选文字”连接同一份个人记录；公式默认静态呈现，“选择公式片段”按需创建只读 MathLive，返回正文即释放这次阅读选择控件。正文与公式选区保留实际显示的正式／草稿依据、原内容、选段与完整上下文，文字范围持久化为 Unicode code point。跨段、拆合后的有序片段仍归属同一笔记；有证明的局部编辑与精确 Undo 才迁移关联，删除或不明确改写保留原语境并显示“待重新关联”。“关联到当前选段”只改变当前定位。

`CourseService.annotations` 与 preload `annotations` 共用 `src/annotation-api.ts`：`create/list/update/reassociate/query`。笔记文字的 Undo／Redo、250ms 空闲／1000ms 最长等待自动保存与正常关闭屏障独立于正文。核心用原操作身份查询／重试，笔记版本检查与事件、回执原子提交；正文提交与命令组的批注迁移也在原事务内。`ContentPatch.textEdits/formulaEdits` 携带实际 PM 替换范围或 MathLive 前后模型与输入选区；它们是当前版本内的对应证明，不是跨公式重写的永久符号 ID。`x+x → 2x` 没有对应证明就保持待重新关联。原公式复制获得新身份，不带走原批注。`ContentPatch.restorations` 仅由实际 PM history 事务或 MathLive `undo-state-change` 形成，恢复时核对已记录目标版本；后来重新键入相同内容不构成 Undo 证明。

当前正文并发与批注覆盖真实 KU-001 和可控外部修改；实际 Agent 修改运行器仍属后续票。内置实验、自含离线扩展与真实 Agent 只读问答见下文 T12／T13／T16。物理中文输入法、触控板和系统字号尚未实机验收；合成组合事件仅作回归，关窗保留未完成组合输入现场并要求完成输入。异常退出前尚未取得持久确认的输入不承诺恢复。整课迁移、Agent 正文修改、安装包和 Windows 交付仍属后续范围。

T03 的 `CourseService.commands` 与 preload `commands` 共用 `src/command-api.ts`：`startAttempt`、`read`、`commit`、`stop`、`query`、`candidates`、`history`。`read` 返回核心保存的不可修改依据身份，包含所读块、祖先与顺序、引用和依赖闭包的版本；`commit` 按对象写入，独立块不因整单元 revision 变化而冲突。关系新增也使旧读取失效，内容改回原值不复活旧凭据。被拒候选保留原命令与原因；重读后的整合必须使用新操作身份。历史只保存实际变化对象的前后值与共同提交事实。正式块、必要顺序、引用、依赖状态、历史和回执在同一事务提交，存储故障整组回滚。

当前命令组限定到已复制的 `KU-001`，支持块自身载荷替换、同一父块下的身份保留重排，以及显式引用／依赖记录；不包含插入、拆合、删除、跨单元历史恢复或实际实验算法验证。任务在应用重开后标为中断，需要明确继续来建立新尝试；旧尝试与旧代际不能继续提交，已成功操作可跨重开查询或按原操作重试。命令组在同一事务核对 T02 最新草稿、读取闭包、结构范围及单调输入版本；独立草稿可继续，冲突候选保留。学生正式提交同时推进命令组版本投影，生产者提交向同一保存事件流追加真实组事件与回执游标，不推进学生输入序号。正文始终只有 units.payload 一份权威；草稿、投影、历史与去重各保留原职责。

画板样本与来源页见 `fixtures/t04-provenance.json`；单元复制与本地字体来源见 `fixtures/provenance.json`、`fixtures/font-provenance.json` 和 [第三方资源](THIRD-PARTY-NOTICES.md)。

T14 顶栏“原文资料”支持不可变 PDF／图片版本、双页码、真实选文与区域引用和本地离线阅读；API、发布顺序与验收范围见 [本地不可变来源](docs/sources.md)。

T09 局部空间现场：`CourseService.setLayout` 经宿主/Worker 将明确移动与调宽写入独立 SQLite 基线；`graph` 与关系读取返回同一当前基线。阅读尺寸与碰撞链投影不落成手动布局，展开/正文增长/调宽只纳入实际碰撞对象，收起从最新基线重算。当前切片沿用至多两个已挂载样例正文，移动区域与键盘尺寸柄不会重建连续编辑器；相机补偿、滚轮和可控 producer 跟随共享当前视口，主动浏览取消全部跟随帧，明确返回才恢复。此入口只消费真实可控提交，不代表真实 Agent 接入；全课/500 单元与物理 IME、触控板仍属后续验收。



T12 内置探索使用既有 `KU-055`／`KU-057` 的 MUX、`KU-062` 的 74LS138 式译码器和 `KU-035` 的固定跨边卡诺图；后两单元是通过原查询入口取得的完整副本，原课程与派生视图不变。目录主题展开不依赖其首个单元已纳入当前切片，因而可进入这些已支持样本。T24 完整候选复用现有 7 个实验，并补齐既有 KU-059 的 8:1 MUX。MUX 支持 2:1／4:1／8:1 与常量、输入或反输入的数据端；卡诺图固定为原有 A / BC 四角合并示例，不提供任意函数或自动化简。

`CourseService.experiments` 与 preload 共用 `src/experiments-api.ts`：`open` 初始化，`read` 读取运行状态，`snapshot` 只返回已持久确认的完整模型现场，`act` 操作声明输入、实验公式、运行意图、后台选择、可见状态和异常恢复。公式、相关配置、定义修订、结果有效性、历史和操作回执共同提交；不支持转换的公式也保留，但结果为空并显示需要核对，不调用 Agent。实验内的公式编辑只修改该实验定义，不改写课程中其他通用公式或知识正文。

自动遍历按 250 ms 的模拟步推进，由可信课程 Worker 执行有限布尔计算。步骤同步完成并通过 SQLite 确认后才接收下一操作，因此离屏请求排在已开始步骤的确认之后，随后取消下一定时器；返回按原模拟时间续接。只有明确勾选“离屏继续运行”才继续，正常关窗收齐各实例输入并暂停所有实验。计时器、DOM 和输出图都不是可迁移现场；现场保存输入、步序号、模拟时间和确定性种子。暂停保存失败会停止新步并显示未完成，可明确恢复最近确认现场；恢复或核心重开推进运行代际并拒绝旧消息。生成代码隔离与定义兼容迁移由 T13 交付，不在内置运行器中执行。
T29 在已导入的一个 PDF 版本上提供逐页解析、停止／明确继续、结构化产物查看与人工修正；保留原页和旧产物，不改写画板，不执行 OCR 或 Agent 生成。能力、API 与资源保护接口见 [可恢复来源解析](docs/parsing.md)。

真实只读学习问答支持多段对话、固定正文选文与 T14 来源引用、真实回答增量、课程内持久草稿，以及基于已存可见对话的新问题。执行器在宿主运行，学习窗口关闭后仍可完成回答；明确退出先排空任务登记和输入。协议、恢复用途与实际执行器测试见[Agent 接入说明](docs/agent.md)。

T13 的一个自含离线扩展、版本／现场迁移与宿主恢复接口见 [extensions](docs/extensions.md)。测试使用一次性课程副本；原始个人课程不参与故障注入。

T15 offline four-scope search: [contract and limits](docs/search.md). Open “搜索课程” for actual stored content, scope filters, background indexing, deep navigation and return to the prior reading scene. Search regressions are `tests/search.test.ts` and `tests/search.spec.ts`.
T24 的[完整内容转换](docs/content-conversion.md)可从停止写入的一致副本生成并核对全部 84 单元、资料与图片。默认样例课程仍是独立开发切片；完整阅读请打开转换后的新候选目录。该候选只承诺内容范围，个人记录、任务、草稿、历史与最终权威切换由 T25 完成。

T20 的[真实 Agent 描述检索](docs/description-search.md)在搜索面板中显式发起，只改写查询并选择已有命中；保留实际查询和排序依据，离线继续使用基础检索，不发送学习问答或修改未发草稿。
