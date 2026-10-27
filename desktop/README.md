# 绎知桌面 · T01

本切片在独立 Electron 窗口阅读既有 `KU-001` 的完整内容，仅开放首段普通正文编辑。输入通过 preload IPC → 宿主拥有的共享 Node Worker → 课程 SQLite 保存；收到实际事务回执才显示“已保存”。失败保留屏幕输入，支持重试；正常关闭和退出会先收齐最新输入，失败保留窗口。

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

`test:electron` 在锁定 Electron 的内置 Node 中运行同一组真实 Worker／SQLite 测试；`test:smoke` 使用 Playwright 驱动真实 Electron、公开 preload IPC 和编辑区，验证失败保留／重试、关闭保存屏障、退出重开、应用单实例与跨应用课程锁。所有写入和故障注入均使用临时课程副本。测试截图和构建产物不进入 Git。

已验证运行组合为 Electron **45.0.0**、Node **24.22.0**、SQLite **3.53.4**，实际连接启用 WAL、外键和 `synchronous=FULL`。外部 Node 仅是测试驱动，不代替该 Electron 组合验收。

## 边界与后续接口

`src/core/course-service.ts` 是宿主公共边界，`src/shared.ts` 定义请求与回执。每个应用一个 `CourseService`／Worker，课程按规范目录持有唯一连接和写入资格。`open`／`read` 返回完整单元、会话、修订与已确认输入序号；`save` 只接受已指定普通段落的文本变更。正式内容、段落前后文和操作回执同事务提交，操作 ID 重试不重复生效。前端保存通道仅保留一个在途命令和最新未发输入；失败按原命令重试，不用旧回执回填编辑区。

这是 T01 的一个真实单元闭环。连续富文本编辑、完整草稿／晋升协议、事件订阅与恢复、公式编辑、整课迁移、真实 Agent、安装包和 Windows 均不在此交付中。物理中文输入法、触控板和系统字号尚未实机验收；组合输入期间不自动提交未完成候选，关窗会保留现场并要求完成输入。异常退出前尚未获得持久确认的输入不承诺恢复。

单元复制与本地字体来源见 `fixtures/provenance.json`、`fixtures/font-provenance.json` 和 [第三方资源](THIRD-PARTY-NOTICES.md)。
