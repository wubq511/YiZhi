---
status: accepted
date: 2026-10-27
---

# 采用 Electron 作为桌面宿主

下一版独立桌面应用采用 Electron，沿用 macOS 先实施打磨、Windows 后续必做的阶段安排。Robert 在阅读第一性原理推导、Electron／系统 WK 的同页面资源比较及其局限后明确接受：“接受，那就用electron”。本决定承接[独立桌面交付](0001-independent-desktop-delivery.md)。

选择依据是本产品需要丰富正文、公式、持续增量修改与相机交互；当前原型的同条件动态负载中，Electron 的 rAF 回调长尾更稳定，同时可由产品控制渲染引擎版本。接受其运行时分发、更新及较高动态内存成本，后续通过正文按阅读范围读取、编辑实例按需创建、局部更新和有界资源缓存控制实际工作量。Tauri＋Rust 是认真比较过的替代路径；本决定不把系统 WebView 判为无法实现，也不声称 Electron 全局最优或完整产品已经通过验收。完整证据见[第一性原理与轻量化架构](../research/architecture/第一性原理与轻量化架构.md)。

本次确认的是宿主框架。后续分别接受的 TypeScript／Node Worker 核心与 SQLite 存储另见 [ADR-0003](0003-typescript-node-worker-core.md) 和 [ADR-0004](0004-sqlite-course-storage.md)；正式编辑器及具体依赖版本继续按各自依据确定，现有正式应用尚未迁移。轻量化要求记录在 [PRODUCT.md](../../PRODUCT.md#资源与轻量化)，不得通过删减离线内容或破坏输入、选区、保存与历史来换取资源数字。
