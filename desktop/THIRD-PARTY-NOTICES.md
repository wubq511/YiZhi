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
