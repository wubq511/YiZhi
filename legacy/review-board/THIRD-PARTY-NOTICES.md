# 复习画板第三方资源

现有 Xiaolai、MathLive、KaTeX 字体和 Rough.js 的来源与许可见[原型资源声明](../../experiments/style-math-prototype/THIRD-PARTY-NOTICES.md)。

## Excalifont

正式画板复用仓库中 `mux-skill-comparison/excalidraw-runtime/fonts/Excalifont/` 的原始 Latin WOFF2 分片（`a88b72a24fb54c9f94e3b5fdaa7481c9`），用于手绘正文中的英文字母、数字与标点。文件大小 24,956 字节，通过 `unicode-range` 按需加载；未修改字体文件。

- 官方介绍：https://plus.excalidraw.com/excalifont
- 分片及原始许可声明：https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/fonts/Excalifont/index.ts
- 版权：Copyright (c) 2024 by Excalidraw. All rights reserved.
- 许可：[SIL Open Font License 1.1](licenses/Excalifont-OFL.txt)，从上述官方源码保留。

中文继续使用 Xiaolai；数学公式由 MathLive 及随附数学字体排版；表格使用界面字体与等宽数字特性，便于逐列核对。
