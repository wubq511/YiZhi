# 本机文件

此目录除本说明外不进入 Git。`migration/` 保存 2026-10-28 搬迁与整理的本机记录：

- `transfer-manifest.json`：原始文件、摘要与最终去向，每项注明原样保留、路径更新或内容归并。
- `reorganization.json`：移动与归并映射、清理结果。
- `database-verification.json`：迁移时一致快照的 8 张表摘要，供之后核对。
- `final-verification.json`：最终保留检查、测试、导航与提交状态。
- `legacy-joint-checks.json`：六份历史联合验收快照的完整数据与原摘要，不是现行个人状态。

当前个人状态位于 `courses/digital-logic/.review-board/`，原始课程资料位于相同课程目录下。公开的目录说明及迁移结论见 [迁移记录](../docs/development/migration-2026-10-28.md)。
