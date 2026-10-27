---
status: accepted
date: 2026-10-27
---

# TypeScript／Node Worker 承载课程核心

在已选择 Electron 宿主后，Robert 明确接受 TypeScript／Node＋Worker：由应用宿主拥有的一个 Worker 统一管理正在使用课程的读取、版本与任务资格检查、短提交、草稿、历史和回执；界面与 Agent 都通过课程核心的统一接口修改数据。学习窗口关闭不结束该 Worker，明确退出应用才停止其工作。一个应用可管理多门课程，不为每门课预建常驻核心进程。

该组织复用 Electron 交付的 Node，并把同步存储与校验移离宿主事件线程。比较过宿主主线程、Worker 和独立 utility process；本次真实绑定实验中，18 场景、4,320 次保存通过，utility 比 Worker 多约 11 MiB footprint，短事务没有显示稳定的独立进程响应收益。接受 Worker 与宿主共享原生崩溃边界，以及线程消息、退出处理和持久恢复的管理成本；普通 JS 异常与原生进程崩溃不可混为一谈。依据见[核心承载实验](../../experiments/core-placement-spike/README.md)。

OCR、重解析或确需原生故障隔离的工具按需使用受管进程，不在课程提交中等待长计算；Python 等工具运行时按具体能力引入。这里确认核心语言与承载，不固定实验中的 Electron／Node 版本、SQLite 绑定或正式编辑器，也不表示正式应用已迁移。存储决定独立记录在 [ADR-0004](0004-sqlite-course-storage.md)。
