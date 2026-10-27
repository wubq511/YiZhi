# 绎知桌面 · 阶段 I

本切片在独立 Electron 窗口阅读既有 `KU-001` 的完整内容，开放两段普通正文编辑与首段拆分，用于验证保存通道。输入通过 preload IPC → 宿主拥有的共享 Node Worker → 课程 SQLite 保存；区分“草稿已保留”与“已保存”，只有覆盖当前输入的实际事务回执才显示后者。失败保留屏幕输入，支持重试；正常关闭和退出会先收齐最新输入，失败保留窗口。

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

`test:electron` 在锁定 Electron 的内置 Node 中运行同一组真实 Worker／SQLite 测试；`test:smoke` 使用 Playwright 驱动真实 Electron、公开 preload IPC 和编辑区，验证双段输入／拆分、失败保留／重试、关闭保存屏障、退出重开、强杀后的草稿恢复、应用单实例与跨应用课程锁。所有写入和故障注入均使用临时课程副本。测试截图和构建产物不进入 Git。

已验证运行组合为 Electron **45.0.0**、Node **24.22.0**、SQLite **3.53.4**，实际连接启用 WAL、外键和 `synchronous=FULL`。外部 Node 仅是测试驱动，不代替该 Electron 组合验收。

## 边界与后续接口

`src/core/course-service.ts` 是宿主公共边界，`src/shared.ts` 定义请求与回执。每个应用一个 `CourseService`／Worker，课程按规范目录持有唯一连接和写入资格。`open`／`read` 返回完整单元、会话、正式确认进度、未吸收草稿及事件游标。保留 T01 `save`；新增 `saveDraft`、`commitEdit`、`queryOperation`、`history` 与 `readEvents`，均已连接 preload IPC。

`saveDraft` 按会话覆盖保存最新输入和原始依据，只保留当前序号摘要，不永久保存逐键正文。`complete: false` 的输入可恢复但不晋升。`commitEdit` 将实际变化、拆分对应、正式历史、回执、事件与草稿消耗放进同一事务；同 operationId 相同载荷返回原结果，不同载荷拒绝。较新的相交草稿阻止旧稿晋升；独立旧提交只消耗自己的实际进度，不能删除较新草稿。重开使用新会话，旧消息失效，恢复时显式接管原草稿并保留原基线。

`ParagraphSaveChannel`（亦导出为 `SaveChannel`）保留 `input(text)`／`flush()` 供已有界面使用，`edit({ changes, splits, complete })` 接收多块增量。通道合并所有未确认变化；默认空闲 250ms、最长等待 1000ms，不因持续输入无限推迟。单个在途操作失败后先查询原身份再重试；响应和事件只推进其实际序号，不回填旧文本。`text(blockId)` 提供恢复输入，`synchronize()` 补读持久事件，`dispose()` 清理定时器；正常关窗仍等待 `flush()` 的真实确认，未完成但已持久保存的草稿也可安全关窗。

事件由同一 Worker 串行发布，保留最近 256 条，默认每 300ms 有界补读（每页最多 128 条）。游标过期明确返回 `reset` 与同一边界的当前快照；客户端先核对未知操作，再通过 `onSnapshot` 交给编辑适配层。事件不永久复制正文。冲突不自动换 revision 重发旧值，输入和原始依据保留供后续编辑整合。

这是阶段 I 的窄输入界面，不代表连续富文本编辑、公式编辑、批注迁移、整课迁移、真实 Agent、安装包或 Windows 已交付。当前增量覆盖既有普通段落文本及一次变更组内每个源段的一次 Unicode 码点拆分；T05 在同一保存边界扩展实际编辑模型。物理中文输入法、触控板和系统字号尚未实机验收；组合输入期间不提交未完成候选，关窗保留现场并要求完成输入。异常退出前尚未取得持久确认的输入不承诺恢复。

单元复制与本地字体来源见 `fixtures/provenance.json`、`fixtures/font-provenance.json` 和 [第三方资源](THIRD-PARTY-NOTICES.md)。
