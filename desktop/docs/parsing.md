# 一个新增来源的可恢复 PDF 解析

T29 在 T14 已登记的不可变 PDF 版本上运行，入口是“原文资料 → 解析此资料”。导入、解析和人工修正均不修改画板，不执行 Agent 或知识生成。既有课程内容不重新抽取。

## 支持的表示

固定使用 PDF.js 6.4.299、`tagged-layout-v1` 适配器和 `@napi-rs/canvas` 1.0.13；配置版本 1、不使用 OCR、页面图像 scale=1。每个 `yizhi-pdf-page-v1` 产物包含完整输入版本快照、PDF 页序（从 0 开始）、原始 page view/rotation、PDF user space 坐标、实际文本项及其变换/尺寸/字体、原生结构标签树、普通图片绘制包围框，以及登记的完整页面 PNG 引用。

有原生标签的标题、表格行/单元格、公式和 Figure 保留原生层级与对应文字/图片区域。公式保留实际字形文本与原页，不猜 LaTeX。PDF.js 未提供的合并单元格属性不推断；复杂表格、裁剪/重复图像、矢量图及排版以原页图像核对。无标签时仅保存实际文字位置及原页，不宣称语义分类。图像是可核对的整页栅格及区域，不声称独立图像语义提取。

无文本层的页面确认成 `ocr-needed` 产物，保留页面图像和定位，不虚构 OCR 文字。整个逐页任务完成表示受支持表示已保存，不表示所有页面可检索、OCR 已完成或语义准确。当前每页图像最多 16M pixels，结构化 JSON 最大 8 MB；超出则如实失败。这是当前资源读取边界，不是性能验收阈值。

## 公共接口

`CourseService.parsing` 与受限 preload 的 `window.yizhi.parsing` 共用 `src/parsing-api.ts`：

- `start({sessionId,generation,operationId,versionId})` 返回已接纳任务的原回执。再次解析使用新操作，创建新任务及不可变产物身份。
- `get({sessionId,taskId})` / `list({sessionId})` 读取当前任务；含固定输入、工具/配置版本、原始操作、当前尝试、状态、实际执行页、输出摘要与失败。
- `stop({sessionId,generation,operationId,taskId,attemptId})` 撤销实际 `cg_attempts` 资格，与登记共享 Core 顺序。当前页工具可能完成其计算，但迟到输出不能登记；保留已确认产物。旧停止回执重试不停止新尝试。
- `continue({sessionId,generation,operationId,taskId})` 明确创建新尝试，仅执行没有确认产物的页面。工具/配置不兼容时要求新建解析。重开不自动重跑。
- `artifacts({sessionId,versionId})` 返回这个来源版本所有已登记产物引用，包括旧解析与每次人工修正；`artifact({sessionId,artifactId})` 读取并核验固定 JSON。`ArtifactRef` 区分 `parser` / `student-correction`，保留任务/尝试/阶段操作、摘要、确认时间、JSON 和 PNG 资源清单，以及修正的父版本。
- `correct({sessionId,generation,operationId,artifactId,textId,text,note})` 修正一个实际文字项，沿用原定位并创建新不可变产物；保留原产物、父引用、修正依据与时间。不改变原 PDF 或已确认解析页清单。
- `query({sessionId,operationId})` 返回原成功回执，或 null；当前进度使用 get。包括阶段登记的原回执。失败请求也先绑定原摘要，不允许借旧身份换载荷。逻辑摘要排除易变的传输 session。

宿主独有 `readResource({sessionId,artifactId,sha256,begin,end})` 最多读取 1 MiB，仅允许已登记引用中的资源。renderer 无此 IPC，也无路径/SQL 权限。图片复用 `yizhi-resource://course/<session>/<artifact>/<sha256>` 的注册资源、范围和会话边界；原 T14 来源协议保持可用。

## 执行、持久性与后续复用

宿主拥有的一个 Core Worker 仍独占每课 SQLite。逐页 PDF 解码/提取/渲染、哈希及资源发布在按需工具 Worker 执行；工具不打开数据库。Core 不等待解析完成而阻塞请求队列；仅把结果回送同一顺序进行短事务资格检查与登记。工具发布完整、fsync、核摘要的不可变资源后，产物引用、任务确认进度、阶段回执及 `parse.changed` 公共事件共同提交；真实登记故障不产生半个正式产物。

`cg_attempts` / metadata generation / 全域操作身份 / `save_events` 是现有共享边界。旧回调只追加被拒输出摘要，不能取得新尝试资格。学习窗口卸载不停止工具；明确退出终止工具，重开将未完成任务标为中断，已确认页仍可读。未确认页在明确继续时重新执行；已确认页不重跑。

后续 T30 可通过固定来源快照、`artifacts` 与 `artifact` 消费结构化产品。备份/历史资源保护应从一致的 `source_versions` 与 `parse_artifacts` 注册表读取清单：每条产物的 `resource` 是 JSON，`resources` 是其依赖资源；原件通过固定 source version 的 sha256 定位。所有路径都是课内 `resources/<sha256>`，可独立核摘要；不要把仅扫描目录所得的完整但未登记 blob 当作已确认成果。失败或被停止的文件发布可能留下完整未引用 blob，后续清理必须同时考虑正式来源、候选与产物引用，不能擅自删共享哈希文件。没有新增永久原始工具响应转储或第二份画板权威。

## 验证

`tests/parsing.test.ts` 经公共 CourseService、真实 Worker/SQLite/解析器运行；使用自行生成的 PDF 源字节，覆盖文字/表格/公式/图像/层级/坐标、OCR 限制、停止及旧尝试迟到、新代际、SQLite 最终事件失败/回滚、重开/继续、修正失败后原身份、旧引用、阶段回执和公共事件。宿主专用 SharedArrayBuffer 只控制实际工具调度，不替换解析结果。活性验证在实际工具被挂住期间完成另一课程的真实 read/save，并在释放前核对结果，无任意性能门槛。

`tests/parsing.spec.ts` 经真实 Electron/preload/资源协议验证入口、完成/停止/继续、结构化产物、真实 PNG、修正/原页/重开，以及学习窗口关闭后宿主续跑。native chooser 仅在 CI 中受控；后续复制/解析/存储/渲染都是真实实现。通用 `*.test.ts` 与 `**/*.spec.ts` 发现方式不变。
