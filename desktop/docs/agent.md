# 只读学习对话

顶栏「Agent · 学习对话」是普通问答入口。正文选择会保留所选单元／块和文字；原文面板的「带此选段向 Agent 提问」先通过 T14 `cite` 保存真实引用，再附到提问中。提交时 Core 固定目标、正文版本和不可变来源引用。后来浏览、切换对话或导入新版均不改已提交请求。

`agent-api.ts` 定义 `list/create/get/select/saveDraft/submit`。renderer 的 `submit` 经 host `AgentRuntime`，Core 的同名方法负责原子登记。Core 在同一连接／事务保存 task、共享 `cg_attempts`、用户消息、操作回执和 `save_events`；代际来自 `metadata.generation`。`agent_operations` 与学生、命令组、关系、来源及解析共用操作身份边界。草稿只保存最新文字、选段目标和引用 IDs，序号按会话单调递增；关闭前等待实际保存确认。textarea 使用原生 Undo，正文仍由 T05 编辑器管理。

host 在启动检测实际 CLI 版本和生成的协议 schema。打开侧栏时按需启动 stdio app-server 并执行 initialize/config-read/model-list；正常复用 CLI 登录，不读／复制凭据。`YIZHI_CODEX_PATH` 可指定执行器路径，默认也探测常见 macOS 安装位置并补足子进程 PATH，支持 Finder 的精简环境。模型选项来自真实目录。缺失或不兼容执行器只禁用发送，保留课程与已存对话。

`agent/executor.ts` 仅提供 `yizhi_read_target`、`yizhi_list_sources`、`yizhi_read_citation`、`yizhi_read_source_page`。目标读取在 Core 同步取得实际正文与版本；来源读取使用现有 T14 API。执行器 cwd 为课程外的空目录，使用 read-only sandbox，并显式关闭 shell/apply-patch、view-image、apps/plugins/MCP、hooks、goals、memories、multi-agent 与 web。未知服务请求拒绝。生成和协议等待均在 host；不可变来源页的异步读取不占住 Core 有序命令队列，退出会排空这些读取。T29 解析仍使用其独立 tool Worker。

RPC 对客户端响应与异步服务请求分别处理。每个任务按实际 thread/turn、attempt/generation 和事件身份核对；消息按 item ID 更新，完整 item 覆盖该 item 的增量，忽略其迟到 delta，保持初次出现顺序。消息标记实际接收中、持久部分和完整消息，任务另存真实 completed/failed/interrupted/unknown 与错误。进程断开保留部分，不伪造打字。重开旧运行任务标记 unknown，不自动再生成；用户在已完成对话发送新问题可恢复原 CLI thread。修改工具、steer、queue 和任务 resume 留给后续票据。

`agent_tool_recovery` 的原始输入输出仅用于活动 attempt 恢复，带 `purpose='active-recovery'`、task `reference_id` 和 citation refs。终态清除 raw input/output，保留必要 name/digest/refs 结果事实。`get.toolFacts` 暴露这些事实及是否仍需恢复载荷，不返回隐藏工具转储。后续保留期清理可按 purpose/reference/attempt 状态处理；可见学习消息独立保留。操作回执只引用 task，不重复储存全量读取或请求快照。

通常回归采用隔离的 `agent-executor-fixture.ts` 协议进程和真实 Core/SQLite。实际执行器验收另以 `YIZHI_REAL_EXECUTOR=1` 启用 `agent.spec.ts` 对应用发送小问题、核对工具事实／原文／相同 thread 的新 turn，并退出重开；可用 `YIZHI_EVIDENCE_DIR` 保存结果和截图。所有测试课程、profile、原文均为临时副本，正常清理。自动化键盘／DOM 选择不构成物理 IME、触控板或 Windows 验收。
