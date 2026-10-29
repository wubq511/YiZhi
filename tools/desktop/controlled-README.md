# 可控生产者验证入口

正式应用仅包含学生工作区。可控生产者使用独立 Electron main、preload 和 renderer，不通过正式应用的环境开关启用。

在 `desktop/` 执行 `npm run build` 会一并构建开发工具；`npm run build -- --production` 不构建开发工具。开发输出由共享 helper 解析到原仓库 `artifacts/`，其他 checkout 使用独立子目录；绝对路径环境变量 `YIZHI_DEVELOPMENT_OUT` 可统一覆盖 builder 和消费者。完整路径规则见[桌面开发工具](README.md)。

从 `desktop/` 启动验证工作区：

```sh
development_out="$(node --input-type=module -e 'import {developmentDirectory} from "../tools/desktop/paths.mjs"; console.log(developmentDirectory())')"
./node_modules/.bin/electron "$development_out/controlled-main.cjs" --course=/absolute/path/to/temporary/course
```

只使用测试课程或已批准副本。面板会执行真实课程提交、保存、停止与冲突处理。`window.yizhi` 保持正式学生能力；开发生产者仅通过独立 preload 提供的 `window.yizhiControlled` 使用命令接口。

生产者相关 UI 回归由 `desktop/tests/controlled-launch.ts` 启动这个独立 executable；其他测试继续使用正式应用。正式 bridge 边界由 `product-boundary.spec.ts` 验证。开发代码类型检查：

```sh
./desktop/node_modules/.bin/tsc --noEmit -p tools/desktop/tsconfig.json
```
