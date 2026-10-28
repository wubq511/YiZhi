# Agent 与学习窗口生命周期

行为合同见总稿 §6；本文只记录实现接口与验收入口。

`agent.stop({sessionId,taskId})` 先在同一 Core 顺序中持久撤销 `cg_attempts` 资格，并留下可修补的停止事实，再更新任务投影。返回 `stopping` 与执行器真正确认后的 `stopped` 分开；已提交组不撤回。原成功回执可经 host-only `queryAgentMutation` 查询，不要求恢复写资格。

Host `AgentRuntime.reconcile` 只核对原 thread/turn。已有持久终态直接读真实回执；原连接仍运行则接收其原通知；结束结果通过实际 metadata/turn/item API 取回。未载入或没有可核对结果时记 `unknown`，不启动新推理，也不从一次 `thread not loaded` 推断全局历史必然不存在。学习 QA/mutation threads 仍为 ephemeral；不同进程不能承诺取回其未收到的尾部。

明确点击 `continue` 才创建新的 task/attempt。原请求快照仍可读；新尝试固定最新目标版本、必须重读，带上原尝试链的提交快照及已提交组事实，并使用新 ephemeral thread。旧 operation/group/attempt 仍防重放；外部模型调用不承诺绝不重复。

`agent_executor_receipts` 先接收验证后的真实事件，再更新任务、消息及工具事实。投影写失败不会抹掉已持久接收的外部事实；读任务或重开时按原顺序修补。终态移除重复 raw payload，保留必要身份、摘要、用途和任务引用。畸形事件不进入持久收件箱。

`AgentRuntime.prepareQuit/cancelQuit/close` 与 `DescriptionRuntime.prepareQuit/cancelQuit/close` 属于 host。prepare 阶段同步停止新准入、Core 撤销所有未完成提交资格；close 仅在窗口保存屏障通过后关闭进程。描述检索及目录检测在途连接同样排空。Core 的最终 close 等待已准入异步来源／索引读取，再关闭 SQLite 与 Worker。

`LearningHost` 为每个 canonical 课程保持一个学习窗；所有课程共享同一 CourseService/Worker。重复打开同课聚焦原窗。正常关学习窗不关闭运行器；新窗接回任务与草稿。明确退出冻结所有窗口（含 portal）输入，排空每个现有编辑器／个人记录／实验／composer，再确认每窗持久屏障；任一失败保留所有窗口并解除冻结，旧任务资格不会恢复。

Core host-only `openLearningView/confirmLearningView/releaseLearningView` 记录保存确认。取消退出的窗口重新标为 active；异常消失只结束临时保护，durable drafts 继续参加同处核对。重开说明已确认内容与不能保证找回的未确认尾部。`recoverExtensionRenderers(sessionId?)` 让单窗恢复只撤销所属课程实验回调；无参数保留旧全局恢复入口。

并行 T18 的 active editor 注册集与 `flushUnitInputs(true)` 必须保留在同一 onCloseRequested handler 内；T19 只包裹该 handler 的冻结／失败恢复，不替换其中的保存步骤。T18 的 queued/waiting 是业务工作；模型结束不代替业务完成。stopRequested 必须优先结束等待资格。

自动回归入口：`agent-lifecycle.test.ts`、`agent-lifecycle.spec.ts`、`learning-lifecycle.spec.ts`。`agent-lifecycle-real.spec.ts` 仅在显式 `YIZHI_REAL_EXECUTOR=1` 时使用正常已安装 CLI；它与受控协议 fixture 分开。所有 Electron UI 测试遵守共享 native focus 串行 wrapper。
