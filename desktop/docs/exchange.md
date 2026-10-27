# 开放内容交换格式 v1

入口：顶栏「内容交换」。格式标识 `yizhi-exchange-1`，类型 `content-exchange`，正文载荷 `review-reading-1`。这是一项显式范围的开放交换能力，不是完整课程备份、旧版权威切换或同步协议。

## 范围与文件

交换包是一个目录：UTF-8 `manifest.json` 和 `resources/<lowercase-sha256>` 不可变文件。manifest 是完成标记，缺少它的中断导出不能导入。无需数据库、专有压缩器、网络或第三方格式转换。

manifest 必须恰好包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `formatVersion`, `kind`, `payloadVersion` | 上述三个独立的明确标识；未知版本整包拒绝 |
| `scope` | 有序 `unitIds`、是否 `annotations`、完整固定 `excludes` 清单 |
| `units` | `{value, revision}`；保留完整递归正式正文、稳定单元／块身份、角色、题解性质、附带元数据和隐藏子材料，不导出当前屏幕截取 |
| `graph` | 所选单元节点、主题元数据、范围内正式关系与完整 AND／OR 路线组；空 `conditions` 和空 `layout`，不将个人布局作为课程事实 |
| `sources` | 所声明内容及批注原语境引用的固定 `SourceVersion`；保留 sourceId/versionId、摘要、媒体类型、实际页数、原名和原有导入时间（包括旧数据空值） |
| `resources` | 每项的相对 `path`、`sha256`、`byteLength`、`mediaType`；正文图片另有原始 `asset` 身份，多个身份可以共享不可变字节 |
| `pageMaps` | 所需来源版本的已核对印刷页映射；不推断或重写旧引用 |
| `notes`, `annotationVersions` | 显式选择后才包含个人批注：完整原选段／显示投影／原文版本、现有附着或孤立状态、对应 lineage、所需不可变段落／公式版本；不是全部批注修改历史 |

v1 接受 `paragraph / formula / table / callout / example / steps / exercise / knowledge-reference / figure / interactive` 块。figure 支持已登记 PNG/JPEG 和现有声明节点／边的结构图；interactive 仅支持现有 `definitionFrom` 验证的 MUX／74LS138／固定卡诺图定义。保留其正式定义，不携带运行现场或执行任意代码。PNG／JPEG 来源版本保留 T14 的 `pdfPages=0` 语义，以明确的图片章节定位；不伪装成一页 PDF。未知块／正文版本、未知实验定义明确整包失败；不会筛掉这些块后宣称范围成功。元数据附带字段原样保留，但不成为另一个可写 JSON 权威。

只选择已持久化单元。知识引用必须闭合在所选单元内；跨范围的正式关系明确排除，触及的 AND／OR 组必须包含完整成员。所选块或其批注引用的来源与资源必须齐备，否则导出／导入失败，要求扩大选择或先修复资源。

`excludes` 固定为：范围外单元、跨范围关系、复习状态、布局、阅读状态、草稿、对话、任务、历史、实验运行现场、扩展包、独立来源摘录、题库（机器值见 `src/exchange-api.ts`）。单元正文内已有例题、题解和附带元数据仍完整保留；不把外部题库／映射索引假称已交换。个人批注只有 `scope.annotations=true` 时包括。未来增加范围需要明确新格式合同。

## 导入与保护

所有操作经过宿主的公共 `CourseService.exchange`、同一个 Worker 队列和同一个课程 SQLite 连接。`available / exportPackage / inspect / importPackage / query` 为宿主 API；renderer 只能使用 `available / query / chooseExport / chooseImport / confirmImport`。原生选择器取得的路径留在宿主，不提供 renderer 任意文件系统写入或 SQL 权限。

1. 检查 manifest 的完整版本／范围／身份／引用，核对清单中每个文件的长度和 SHA-256，返回包摘要与目标当前依据。检查不修改个人内容。
2. 学生明确确认后，再核对包摘要与目标依据。以单元、块所属、主题、正式关系／路线组、固定来源版本、个人批注及资源别名检查身份冲突：相同内容共享／跳过；同身份异内容整包拒绝。没有覆盖或“只成功一部分”分支。
3. 先复制、fsync 并核对不可变资源，实际解码 PDF／图片并核对页数，再在一个 FULL SQLite 事务内登记新增单元／来源／图片／页码映射／批注／关系、当前课程图、事件、导入事实和操作回执。事务内再次检查依据；失败全部正式登记回滚。添加单元使用新生成的初始位置，不覆盖原有个人布局。
4. 成功回执按 operationId 与 `{packageDigest,basis}` 去重；跨会话／重开 exact retry 返回同一回执，即使外部包已删除。不同包或依据不能复用成功操作身份。导入身份也受现有正文／来源／批注／实验等领域的公共操作 fence 保护。

只新增缺失对象，绝不覆盖现有正文、个人批注、草稿、状态、对话、任务或历史。新导入批注保留其版本与原时间，不伪造本地创建。失败可能留下完整、未登记的内容寻址 blob；它不是可见正文或半个成功范围，可供重试，后续回收属于独立保留合同。失败、未知回执及重试不删除个人内容。UI 保留本次选择及操作身份供真实写入失败后重试；重启后可重新检查选择，宿主 API 还可按 operationId 查询原回执。

## 可移植路径与限制

清单文件名和资源路径精确按 NFC／大小写核对，路径分隔符固定 `/`，拒绝绝对物理路径、`..`、`.`、空段、反斜杠、Windows 保留名／非法字符、末尾点／空格、软链以及大小写碰撞。`/source-pages/...` 是已登记图片的语义 asset 身份，不是文件系统绝对路径；实际文件始终由清单映射到 `resources/<hash>`。已有中文、空格及原始大小写的相对 asset 和原名保留，不重命名来源身份。

v1 不支持第三方专有格式、任意媒体／脚本、扩展包导入、内容覆盖合并或完整备份恢复。当前目标是独立课程副本间交换明确内容范围；复制应用数据库不是此格式。Windows 只验证格式约束，未实施 Windows 运行／安装验收。

验证：`tests/exchange.test.ts` 通过真实 CourseService／Worker／SQLite／临时文件系统；`tests/exchange.spec.ts` 通过实际 Electron IPC、原生选择器边界替身后的真实文件读写、1024×688 与 700×700、晚期 SQLite 失败／重试、离线删除源包后重开和实际画板 wheel reveal。只使用生成夹具或既有候选的临时副本，不改原始课程。
