# YiZhi

## 开发依据

- 修改产品行为或架构前，读取 [PRODUCT.md](PRODUCT.md) 和 [系统设计定稿](docs/architecture/系统设计定稿.md) 中对应部分；术语查 [CONTEXT.md](CONTEXT.md)，界面规范查 [DESIGN.md](DESIGN.md)。
- 已确认的选择与证据见 [架构决策总览](docs/architecture/架构决策总览.md)；历史讨论和独立实验不覆盖当前设计。
- 本仓库是绎知 YiZhi 的项目根。目录职责和实际验证入口见 [project-layout.md](docs/development/project-layout.md)。

## 当前实现与课程

- `legacy/review-board/` 是仍可运行的 Python／Web 基线；Electron／TypeScript 新版尚未实现。报告中分别说明设计、原型与实际交付状态。
- `courses/digital-logic/` 内已有完整课程，是开发与迁移基线。保留主题、单元、层级、关系、评级、正文及稳定 ID；本次项目迁移不重新抽取或生成知识。
- 处理该课程内容时读取 [课程 AGENTS.md](courses/digital-logic/AGENTS.md)，使用其中的专用技能和权威入口。破坏性测试使用临时副本，不改个人数据库。
- `experiments/` 的原始结果、截图、版本与摘要是历史证据；修改复现路径不冒充重新测量，不覆盖原始结果。
- 个人状态、原始课程资料和本机记录由 `.gitignore` 排除。不要把它们加入 Git；运行缓存和临时测试副本不作为交付物。

## 常用入口

- 启动基线：`python3 legacy/review-board/start.py`。
- 应用检查：按 [旧版验证命令](legacy/review-board/README.md#验证) 运行与改动相关的测试。
- 课程检查：从 `courses/digital-logic/` 运行 `python3 期中/工具/知识地图.py check --source-only`；派生一致性另运行 `check`，只在权威数据或生成器实际改变时重建。
- 新版实施顺序和验收以 [总稿第 9 节](docs/architecture/系统设计定稿.md#9-实施顺序与验收) 为准。
