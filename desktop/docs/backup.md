# 完整本地备份

在顶栏「备份与升级」选择「新建完整备份」，使用原课程以外的全新目录。应用先收齐当前输入，再复制一致数据库与固定资源。复制期间可以返回课程学习；看到「完整备份已完成」才表示完成标记及资源核验已成功。完整备份包含该时点已保存的个人记录、已确认草稿、任务恢复依据和仍保留的历史，之后原课程的历史清理不会追删副本。

缺资源、复制失败或进程中断会留下未完成目录。修复问题后选择「继续未完成备份」，使用原目录与原备份身份；重试核对原数据库快照、声明清单及资源摘要，不换用较新的 live 清单。未完成目录不能作为课程打开。未知结果的资源保留 lease 跨进程重开继续有效，不按时间猜测备份已经结束。

保存归档后，先把完整目录复制到恢复位置，再使用兼容应用打开恢复副本。打开可写课程会正常改变数据库，归档校验应在打开前进行。同一课程身份的原目录与备份副本不能同时取得写入资格；先退出持有该课程的应用，再打开恢复副本。旧任务会先核对实际状态，不能因为打开副本自动重新执行。

## Core 与本地命令

`CourseService.backup` 的宿主接口：

| 方法 | 输入 | 结果 |
| --- | --- | --- |
| `create` | `{sessionId, directory, backupId}` | 创建新完整备份 |
| `resume` | 同一课程、原目录、原 `backupId` | 核对原快照并继续 |
| `status` | `{directory}` | 无完成标记始终返回 `unfinished` |
| `verify` | `{directory}` | 核对完成标记、数据库、资源摘要与长度 |

`backupId` 不得被另一目录或新备份复用。UI 只获得 `chooseCreate/chooseResume({sessionId})`，目录由宿主原生选择器决定；资源 lease、数据库和测试调度控制均不暴露给 renderer。

```sh
cd desktop
npm run build
node scripts/backup-course.mjs create /copied/course /new/archive stable-backup-id
node scripts/backup-course.mjs status /new/archive
node scripts/backup-course.mjs resume /copied/course /new/archive stable-backup-id
node scripts/backup-course.mjs verify /new/archive
```

命令使用所选 Node 24；实际应用使用锁定 Electron 的内置 Node。CLI 同样遵守课程写入所有权，已在另一应用打开的课程通过应用内入口备份。

## 一致性边界

`backup-manifest.json` 标识 `yizhi-full-backup-1`；`backup-complete.json` 最后发布。SQLite 副本由 `node:sqlite.backup` 创建。清单来自已经完成的 `backup-snapshot.sqlite`，明确枚举所有登记来源（包含未引用版本）、解析／人工修正 JSON、扩展离线依赖，以及当前、个人原语境、历史、草稿和恢复域中的实际声明。摘要身份本身不等于资源引用；可信 producer 使用保留根注册接口提供枚举，只有 membership 查询的根不能宣称完整备份。

T23 的 durable resource lease 在 SQLite backup 开始前取得，直到全部资源复制、核验及完成标记之后释放。最终 `course.sqlite` 从同一快照产生，其自身复制来的备份 lease 在最终摘要前离线释放。批量文件流与摘要不占长期 SQLite 写事务，也不占全局 Core 命令队列。

课程格式、最低读取能力、正文载荷版本及扩展运行接口／输入／现场版本分别核对。未知较高版本在写入前拒绝；只读接口只返回能完整解释的单元范围，不导出未知载荷后覆盖原课程。旧版已允许的 opaque 块由现有局部编辑协议完整保留，不计入完整只读／导出范围。

打开受限版本时，应用只提供已支持单元的文本／公式视图及 `.txt` 导出，并明确排除图片、实验现场与其他个人记录。导出位置必须在原课程目录之外，不能用提取文本覆盖原数据库。它不承诺完整课程或无损内容交换。

完整备份与内容交换包、课程内历史各有用途；此入口限手动本地备份，不提供云同步。

## 受控格式升级与中断接回

「备份并升级课程」只支持格式 **1 → 2**。宿主使用现有窗口保存屏障收齐最新正文、公式、个人记录及对话输入；保存失败会保留输入，并在建立升级目录前停止。保存确认后暂停此课新写入／任务资格、排空在途工作，先创建完整备份，再在独立新目录升级。其他课程仍可读写。

工作副本核对 SQLite 结构／外键、课程身份、单元／主题／布局／关系引用、正文与扩展能力、全部声明资源后，复用 `directory-authority.ts` 的 `DirectoryPublicationLease` 和 `publishVerifiedDirectory`。源目录原子发布事实是唯一切换点；准备成功不能让新目录自行取得写资格。停写 lease 重新核对包括 committed WAL 的持久领域摘要及代际／事件序号，不能用旧回执或布尔值代替实际资格。

| Core 方法 | 输入 | 结果 |
| --- | --- | --- |
| `upgrade.prepare` | `{sessionId, directory, backupDirectory, upgradeId, saveBarrier?}` | 已核验、未发布的 `UpgradePreparation`；原课停写，新目录不可写 |
| `upgrade.publish` | `{sessionId, upgradeId}`；已发布重试可用 `{sourceDirectory, upgradeId}` | 共享 `DirectoryDecision`；成功后只有新目录可写 |
| `upgrade.cancel` | `{sessionId, upgradeId}` | 只放弃匹配的未发布准备，保留原绑定并接回原课 |
| `upgrade.status` | `{directory}` | 共享目录事实与实际本地路径 |
| `upgrade.recover` | `{directory}` | 按已提交事实返回唯一有效课程目录 |

`saveBarrier` 是宿主保存确认来源，普通 UI 自动提供；Core-only 调用只承诺已确认的 Core 输入。renderer 仅有当前会话的 `upgrade.info/choose` 与原生选择位置的 `chooseRecover`，不能提供任意源路径、lease 或测试 gate。UI 自动备份到所选新目录的 `.before-upgrade` 旁邻目录，准备与发布连续执行。

切换前中断仍以原课为准，新目录拒写；重新打开原课、核对版本与停写资格后可重试原准备，或放弃它。切换后中断以已发布新课为准，打开原路径会按同一发布事实接回；若新课已移动，选择其当前位置核对。完整发布的新课自足，不依赖历史绝对路径存在。失败保留备份、未完成工作副本和诊断，不重放旧任务。格式 2 保留课程身份、当前正文、个人原语境、历史和已确认草稿；正文载荷与扩展版本各自保持，不因数据库升级而冒称已迁移。

本地完整副本验收脚本 `scripts/verify-upgrade.mjs READ_ONLY_EVIDENCE NEW_ROOT [T25_RECONCILIATION]` 只对输入做文件读取／复制，所有 Core／SQLite 操作在自己的 COPY 进行。它比较升级前后公共领域摘要，把原路径隐藏后用独立 Electron 进程打开可移植 format 2 目录，再创建完整归档、先 verify、复制到恢复位置并独立打开；报告输入和归档均未改变。可选 reconciliation 参数核对已接受的真实个人课事实数量。脚本不重新提取课程或调用模型；新建输出根必须不存在。
