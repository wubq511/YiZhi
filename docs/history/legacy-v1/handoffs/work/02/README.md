# #02 正文工作线：合同、交接与作者须知

## 已交接的稳定接口（2026-10-25）

- 权威 `reading` 位于 `期中/数据/知识地图.json` 的单元内，版本 `review-reading-1`。正式 `知识地图.py get <KU>` 原样返回；缺 reading 不是“已收纳”。
- `期中/工具/复习内容.py` 提供 `import --map <课程副本> --package <package.json>` 与 `pin-sources --map <路径>`。导入先校验整个课程，按实体哈希检查目标冲突，原子写入；重复提交相同内容返回 `unchanged`。
- 15 个现有 `SRC` 均已固定真实文件版本。正文引用使用 `sourceId + versionId + pdfPages`；教材另加 `bookPages`，课程笔记若后续新增则使用真实 `section`，不能伪造 PDF 页。
- `复习画板/web/content/provider.js` 导出 `window.ReviewContentProvider`：
  - `render(unit)`：返回 reading HTML；无 reading 返回 null。
  - `afterRender(root)`：加载样式、公式和交互。
  - `captureState()` / `restoreState(saved.inputs.content)`：按 RB 块 ID 保存和恢复交互值。
  - `logic.evaluateMux/evaluateDecoder`：受支持的有限输入语义计算。
- #01 已在正式外壳接入 provider、展开/答案状态和交互输入保存。不要修改其 `app.js`、存储或公共入口来另建通道。

## 已验证的四个样本

`KU-035/KU-055/KU-056/KU-063` 已迁入正式 reading，包位于 `samples/package.json`。临时副本导入、正式 `get` 读回、源检查、构建、完整检查和 21 项知识测试通过。

真实服务 `http://127.0.0.1:8769/` 的内置浏览器检查通过：页面完成初始化；MUX 公式与手绘图可见；例题展开直接显示全部步骤；练习提示/答案按需揭示；MUX 切换 z 后输出按 ¬z 从 0 变 1；重开后 z=0、答案展开、例题展开及视口恢复。滚轮缩放到主题内 B 全览、触控板平移模式也走过实际路径。

曾出现 `JSON.parse(element.dataset.config)` 初始化异常，已改为按稳定块 ID 保存语义配置，不再从 DOM 属性反序列化。临时 `[DEBUG-content-provider]` 已删除。不要恢复该写法。

## 章节作者只允许写自己的包

每个主题只写 `.scratch/review-board-v1/work/02/<TH>/`。不得修改权威 JSON、其他章节、provider、#01 文件、票据或共享代码。完成后由主负责人预览并串行合入。

每包必须包含：

- `package.json`：`review-content-package-1`，`ticketId=02`，稳定 `packageId`、明确的 `unitIds/units`、`baseSourceHash/baseEntityHashes`、`questionUpdates/sourceProposals/assets/evidence`。
- `build_package.py` 或可复现的等价生成方式。参考 `samples/build_package.py` 的 `ref/block/material/coverage` 结构，但不要复制样本正文。
- 原页证据：实际查看的课件 PDF 页、教材中文书页+PDF 页序或笔记小节；影响含义的公式、反相线、表格、卡诺图、电路、引脚、波形和题目边界必须实际看图，记录于 evidence。
- 独立计算复核：涉及真值表、进制、补码、校验、加减乘除、竞争条件或器件输出时，用独立计算/枚举核对，不是把正文答案复制成测试期望。
- 临时副本导入与逐单元 `get` 读回结果。不得直接对正式课程做破坏性实验。

### 包结构要点

- `baseEntityHashes` 必须覆盖所有目标 KU 和 questionUpdates 中的 Q。计算方式沿用 `复习内容.entity_hash`；其他单元后来合入不影响本包，目标自身变化会明确冲突。
- `units` 是 `[{"unitId":"KU-…","reading":{…}}]`。单元 ID 只使用票据明确列出的有效 ID，不能补 `KU-049/KU-073`，不能改身份、评级、关系或重做拆分。
- reading：`schemaVersion/revision/status/blocks/coverage`。候选包可按已完成证据写 `status=complete`，但只有主负责人正式预览后才会合入权威数据。
- 每块：`id`（全课程唯一、以 RB- 开头）、`kind`、`role`、`payload`、`sourceRefs`，容器可加 `children`。支持 paragraph/formula/figure/table/steps/callout/knowledge-reference/example/exercise/interactive。
- core 保持必要条件可见；长例题、完整功能表等用 material。example/exercise 的子块在展开/揭示后会直接连续显示，不要额外套无意义容器。有子块时它们承担完整解答；共享题解仅在没有子块时作为回退显示，避免同一解法重复。提示写在 payload.hint，不再抄进答案。
- 正式题目使用 `questionId`，共享 `stem/solution/answerNature` 放在 `questionUpdates`；普通作业没有官方答案时标 `derived-solution`，自编变式标 `self-test` 且不分配 Q 号。共享题目若被其他包先增补，相同候选可幂等，不同候选交主负责人核对，不能覆盖。
- 正式来源只用现有 SRC；本轮 `sourceProposals/assets` 默认空数组，避免未接入资源阻塞。确需新增时只在包中记录理由并交主负责人，不能擅自复制或替换资料。
- coverage：`goal/coreBlockIds/materials/sourceRefs/visualStatus=verified/readingStatus=passed/note`。材料项为 `figure/method/derivation/example/exercise/interactive`；已核实项列 blockIds，不适用必须给真实理由，不能把没写当成不适用。

