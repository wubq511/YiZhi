# YiZhi

## 开发依据

- 当前产品行为以 [PRODUCT.md](PRODUCT.md) 为准，实施合同从 [系统设计定稿](docs/architecture/系统设计定稿.md) 进入；术语查 [CONTEXT.md](CONTEXT.md)，视觉查 [DESIGN.md](DESIGN.md)。
- 技术选择、理由和被拒路线在 [ADR](docs/adr/) 与 [设计取舍记录](docs/adr/设计取舍记录.md)。研究、原型和旧版验收各有范围，不覆盖当前合同。
- 按当前问题查资料使用 [文档导航](docs/README.md)。同一规则只维护一处；新文档承担明确职责，不再建立平行合同或任务过程副本。

## 代码与课程

- `legacy/review-board/` 是可运行的 Python／Web 基线，Electron／TypeScript 新版按总稿分阶段实施。分别报告设计、实验和实际交付状态。
- `courses/digital-logic/` 只保存课程资料、知识、派生阅读视图和学习状态。工具在 `tools/digital-logic/`，课程规范与核验在 `docs/knowledge/`。
- 查询、修改或校验课程知识时使用 [.agents/skills/digital-logic-midterm-map/SKILL.md](.agents/skills/digital-logic-midterm-map/SKILL.md)；教材工作使用 [.agents/skills/digital-logic-textbook/SKILL.md](.agents/skills/digital-logic-textbook/SKILL.md)。
- 现有完整知识、分类、层级、关系、评级和稳定 ID 直接作为开发基线；项目整理或新版搭建不重新抽取、生成一套内容。
- 权威知识在 `courses/digital-logic/期中/数据/知识地图.json`，布局在相邻 `视图布局.json`。派生视图仅由既有生成器更新；破坏性测试使用临时副本，不改个人数据库。
- 原始课程资料、个人状态和本机记录由 `.gitignore` 排除；不要加入 Git。实验的测量结果、截图、版本和许可记录保留其原始身份。

## 运行与验证

- 启动：`python3 legacy/review-board/start.py`。
- 应用测试见 [运行说明](legacy/review-board/README.md#验证)；课程／教材工具和检查命令见 [tools/README.md](tools/README.md)。
- 只读查询或目录整理先检查现有数据；只有权威数据或生成器实际变化时才重建派生视图。
- 原学习目录已清空，不创建软链、兼容副本或对旧目录的依赖。

## 本地产物与收尾

- 调试、验收、打包或整理任务输出时，遵守 [本地产物管理](docs/development/本地产物管理.md)：需要保留的文件统一放在原仓库根目录的 `artifacts/`，该目录由 Git 忽略；不存入 `~/.codex` 或归档后会消失的工作树。
- 每次任务结束前清理本任务的临时输出与冗余副本，核对保留文件的索引、版本和有效路径；原课程、个人状态、唯一备份及仍在使用的文件按上述文档的保留边界处理。
