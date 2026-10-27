# 项目目录与维护约定

项目名为**绎知 YiZhi**，仓库目录和英文标识统一用 `YiZhi`。2026-10-28 从数字逻辑学习文件夹迁出，当前保留旧版运行基线，下一版按 [系统设计定稿](../architecture/系统设计定稿.md) 实施。

## 文件归属

| 类型 | 位置与维护规则 |
| --- | --- |
| 当前产品规则、术语、视觉系统 | 根目录 `PRODUCT.md`、`CONTEXT.md`、`DESIGN.md`，`.impeccable/` 保留视觉系统元数据 |
| 当前架构合同 | `docs/architecture/`；正式选择与理由在 `docs/adr/` |
| 可复用知识方法 | `docs/knowledge/`；课程专属范围和证据留在对应课程 |
| 调研与技术候选 | `docs/research/overview/`、`topics/`、`architecture/`，图片和出处放 `evidence/` |
| 历史过程 | `docs/history/`；旧版任务及交接在 `legacy-v1/`，评测在 `skill-evaluation/` |
| 独立实验 | `experiments/<实验名>/`，源码、方法、结果、必要依赖同处；历史测量记录不随路径修改而重写 |
| 旧版应用 | `legacy/review-board/`；共享阅读、公式和字体仍由 `experiments/` 提供 |
| 现有完整课程 | `courses/digital-logic/`；包含稳定身份、资料相对路径、全部知识及个人状态 |
| 本机记录 | `local/`；只读迁移清单与验证摘要不进入 Git |

下一版源码在阶段 I 开始时建立 `apps/desktop/` 及有实际职责的共享模块；当前不创建空模块或第二套课程数据。旧版和实验为实现提供行为、内容与验证依据，不要求沿用其技术选型。

## 日常验证与备份

- 旧版应用的 Python、客户端与浏览器检查见 [运行说明](../../legacy/review-board/README.md#验证)。
- 课程内容校验从 `courses/digital-logic/` 运行，见 [课程维护约定](../../courses/digital-logic/AGENTS.md)。查询或路径迁移不重建知识；确实修改权威数据或生成器时再同步派生产物。
- 引用仓库文件使用相对链接；课程数据使用课程内稳定 ID 与相对路径。历史测量中的旧绝对路径只描述原环境。
- 旧版课程备份先停止服务，再复制完整课程目录；运行中数据库不能仅复制主文件。Git 不包含原始课程资料和个人数据库。
- 测试副本、缓存和临时端口在验证后清理；独立实验的最终截图、原始结果和许可说明属于保留证据。
