# 学习对话与明确修改

顶栏「Agent · 学习对话」是普通问答入口。正文选择会保留所选单元／块和文字；原文面板的「带此选段向 Agent 提问」先通过 T14 `cite` 保存真实引用，再附到提问中。提交时 Core 固定目标、正文版本和不可变来源引用。后来浏览、切换对话或导入新版均不改已提交请求。

`agent-api.ts` 定义 `list/create/get/select/saveDraft/submit`。renderer 的 `submit` 经 host `AgentRuntime`，Core 的同名方法负责原子登记。Core 在同一连接／事务保存 task、共享 `cg_attempts`、用户消息、操作回执和 `save_events`；代际来自 `metadata.generation`。`agent_operations` 与学生、命令组、关系、来源及解析共用操作身份边界。草稿只保存最新文字、请求方式、选段目标和引用 IDs，序号按会话单调递增；关闭前等待实际保存确认。textarea 使用原生 Undo，正文仍由 T05 编辑器管理。

host 在启动检测实际 CLI 版本和生成的协议 schema。打开侧栏时按需启动 stdio app-server 并执行 initialize/config-read/model-list；正常复用 CLI 登录，不读／复制凭据。`YIZHI_CODEX_PATH` 可指定执行器路径，默认也探测常见 macOS 安装位置并补足子进程 PATH，支持 Finder 的精简环境。模型选项来自真实目录。缺失或不兼容执行器只禁用发送，保留课程与已存对话。

普通只读请求的 `agent/executor.ts` 仅提供 `yizhi_read_target`、`yizhi_list_sources`、`yizhi_read_citation`、`yizhi_read_source_page`。目标读取在 Core 同步取得实际正文与版本；来源读取使用现有 T14 API。执行器使用 ephemeral thread，cwd 为课程外的空目录，使用 read-only sandbox，并显式关闭 shell/apply-patch、view-image、apps/plugins/MCP、hooks、goals、memories、multi-agent 与 web。未知服务请求拒绝。生成和协议等待均在 host；不可变来源页的异步读取不占住 Core 有序命令队列，退出会排空这些读取。T29 解析仍使用其独立 tool Worker。

RPC 对客户端响应与异步服务请求分别处理。每个任务按实际 thread/turn、attempt/generation 和事件身份核对；消息按 item ID 更新，完整 item 覆盖该 item 的增量，忽略其迟到 delta，保持初次出现顺序。消息标记实际接收中、持久部分和完整消息，任务另存真实 completed/failed/interrupted/unknown 与错误。进程断开保留部分，不伪造打字。重开旧运行任务标记 unknown，不自动再生成；同一 host 的对话可继续使用活动 ephemeral thread；重开后发新问题时创建新的 ephemeral thread，提供 Core 中最近 12 条完整可见消息（每条最多 3000 字符）作为明确上下文，不复制隐藏工具历史。明确修改使用下述窄工具；steer、queue 和任务 resume 留给后续票据。

`agent_tool_recovery` 的原始输入输出仅用于活动 attempt 恢复，带 `purpose='active-recovery'`、task `reference_id` 和 citation refs。终态清除 raw input/output，保留必要 name/digest/refs 结果事实。`get.toolFacts` 暴露这些事实及是否仍需恢复载荷，不返回隐藏工具转储。后续保留期清理可按 purpose/reference/attempt 状态处理；可见学习消息独立保留。操作回执只引用 task，不重复储存全量读取或请求快照。

通常回归采用隔离的 `agent-executor-fixture.ts` 协议进程和真实 Core/SQLite。实际执行器验收另以 `YIZHI_REAL_EXECUTOR=1` 启用 `agent.spec.ts` 对应用发送小问题、核对工具事实／原文／重开后新 ephemeral thread 的上下文与新 turn，并退出重开；可用 `YIZHI_EVIDENCE_DIR` 保存结果和截图。所有测试课程、profile、原文均为临时副本，正常清理。自动化键盘／DOM 选择不构成物理 IME、触控板或 Windows 验收。


## 明确修改与一致组（T17）

侧栏「请求方式」区分只读提问、修改正文与整理、加入画板。意图与目标／来源一同固定在提交快照；普通问答即使文字要求修改也不能取得写权限。相同对话按只读／修改分别使用活动 ephemeral thread，host 的执行隔离配置不变。学习窗口关闭后，已登记任务仍由 host 运行。

只有明确修改任务获得 `yizhi_read_edit_context`、`yizhi_apply_group`、`yizhi_query_group`。对应 host-only `CourseService.readAgentMutation/applyAgentMutation/queryAgentMutation`，不进入 preload。工具不能写目录、SQL、文件、个人笔记或掌握状态。工具操作 ID 在 task 范围生成稳定的正式 operation ID；同一 ID 不可更换参数，响应不确定时查询原回执。

`AgentMutations` 把窄提案编译成已有 `ContentPatch` / `GroupCommand`：根段落文字或公式、明确冗余段移除、原块移动、递归新身份复制、新段落／公式，以及目标与已读两个邻居的手动布局。未知载荷和未展开 children 保留；删除使原个人批注 orphan，原引用和语境不删。所有正文结构仍由 `editor-store` 校验，版本、祖先、学生草稿与编辑保护仍由 `CommandGroups` 裁定。布局附单调版本，位置 A→B→A 不恢复旧读取资格。

`CommandConsistency` 复用现有正式关系和内置实验校验，在同一 SQLite 事务里写正文、必要公式、正式实验定义、直接受影响关系、布局、历史、事件、回执与 task 组事实。`FormalRelations.applyInTransaction` 不另开／提交事务；实验 heap 只在最外层事务成功后发布。最终历史写失败会整体回滚，另存失败候选，不能留下半组。普通 public producer payload replacement 也不能绕过必要实验边界。当前独立纠错域为六输入四选一 MUX：64 组输入按独立通道索引 oracle 核对公式与配置，要求实际已存来源选文、关联公式一致，以及内容所声明的必要直接关系；不声称支持任意算法或全图排版。

正式新定义与实验采用的定义／确认现场分别保存。操作手势结束后自动尝试兼容迁移；输入或现场版本变化使旧迁移 token 失效。不兼容时保留旧版／旧现场，只提供「按新定义重新开始」。重开保留确认现场与待迁移定义。实质方法／结论变化复用 T10 询问，学生确认前不改掌握状态；纯措辞不询问。

任务 `groups` 只含真实 Core 回执；模型完成不能制造保存事实。已有提交但后组失败／未完为 `partial`，无正式变化或仍有候选为 `pending`。未完成组保持草稿候选，不加逐块预览采纳。工具读取／实际提交进度驱动 T09 跟随，用户导航取消后不抢回，完成不定位；「查看实际修改」是用户主动动作。终态清除工具原始输入输出及该 attempt 的全量 `cg_bases.read_values`，保留必要变更历史、候选、版本和摘要事实，后续清理可沿既有 purpose/reference 钩子实现。

回归见 `agent-mutation.test.ts` / `agent.test.ts` 及实际 Electron 小窗口 `agent-mutation.spec.ts`。真实安装 CLI 验收单独启用 `agent-mutation-real.spec.ts`：`YIZHI_REAL_EXECUTOR=1`、`YIZHI_T17_SOURCE` 指向实际 C05 课件，`YIZHI_EVIDENCE_DIR` 保存实际任务／工具／操作组／来源／独立穷举／重开证据。受控协议 fixture 只验证竞争与权限，不代表真实 Agent。
