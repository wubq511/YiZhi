# 外部 Agent 在画板内提交与验收：接入可行性

核查日期：2026-10-24。先核对官方文档、本地 CLI 版本和帮助，随后完成独立 app-server 临时会话的真实问答、执行中编辑通知和停止实测。尚未完成浏览器、课程文件与 Agent 的完整集成。

**结论：可构建同页闭环。优先验证「画板 → 本地桥接 → Codex app-server 独立会话」。** 用户可以一直留在画板选择对象、提交修改、看反馈、验收与阅读；外部 Agent 不等于必须切到外部聊天窗口。官方明确将 app-server 用于自建产品，产品仍需拥有上下文、业务规则和结果界面。[平台定位](https://developers.openai.com/blog/codex-as-a-platform)

| 接入层 | 会话、继续 | 流式反馈 | 审批、中断与边界 |
| --- | --- | --- | --- |
| **app-server** [1] | `thread/start`、`thread/resume`；`turn/start` 追加任务 | `item/agentMessage/delta`、工具输出、`turn/diff/updated` | 双向审批请求及决定回复；`turn/interrupt` 取消、`turn/steer` 追加运行中指令。默认 stdio JSONL，另有 Unix socket / WebSocket。公开协议，但命令仍标 Experimental，官方不支持生产工作负载。 |
| **Codex SDK** [2] | TS：`startThread`、`run`、`resumeThread`；Python 控制本地 app-server | 官方平台说明支持任务流式接入；不能据此承诺所有 SDK 都有相同逐字事件 | SDK 不是一个统一能力层；审批回调、取消语义须核对所选版本。官方将完整历史、审批与事件客户端指向 app-server。 |
| **`codex exec`** [3] | 非交互运行；`exec resume <SESSION_ID>` 继续 | `--json` 输出任务/条目 JSONL；不等同 app-server 的文本 delta 协议 | 没有文档化的同等双向审批应答通道；宿主管理进程取消，不能冒充 `turn/interrupt`。`--output-schema` 可约束最终 JSON，但不保证内容正确。 |
| **`codex queue`** [4] | 向已有 session UUID / 精确名称排队文本 | 命令本身未提供完整结果订阅闭环 | 公开 CLI，不是仅内部工具；支持指定 remote endpoint。单靠它不能完成应用内审批、取消和验收。 |
| **MCP** [5][6] | 工具连接不等于 Agent 业务会话 | 工具协议不能替代完整任务事件流 | 可让 Agent 读取选中对象、检索本地资料、提交候选结果；排队、调度、持久化任务与验收仍须执行器/应用实现。当前 `codex mcp-server` 已移除；app-server 是另一套 JSON-RPC 协议，不是 MCP 的直接替换。 |

**关于「直接发到 Codex 桌面同一个已有聊天」：不能承诺现成可用，也不能笼统说完全没有公开入口。** 已确认公开的 session 文本投递 `codex queue`，以及 app-server 控制 socket / 本机 `proxy` 子命令；但所查文档没有确立「当前桌面聊天必定由该 CLI daemon 托管，并向第三方开放同一会话的完整事件与审批」这一契约。`exec resume` 能恢复记录也不证明接管同一个活跃桌面运行。桌面 deep link 文档只保证打开已有聊天，或给新聊天预填内容；预填不会自动发送。[4][7] 本聊天可调用的内部 `send_message_to_thread` 工具不能作为自建 App 的公开 API 证据。

**需要我们做的部分（设计建议）：** 本地桥接负责执行器生命周期、任务 ID ↔ thread/turn ID、事件转发与恢复；普通网页不能自行启动本地进程或读任意本地资料，需本地服务或桌面宿主。提交时自动携带选中对象 ID、资料路径/页码或摘录、当前内容版本及修改要求；无需人工截图搬运。资料存储和阅读留本地，但送入云模型的摘录/工具返回会进入云推理，不能称「资料绝不出本机」。

**内容生效与回退策略须由应用实现：** Robert 已明确所有内容修改直接出现，可随时撤回、回退和继续修改，不设预览采纳门槛。画板需要呈现改动与来源、保存足以回退的记录；撤回某次 Agent 修改时保留后续个人笔记，整幅历史状态另用版本回退。Agent 侧栏同时支持普通问答与内容生成；普通回答暂定先在侧栏，明确要求添加时直接写入画板，回答也可一键加入。执行权限审批与内容生效策略是两回事；`turn/completed` 还必须检查 `completed / failed / interrupted`，成功完成执行也不等于内容正确。[1] 应用应识别生成期间学生对目标内容的新编辑，并把变化与最新内容传给 Agent；Agent 根据新内容调整，完成后明确告知学生发生过同时修改、涉及哪里以及怎样处理，即使顺利整合也要告知。不能只依赖基准版本比较而让 Agent 对中途编辑不知情。该行为是待验证的应用要求，不代表协议已经自动提供。中断不会自动撤销已执行的写入。

**验证路线与剩余工作：**

1. 已用独立 app-server + stdio、匹配版本的 schema 和合成 MUX 对象验证真实回答、结构化修改、运行中通知与中断。接下来把对象选择、事件显示、修改应用和保存接入网页；网页中的修改按已确认原则直接生效、可撤回。
2. 继续在同一页验证任务继续、停止、需要时的执行权限处理与断线重连；验收标准是状态正确、结果不重复应用、阅读不中断。断线后按持久化任务与历史恢复，不能假定 delta 会自动重放。
3. 如只需批量后台修改，可缩减为 `exec --json`；如必须复用桌面现有聊天，再独立验证 queue/socket 与桌面会话归属，避免把这个未知变成首版前提。

**仍需验证：** ① 桌面内置运行时与本机 CLI 是否共享目标 daemon、会话及审批归属，首版不依赖这一点；② 所选版本的断线事件补齐、真实工具运行中的取消残留与恢复语义；③ 应用写入、持久化和执行权限处理。`gpt-6.1-sol` / `high` 已在当前本机配置下完成真实任务，不能再列为尚未测试。

## 独立会话实测

2026-10-24 23:52（北京时间）整理。使用 `codex-cli 0.163.0`、stdio、独立 `ephemeral=true` 会话、临时工作目录与 `read-only` 执行环境。凭据由本地 Codex 正常使用；验证脚本未读取、输出或保存凭据。没有操作现有桌面聊天或 Kimi 会话。

| 场景 | 实际结果 | 证明范围 |
| --- | --- | --- |
| 握手与模型发现 | `initialize`、`model/list` 成功；模型列表含 `gpt-6.1-sol` 与 `high` | 协议启动与模型可发现 |
| 真实问答 | `gpt-6.1-sol` / `high` 返回 `completed`，收到 55 个文本 delta；MUX 的两个输出为 `[1,0]` | 真实模型、流式事件与结构化最终回答可用 |
| 执行中学生修改 | 在 `reasoning` 条目开始后，把合成对象从 revision 1 更新为 2，并通过 `turn/steer` 发送最新正文；请求被接受 | 通知确实发送于活跃任务中 |
| 根据新版本修改 | 返回 `baseRevision=2`，保留学生新增的选择端高低位句子；`concurrentEdit=true`，结果说明具体位置与保留方式；目标 ID 未变 | 这次真实任务理解并处理了中途编辑 |
| 结果应用 | 宿主检查目标 ID 与当前 revision 后，将结果应用到内存样例 | 仅验证样例版本匹配与结构化结果，不是课程文件写入 |
| 停止 | `turn/interrupt` 被接受，后续完成事件为 `interrupted` | 活跃生成可停止；未验证有实际工具写入时的残留 |

实测输出摘要：[codex-probe-2026-10-24.json](../../research/evidence/接入核查/codex-probe-2026-10-24.json)。两个测试进程均退出为 0，临时工作目录已清理。没有为了重复测试再次执行已通过场景。

上述结果是单次集成可行性证据，尚未覆盖浏览器、真实资料、跨对象修改、无法兼容的同时编辑、重复事件、断线恢复、持久化或完整撤回。网页仍须独立实现这些业务规则；不能把一次模型遵循通知当作覆盖所有并发情况的保证。

证据入口（先从 `developers.openai.com` 搜索并打开；部分页面当前重定向至官方 `learn.chatgpt.com`）：

- [1] [App-server 协议、生命周期、事件与审批](https://developers.openai.com/codex/app-server)
- [2] [Codex SDK](https://developers.openai.com/codex/sdk)
- [3] [非交互执行与 JSONL / resume / schema](https://developers.openai.com/codex/noninteractive)
- [4] [CLI reference：queue、remote 与实验性标记](https://developers.openai.com/codex/cli/reference)
- [5] [连接外部 MCP 工具](https://developers.openai.com/codex/mcp)
- [6] [Codex MCP server removal](https://learn.chatgpt.com/docs/mcp-server)
- [7] [桌面 Commands：Deep links](https://developers.openai.com/codex/app/commands)

本地交叉核对：`/opt/homebrew/bin/codex` 为 `codex-cli 0.163.0`；前期通过 `--version`、`app-server --help`、`app-server proxy --help`、`exec --help`、`exec resume --help`、`queue --help` 等确认命令/参数存在，随后追加了上表的独立会话实测。未运行 queue/proxy，也未验证接管桌面现有聊天。官方 SDK 总览已出现 Python SDK，不能沿用「只有 TypeScript」的旧判断。
