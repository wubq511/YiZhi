# 第三方资源

直接 npm 依赖的版本由 `package-lock.json` 固定；各包许可原文随 npm 包保留。运行时不从网络载入课程、脚本或字体。

| 依赖 | 版本 | 许可 |
| --- | --- | --- |
| Electron | 45.0.0 | MIT；内含 Chromium／Node 等独立第三方许可，Electron 分发附带 `LICENSES.chromium.html` |
| React / React DOM | 19.3.1 | MIT |
| KaTeX | 0.19.1 | MIT；随包本地字体为 OFL-1.1 |
| esbuild | 0.28.2 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| Playwright Test | 1.64.1 | Apache-2.0 |
| @types/node | 24.19.2 | MIT |
| @types/react / @types/react-dom | 19.3.0 | MIT |

手写资源直接复制项目已存在的 WOFF2 分片，不改变字体轮廓或内嵌名称。Xiaolai 选择覆盖本单元载荷的 14 个原分片（约 740 KB），其他输入字符使用设计规定的系统回退；Excalifont 使用既有拉丁分片。原路径与 SHA-256 见 `fixtures/font-provenance.json`，正式应用只依赖 `desktop/` 内资源，不依赖实验目录。

- Xiaolai：Copyright © 2020 LXGW，[OFL 原文](licenses/Xiaolai-OFL.txt)。
- Excalifont：Copyright (c) 2024 by Excalidraw，[OFL 原文及内嵌元数据](licenses/Excalifont-OFL.txt)。许可根据 [Excalidraw 官方字体源码](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/fonts/Excalifont/index.ts)中的完整字体元数据核对。
- KaTeX 字体：[OFL 原文](licenses/KaTeX-fonts-OFL.txt)；打包时须同时保留 KaTeX 的字体许可与 Electron 完整许可文件。

| 依赖 | 版本 | 许可 |
| --- | --- | --- |
| @xyflow/react | 12.12.0 | MIT |
| roughjs | 4.6.6 | MIT |
| pdfjs-dist | 6.4.299 | Apache-2.0；本地 worker、CMap、标准字体、ICC 与 WASM 随包复制各自许可 |
| @napi-rs/canvas / @napi-rs/canvas-darwin-arm64 | 1.0.13 | wrapper 为 [MIT](licenses/native-canvas/wrapper/LICENSE)；macOS arm64 native 内含 Skia、Rust 与 C/C++ 的独立许可，见 [完整材料与精确源码链接](licenses/native-canvas/README.md) |
| @tiptap/core, @tiptap/pm, @tiptap/extension-document / paragraph / text | 3.32.0 | [MIT](licenses/Tiptap-MIT.txt) |
| ProseMirror model / state / view / history | 1.25.12 / 1.4.4 / 1.42.8 / 1.5.1 | [MIT](licenses/ProseMirror-MIT.txt)，完整传递版本由 lockfile 固定 |
| MathLive | 0.111.1 | [MIT](licenses/MathLive-MIT.txt)；本地 KaTeX 字体沿用 OFL-1.1 |

MathLive 从锁定 npm 包打包，字体复制到 `dist/renderer/mathlive-fonts/`，声音关闭；运行不依赖 CDN、云编辑服务或商业 Tiptap 扩展。以上编辑组件的许可原文与字体许可一起复制到 `dist/licenses/`。

器件样本中的 TI 74153 手册原页复制自已有实验资源；其来源版本和文件摘要见 `fixtures/t04-provenance.json`。该来源页仍保留其原始身份，并非新绘制材料。

## macOS arm64 native canvas

`@napi-rs/canvas@1.0.13` 的 wrapper MIT 不代表整个 `skia.darwin-arm64.node` 均为 MIT。其发布 SBOM 共 142 项；逐组件版本、原始许可／copyright／NOTICE／PATENTS、来源 URL、SHA-256、精确源码 archive 与范围记录见 [native-canvas manifest](licenses/native-canvas/manifest.json) 和 [阅读说明](licenses/native-canvas/README.md)。随该 binary 分发时保留 `licenses/native-canvas/` 整体与本文件。

材料包含 MPL-2.0 的 `cssparser`、`cssparser-macros`、`selectors`、`dtoa-short` 的原文／声明及[精确 Source Code Form 获取链接](licenses/native-canvas/README.md#mpl-20-原文与源码获取)，以及 Skia BSD、FreeType FTL、ICU 的 Unicode／历史及第三方条款、libjpeg-turbo 的 BSD／IJG／zlib 组合等；完整条款以上游原文为准。本地 `skia-fontations` 使用 Skia BSD 源码，不能归入 wrapper MIT。

Portions of this software are copyright © 2026 The FreeType Project (www.freetype.org). All rights reserved.

This software is based in part on the work of the Independent JPEG Group.

本材料保守保留 SBOM 全部组件及额外上游 notices；SBOM 含 build-dependencies、其他平台及工具记录，未证明的 runtime scope 在 manifest 中明确标出。这里不把这些记录都声称为 runtime，也不声称已完成对象级链接或可重现构建证明。最终安装包的复制与内容验证由打包流程完成。

## 工作区组件（2026-10-30）

外壳采用 shadcn/ui **Base UI / Nova** 的真实组件源码，本地组件为 Button、Dropdown Menu 与 Popover。原始 registry URL、下载摘要及本地定制范围见 [源码来源](licenses/shadcn/provenance.json)，[shadcn/ui MIT](licenses/shadcn/LICENSE.md) 随构建和打包保留。组件的图标占位符替换为 Lucide，菜单改为不透明背景，常用命中区调为约 40px。

| 依赖 | 精确版本 | 许可 |
| --- | --- | --- |
| @base-ui/react | 1.9.0 | MIT |
| lucide-react | 1.64.0 | ISC（包内保留衍生图标的 MIT 声明） |
| motion | 14.8.0 | MIT |
| cn | 0.5.0 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| tailwindcss / @tailwindcss/cli | 4.3.3 | MIT；仅构建工具 |
| shadcn | 4.23.0 | MIT；组件配置及构建 CSS |
| tw-animate-css | 1.4.0 | MIT；构建 CSS |

以上直接依赖及使用的 Floating UI、Motion、Base UI 等传递包许可原文和摘要见 [workspace-shell 清单](licenses/workspace-shell/manifest.json)。`build` 将其复制到 `dist/licenses/`；macOS 打包保留整个 `licenses/`、`dist/licenses/` 与生产依赖包中的许可证。运行不下载组件、样式或图标。
