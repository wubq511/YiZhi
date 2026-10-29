# 桌面开发工具

正式应用不提供旧版课程迁入或迁入记录查询。开发工具复用正式课程核心，输出课程由正式应用独立读取。

builder、测试启动器与 CLI 验证共用 `paths.mjs` 的 `developmentDirectory(projectDirectory = process.cwd())`。通过 Git common directory 找到原仓库，主 checkout 默认输出到原仓库 `artifacts/desktop-development/`；其他 checkout 输出到其下 `worktrees/<checkout 路径的 SHA-256 前 16 位>/`，不向工作树内写开发包，也不覆盖主 checkout 的包。查询路径不会创建目录。

可设置绝对路径环境变量 `YIZHI_DEVELOPMENT_OUT` 覆盖默认输出；相对路径会被拒绝。构建和后续测试／验证须沿用同一变量，显式目录仍应位于原仓库 `artifacts/` 的独立任务／运行子目录，遵守[本地产物管理](../../docs/development/本地产物管理.md)。

在仓库根目录运行（先安装 `desktop/` 的 npm 依赖，运行环境需 Node 24+ 与 Python 3）：

```sh
node tools/desktop/build.mjs
development_out="$(node --input-type=module -e 'import {developmentDirectory} from "./tools/desktop/paths.mjs"; console.log(developmentDirectory())')"
node "$development_out/cli.cjs" convert '{"sourceDirectory":"/absolute/stopped-legacy-course","directory":"/absolute/new-candidate"}'
```

`convert` 仅转换已有知识、稳定 ID、布局与资料，得到内容候选，不包含完整个人记录；需要全量迁入时继续运行：

```sh
node "$development_out/cli.cjs" migrate '{"sourceDirectory":"/absolute/stopped-legacy-course","contentCandidateDirectory":"/absolute/new-candidate","directory":"/absolute/new-complete-course","operationId":"unique-migration-id"}'
node "$development_out/cli.cjs" records '{"directory":"/absolute/new-complete-course","limit":30}'
node "$development_out/cli.cjs" history '{"directory":"/absolute/new-complete-course","limit":30}'
node "$development_out/cli.cjs" pending '{"directory":"/absolute/new-complete-course"}'
```

源课程必须正常保存并停止旧服务；锁租约、旧窗口保存屏障、记录核对与唯一发布沿用原协议。`migrate` 在同一进程 prepare→publish，完成后释放源租约。单独 `prepare` 用于检查未发布准备；CLI 退出后租约已释放，后续应使用同身份 `migrate` 重新核对并发布。准备后的目标不可直接作为正式课程写入。

中断后使用相同参数／身份重试 `migrate`；`status` / `recover` 接受 `directory`，`transition` / `abandon` 接受 `sourceDirectory` 和 `operationId`。`operation` 接受课程 `directory` 与原 `operationId`；`content`、`records`、`history`、`pending` 接受课程 `directory`，支持原 API 的分页字段。`snapshot` 接受源 `sourceDirectory` 与全新 `directory`，生成一致副本；它不执行转换。

编程接口为 `DevelopmentCourseService`（`course-service.ts`），构造器传入 `join(developmentDirectory(), 'worker.cjs')`。正式 `CourseService` 只保留课程资源读取和历史兼容，不提供这些开发命令。开发输出和 Python helper 只进入上述开发输出目录；正式 `--production` 构建不带入它们。

## 可控生产者与完整副本验证

可控生产者有[独立 Electron 入口](controlled-README.md)，正式学习窗口不提供开发开关。内容候选核验使用 `node tools/desktop/verify-conversion.mjs verify /absolute/content-candidate`。

验证窗口复用正式工作区与核心，额外桥接仅由独立开发入口注册，用于输入保护、候选冲突、停止和真实保存回归。`verify-upgrade.mjs` 核对完整个人课副本的历史、任务和资源，不以开发验证结果替代真实 Agent 或正式安装包验收。
