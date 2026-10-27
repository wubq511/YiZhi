# 绎知 YiZhi

面向课程复习的本地学习工作区：每门课程一张持续扩展的画板，完整知识正文、来源、个人笔记和 Agent 围绕稳定的内容身份共同工作。

产品与下一版系统设计已定稿。当前仓库保留可运行的 Python／Web 基线及完整数字逻辑课程；Electron／TypeScript 新版尚未实施。现有 **20 个主题、84 个有效知识单元**及分类、层级、评级、关系、完整正文和个人状态已经迁入，后续开发直接使用这些内容，不重新生成一套课程。

## 开发入口

- [产品规则](PRODUCT.md)、[领域词汇](CONTEXT.md)、[视觉规范](DESIGN.md)。
- [系统设计定稿](docs/architecture/系统设计定稿.md)：已确认的完整合同、实施顺序和验收条件。
- [架构决策总览](docs/architecture/架构决策总览.md)与 [ADR](docs/adr/)：选择及依据。
- [文档索引](docs/README.md)：按开发、知识核对、研究和验收任务查找。

下一阶段从总稿的阶段 I 开始：Electron 宿主、一个课程核心 Worker、SQLite 与一个真实单元的保存恢复闭环。后续阶段仍以完整课程作为内容与迁移基线。

## 启动现有基线

从本仓库根目录运行：

```bash
python3 legacy/review-board/start.py
```

默认打开 `courses/digital-logic`，地址为 `http://127.0.0.1:8769/`；也可双击 [macOS 启动器](legacy/review-board/启动复习画板.command)。`--course /完整课程目录` 打开其他课程，`--port 0 --no-browser` 使用自动端口且不打开浏览器。

本地阅读与编辑使用 Python 标准库和仓库内资源；PDF 原页及提取需要 Poppler，真实 Agent 需要本机已登录的 Codex CLI。完整操作、验证命令与已知边界见 [旧版应用说明](legacy/review-board/README.md)。

## 目录

| 位置 | 内容 |
| --- | --- |
| `docs/architecture/`、`docs/adr/` | 当前设计与正式决策 |
| `docs/knowledge/` | 知识方法、课程基线、审校与教材核验依据 |
| `docs/research/` | 专题调研、技术比较与来源证据 |
| `docs/development/` | 旧版行为与验收、视觉用例、技能验证、迁移记录 |
| `experiments/` | 可运行原型、独立实验、原始结果和随附资源 |
| `legacy/review-board/` | 已有 Python／Web 应用与测试 |
| `courses/digital-logic/` | 完整课程知识、派生阅读视图、原文、来源版本和个人状态 |
| `tools/digital-logic/` | 知识查询、校验、生成器与教材检索工具 |
| `.agents/skills/` | 课程查询、教材阅读与产品设计技能 |
| `local/` | 不进入 Git 的本机迁移记录 |

[数字逻辑课程入口](courses/digital-logic/README.md)索引知识与资料；查询和验证命令见 [课程工具](tools/README.md)，课程范围、纠正和证据缺口见 [课程基线](docs/knowledge/数字逻辑课程基线.md)。原始教材、课件、笔记及个人数据库完整保存在本机课程目录，由 `.gitignore` 排除；单独克隆 Git 仓库不会包含它们。完整迁移需停服务后复制课程，运行中备份须使用一致数据库快照。

同一规则只维护一个权威位置，具体约定见 [AGENTS.md](AGENTS.md)。设计讨论与旧交接中的有效内容已归入对应设计、运行接口、课程基线和证据；不再保留平行的历史目录或课程内流程副本。

2026-10-28 的搬迁范围、核验与清理结果见 [迁移记录](docs/development/migration-2026-10-28.md)。