### 内容要求

- 先读 outcome、kind、internals、直接题目和真实原页，再写。concept/module 不能只背定义，method 必须有可执行步骤和必要推导；术语、位序、符号、有效电平、适用条件先交代。
- 正文用自然连贯的完整中文句子，不能只是把原 summary/internals 换句式。正常复习需要的解释、图示、方法、例题与练习在包内备齐，不能靠外链或临时 Agent 生成。
- 保持课程范围，不加入 HDL/SystemVerilog 教学，不为排版新增关系，不把并列方法串成前置。
- 图优先使用已支持的语义 interactive（mux/decoder/kmap）或 semantic figure；不得嵌入 HTML/JS。复杂动态结果不能只贴固定截图。
- 自测必须有题干、提示（确有帮助时）和完整答案/理由。例题展开后应能独立读懂完整解法。

## 逐单元片段与预览课程

- 为减少长上下文反复规划，作者可每次只写 `<TH>/units/<KU>.json`。片段含 `unitId`、`reading`、`questionUpdates`、`evidence{owner,pages,readingReview}`；同一单元的正文与证据保持在一个文件内。主负责人仍逐块审核，片段存在不代表通过。
- `python3 .scratch/review-board-v1/work/02/assemble_package.py <TH> [--units KU-…]` 将片段汇总成标准内容包。省略 `--units` 时要求本章全部单元，已完成的样本片段不需要重写。
- 章节可分批预览和合入，但只有本章全部单元通过原页、计算、正式读回和画板验收后才勾选。主负责人用 `prepare_preview.py --map <临时地图> --target <独立目录>` 创建预览课程，资料保留课程内真实文件副本（同文件硬链接或复制），不能靠指向课程外的链接绕过路径边界；浏览器验收后停止预览服务并删除独立副本，不将临时课程作为正式正文库。

## 主负责人验证顺序

1. 在临时副本导入并校验，逐单元正式 `get` 读回，检查计算和来源证据。
2. 用正式 CourseService/provider 预览整章，走展开、答案、引用、原文和交互路径；未通过不合入。
3. 正式导入使用 `python3 复习画板/import_content.py <package.json>`，由活跃 CourseService 或持锁的离线服务串行提交；不能用未参与运行时内容锁的原生 CLI 写正式地图。相同 packageId 的内容不可变化，新批次或修正版使用新 ID。临时无服务地图副本仍可用原生 CLI 检查。随后 `check --source-only` → `build` → `check` → 相关测试。
4. 只把真实完成的主题勾选，保留命令、浏览器行为与未验证部分。全文未合入前不宣称 84 单元完成。

## 来源、搜索与资源补充（已验证）

- 正式 API 已实现版本化 `sources/resolve`、原页 PNG、原件、原文选择、四类关键词搜索和 `/course-assets/`。具体字段见 `复习画板/接口.md`。
- 新增来源若确有需要，使用 `sourceProposals: [{"source": {id,type,title,path,totalPages,version}, "version": {id,sha256,path,displayName,totalPages}}]`。导入只追加版本，不能改已有来源元数据；文件摘要必须真实，重复提交幂等。
- 新增图片等资源使用 `assets: [{"path": "包内相对路径", "target": "期中/资源/<packageId>/<文件名>", "sha256": "实际摘要"}]`。导入先验证，原子写入，已有不同内容不会覆盖；正文 figure.asset 写课程相对 `期中/资源/...`。
- 来源提案与资源提案已分别通过追加/幂等和缺失原子回滚测试。课程迁移时 `Store` 与 `KnowledgeCatalog` 都按课程根定位资料。
- 正式浏览器已验证：搜索结果可打开指定版本原页，38→39 翻页，携带本页上下文；重开后恢复 PDF 第 39 页。交互与阅读状态恢复也已通过。
