# 实验与原型索引

- Electron／系统 WK 宿主资源比较：[方法、结果与边界](desktop-resource-spike/README.md)、[有效补测原始记录](desktop-resource-spike/results-v2.json)、[最终清理](desktop-resource-spike/final-cleanup.json)。同一 500 单元页面三对有效测量：动态阶段 Electron 的 rAF 长尾更稳定，WK 的 footprint 更低；首轮失焦记录保留且不用于排名。最小 WK 宿主不是完整 Tauri，rAF 不是物理输入或呈现帧。
- 真实 Node SQLite 核心承载比较：[方法、结果与边界](core-placement-spike/README.md)、[逐场景结果](core-placement-spike/results.md)、[原始记录](core-placement-spike/run-KanJGk.json)。Electron 主线程／Worker／utility 共 18 场景、4,320 次保存与最终核对通过；Worker 比 utility 少约 11 MiB footprint，短事务没有显示独立进程的响应收益。未连接学习 renderer 或正式 CourseService／Agent。
- 历史语义与成本实验：[方法与结果](history-spike/README.md)、[机器记录](history-spike/results.json)。验证指定修改撤回、单元旧版恢复、最新草稿及对象历史开销；37 项检查通过，正文历史数据减少的分母限定于本条合成轨迹。
- 键盘撤销事实实验：[结果与缺口](undo-input-spike/README.md)、[机器记录](undo-input-spike/results.json)。macOS 合成按键下 textarea／MathLive 的撤销重做有效；实际拖动后画板 ⌘Z 不恢复位置。22 项事实检查包含缺口复现，不代表正式撤销功能已完成。
- macOS 桌面宿主实验：[结果与边界](desktop-host-spike/README.md)、[机器记录](desktop-host-spike/results.json)。Electron 13 项通过；WKWebView 原样 7/8，选文兼容差异保留。包含关窗后模拟任务继续与重开读取；不是完整 Tauri 或持久任务恢复验收。
- SQLite 存储隔离实验：[方法与结果](storage-spike/README.md)、[机器记录](storage-spike/results.json)。136 条断言覆盖事务、进程退出、停止竞争、草稿／依赖守卫、合成资源与目录迁移；未实现本轮新设计的历史撤回，不锁定后端语言。
- React Flow 架构验证：[打开与复测](architecture-spike/README.md)、[验证记录](architecture-spike/验证记录.md)、[原始结果](architecture-spike/results.json)。84 个真实单元与 500 个合成单元，对比正文挂载策略，检查跟随中断、选文、公式和离屏状态保留；独立样例，不写正式课程。
- 动态布局组合验证：[实际测量与边界](architecture-spike/动态布局验证.md)、[功能结果](architecture-spike/dynamic-results.json)、[并发负载结果](architecture-spike/dynamic-performance.json)。500 对象下实际正文增高、连锁让位、输入／选文保护、拖动、迟到图片／公式、视口接管和草稿重开；另测持续增长伴随相机移动。候选渲染层实验，不锁定交付形态。
- 中文与公式检索实验：[方法与结果](search-spike/README.md)、[原始结果](search-spike/results.json)。比较字面子串、FTS5 unicode61、trigram 和短词回退；覆盖 84 真实单元与 500 重复单元，不修改正式数据。
- 真实内容的阅读原型：[启动入口](content-depth-prototype/启动阅读原型.command)、[独立网页](content-depth-prototype/index.html)、[操作与验证记录](content-depth-prototype/README.md)。MUX、卡诺图、74LS138 的核心正文、图示、例题与练习；验证主题／单元显隐、原位展开、答案揭示、关系显示与返回恢复，保留三项已定视觉要求。
- 图文样式与可视化公式编辑：[启动入口](style-math-prototype/启动样例.command)、[操作与验证说明](style-math-prototype/README.md)。采用已选 A 的字体与符号，文字排正，框线、电路与箭头保留手绘笔触；白色背景与浅色系统控件，学习内容按条件、关键路径与结论、个人笔记配色；可直接点选符号与公式结构，修改仅保留在当前页面。
- 当前复习画板原型：[独立网页](review-board/index.html)、[打开与操作说明](review-board/README.md)。可在浏览器整窗或全屏操作；固定模拟，未连接真实 Agent。
- 基础视图：[知识图 JSON](基础视图/knowledge-graph.json)、[目录树](基础视图/目录树.md)、[Mermaid 解题流程](基础视图/解题流程.mmd)、[Obsidian Canvas](基础视图/知识关系样例.canvas)。
- Archify：[交互页面](archify/archify-mux.html)、[可修改 JSON](archify/archify-mux.json)、[截图](archify/archify-mux-preview.png)、[原交付记录](archify/archify-mux.delivery.json)、[第三方声明](archify/archify-third-party-notices.txt)。
- Diagram Design：[演示页面](diagram-design/diagram-design-mux.html)、[截图](diagram-design/diagram-design-mux-preview.png)。
- MUX 技能对比：[统一对比页](mux-skill-comparison/index.html)、[版本与实测记录](mux-skill-comparison/README.md)。内部文件树及 Excalidraw 运行依赖整体保留。
- [局部让位示意](local-layout/README.md)：设计讨论中的交互片段，最终合同见系统设计定稿。
- [样例第三方许可](THIRD-PARTY-NOTICES.md)。

正式交付 HTML 可直接查看；`visual-explainer-mux.src.html` 是生成源，其原有 `kit.css` 缺失引用已用正式 HTML 内嵌的同版 CSS 补齐。历史生成命令中的 `/tmp`、`/private/tmp` 上游工具目录不属于随附运行依赖，复现需按原记录准备固定版本；本次没有重跑生成算法或旧测试。

[返回调研导航](../docs/research/README.md) · [项目迁移记录](../docs/development/migration-2026-10-28.md)

## 原始记录的身份

Archify 的交付 JSON 中 `specification.sha256` 和 `specification.bytes` 描述原生成输入。早期整理曾修改配置的 `meta.output` 路径，因此它们不代表当前配置文件的字节摘要；正式 HTML 的原始 artifact 摘要继续对应原交付。不要把目录搬迁视为重新生成或重新验收。

`visual-explainer-mux.src.html` 缺失的 `kit.css` 已从其正式 HTML 内嵌的同版样式逐字补齐。历史 Fireworks／visual-explainer 的 `/tmp` 上游目录只记录原环境，随附产物与许可记录继续保留；复现构建时按固定版本另行准备工具。
