# macOS 本地应用包

在当前架构的 macOS 上执行：

```sh
cd desktop
npm ci
npm run package:mac -- --out=/absolute/new-output
```

当前核验产物为 `new-output/YiZhi-darwin-arm64/YiZhi.app`。脚本要求原生二进制与所附许可清单的架构、大小和摘要一致；现有清单只覆盖 macOS arm64。其他架构需先准备并核对对应发布输入的许可材料。输出目录必须尚不存在；不交叉构建其他平台。将完整 `.app` 拷贝到应用程序目录即可保留运行时和许可文件。课程数据在应用外独立保存；可通过“课程”菜单打开既有课程目录，或使用 `YiZhi.app/Contents/MacOS/YiZhi --course=/absolute/course`。

打包会重新构建，依锁文件从本机 npm 缓存安装生产依赖，包含共享 Worker、SQLite 所属 Electron 运行时、本地 PDF.js worker／字体／CMap／ICC／WASM、原生 Canvas、扩展和字体许可。测试、source maps 和开发工具不进入运行目录。`Contents/Resources/app/package-manifest.json` 记录版本、架构、锁文件摘要、生产依赖及许可文件；Electron 与 Chromium 完整许可也位于 `.app` 内。

脚本核对应用内原生依赖的全部许可材料摘要，包括隐藏的上游来源记录。当前脚本创建 **本机 ad-hoc 签名**，并执行 `codesign --verify --deep --strict`；没有开发者发行签名、公证或自动更新。这是可检查的本地应用产物，不表示已发布。

独立安装回归：

```sh
YIZHI_PACKAGED_APP=/absolute/YiZhi.app npx playwright test tests/packaged-app.spec.ts
```

该检查将应用复制到仓库外的新安装位置，从空工作目录和最小 PATH 启动，阻断 HTTP(S)，明确使用缺失执行器，验证实际 Electron 运行时、离线 PDF 文字层、Core 原生图片解码、正文保存与重开。文件选择对话框只替换返回路径，后续导入和读取真实执行；不代替原生选择器与实体输入验收。未提供环境变量时明确跳过，不计作安装通过。

完整迁移课程、约 500 单元增长负载、公平性与实体鼠标／触控板／中文输入法等组合验收仍由 T28 单列记录，不能从这条小范围安装回归推断。

组合 harness、最终输入和被动实体观测工具见 [macOS 连续学习验收工具](macos-acceptance.md)。最终产物与证据应保存到 persistent scratch，不能只放在可能归档的实现工作树内。
