# 本地不可变来源（T14）

顶栏“原文资料”通过 Electron 原生文件选择器导入 PDF、PNG、JPEG；可为当前来源登记新版。导入只保存资料，不修改 `units.payload`。学生可分别记录“暂不更新”或“根据新版更新”的意图；真实 Agent 的后续修改由后续任务消费，当前不宣称已执行修改。

来源面板与画板并存；窄屏独占焦点，Escape／返回画板回到原入口。正文中保留的出处通过稳定单元／可选块身份关联，打开的是引用保存时的版本与原选区；画板相机、编辑实例和 Undo 不因原文阅读重建。原文页、缩放、横纵滚动和开闭状态保存在课程 SQLite，关窗等待真实确认，失败保留现场并提供重试。

## 核心及宿主 API

`CourseService.sources`／`src/sources-api.ts` 是公共课程边界。所有课程命令仍通过同一个宿主 Worker 和同一 SQLite 连接串行处理（包括异步 PDF 校验）。

| API | 行为 |
| --- | --- |
| `importFile` | 仅宿主传入已选文件路径；稳定 `sourceId`、新 `versionId`、SHA-256、原名、字节数、媒体类型、实际 PDF 页数和导入时间 |
| `list`, `getVersion` | 当前代际、不可变版本、明确更新意图；仅返回身份／元数据 |
| `page` | 按需读取指定版本的一页，实际 PDF.js 文字投影及逐文本项码点范围、原页 view/rotation、单独核对的印刷页 |
| `mapPrintedPage`, `locatePrintedPage` | 每页单独登记人工核对的印刷页；不推断偏移。更正产生新记录，旧引用保留原记录；同名页返回全部匹配供选择 |
| `cite`, `citations` | 选文只能来自核心重新读取的实际投影；保存稳定版本／哈希／零基 PDF 页索引／印刷页记录／提取器及投影约定／码点范围／原选文／原页区域／可选正文目标 |
| `setUpdateIntent` | 记录指定版本的 `update`／`defer`，不产生正文写入或 Agent 执行的假象 |
| `query` | 按原 `operationId` 查询持久结果，未知返回 null；原请求跨重开重试复用成功结果 |
| `context`, `saveContext` | 最新原文阅读现场；按实际会话单调序号去重，不保留逐滚动历史 |
| `readResource` | 仅宿主按已登记版本读取；每次不超过 1 MiB，首读／文件身份变化重新哈希核对，有界校验缓存 |
| `repairFile` | 仅宿主选择原件，必须与既有版本哈希完全一致；原子补回完整资源，不生成新版或修改旧引用 |

正式来源操作核对代际、操作身份与载荷摘要；版本／页码核对／引用／更新意图、操作回执与共同 `save_events` 事件各自同事务提交。不同载荷复用同操作会拒绝，失败可用原操作重试。来源事件不推进学生正文输入确认序号。来源数据不另存一份正文。

Renderer 的 `window.yizhi.sources` 只公开选择器和上述结构化读取／命令；不公开 `importFile`、`repairFile`、`readResource`、任意文件路径或 SQL。文件选择结果及重试路径留在宿主，主 frame 的 sender 校验沿用现有边界。

## 资源发布与离线读取

`immutable-resource.ts` 按块复制到随机临时文件，检查复制前后原文件状态、fsync、重新计算 SHA-256，并用 PDF.js 或真实图片解码器校验。完成后用不可覆盖的原子 link 发布到 `resources/<sha256>`、fsync 目录，再在 SQLite 中保留已验证候选，最后登记正式版本与回执并原子移除候选。候选不是正式来源；登记失败后跨重开重试仍使用已选择的原字节，外部文件后来改变不能偷换原操作。失败会清掉半成品；候选保存也失败时最多遗留完整但未引用的 blob。损坏资源只有显式同哈希修复才可替换其 bytes，身份及引用保持不变。

应用使用 `yizhi-app://app/` 的构建资源白名单；课程原件使用 `yizhi-resource://course/<sessionId>/<versionId>`，只接受已登记的当前会话与版本，支持 Range、无整文件缓冲、禁止缓存。无额外 HTTP 服务。未登记路径、越界范围、任意文件协议／网络地址受协议和 CSP 限制；新窗口及导航仍禁止。

PDF.js display、真实 TextLayer、module worker、字体、CMap、ICC、WASM 全部由锁定依赖本地提供。自定义协议不依赖 PDF.js 的 HTTP Range 自动探测，使用公开 `PDFDataRangeTransport` 明确请求 64 KiB 块，最多缓存 8 块；只挂载当前一页和一个 canvas（最大 1600 万像素），换页／版本销毁旧文档和 PDF worker。核心的 PDF 解析也按需范围读取并及时销毁。原件留在课程目录，Chromium 缓存清空后断网仍可重开。

PDF 页索引持久化为零基；界面 PDF 页序为一基。印刷页只来自逐页核对记录。选文偏移按 Unicode code point，文本投影为 PDF.js 实际文本项串接及 `hasEOL` 换行（移除最后一个换行），记录提取器版本与 `pdfjs-text-items-eol/codepoint-v1`。PDF 区域使用原 PDF user space（含原页 view／rotation），图片使用原图像素左上角坐标。没有文本层的页面只保存真实页或区域，`quote=null`，不执行 OCR。保留引用的高亮区域按当前视口投影回原页。

## 验证与范围

`tests/sources.test.ts` 通过真实 CourseService／Worker／SQLite，`tests/sources.spec.ts` 通过真实 Electron preload／协议／PDF.js；测试夹具由代码运行时生成，CI 不依赖私有课程路径。覆盖新旧版重开、实际选文、页码核对、扫描式图像页区域、SQLite／资源故障与原操作重试、同哈希修复、正文编辑保留、Range、清缓存断网重开、滚动续接和窄屏焦点。自动选择器测试只控制原生选择器返回值，之后是真实导入链。

本票不做 OCR、结构化整课解析（T29）、教材印刷页批量推断、旧课程重新抽取、真实 Agent 修改、打包发行或 Windows 验收。原生 macOS 选择器和既有 TI PDF 的额外只读实证保留在工单交接笔记；物理 IME／触控板不由程序事件替代。
