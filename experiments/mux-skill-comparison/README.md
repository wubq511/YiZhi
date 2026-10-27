# 同一个 MUX 例题：三种 Skill 的实际效果

核查日期：2026-10-24。直接打开 [统一对比页](index.html)，或分别打开以下演示。目录中保留本地运行资源，不需要安装 Skill。

| 演示 | 可以实际体验什么 | 更适合什么 |
| --- | --- | --- |
| [visual-explainer](visual-explainer-mux.html) | 点击 x/y/z，选中端、通路、输出与四组结果同步变化 | 理解机制、验证自己的判断 |
| [fireworks](fireworks-mux.html) | 查看整图、缩放、导出 SVG/图片 | 静态复习讲义、打印和分享 |
| [Excalidraw](excalidraw-mux.html) | 点击“进入可编辑画布”，拖节点、改字、连线，下载修改后的源文件 | 亲手整理与持续修改图解 |

这次实测后，我更推荐 **visual-explainer 用于弄懂 MUX 的选择机制**；fireworks 用于整理一页复习图；Excalidraw 用于自己动手改图。若主要目标仍是查询“先学哪些知识”，先前的 [Archify](../archify/archify-mux.html) 更直接。这几种能力不能用单一“最好看”排名代替。

所有样例使用同一份 [brief.json](brief.json)：`F(x,y,z)=Σm(1,2,6,7)`，`S1=x, S0=y`，`I0=z, I1=¬z, I2=0, I3=1`；四组取值、四个概念、三条有标签的前置边及课件来源均保留。这是表达方式与产物能力对比，不是各工具自动从 PDF 抽取知识的准确率测试。

## 实际验证

- visual-explainer：官方 kit 生成；纯模型 8/8 通过，另在真实浏览器点击全部 8 组输入，确认选中端、分组与输出一致。已检查电路图、前置图和来源的显示，修正标题宽度。[验证记录](browser-verification.json) · [截图](visual-explainer-preview.png)。
- fireworks：官方 JSON → SVG → PNG/HTML 流程完成；XML、markers、collisions、geometry、composition 五项检查通过，独立布尔枚举 8/8 通过。PNG 已目检，原生查看器已打开并测试放大、复位；未逐项测试复制、主题及全部导出格式。[详情](fireworks-notes.md) · [高清 PNG](fireworks-mux.png)。
- Excalidraw：手工编写原生 35 元素场景，结构与绑定检查通过；使用官方组件 0.18.1 实际渲染并导出 SVG、2320×1984 PNG，已目检。真实画布拖动 F 节点后连线跟随，下载 JSON 中坐标更新；撤销成功。试改未写入交付源文件。[原生源文件](excalidraw-mux.excalidraw) · [高清 PNG](excalidraw-mux.png)。

浏览器验证使用 CUA。visual-explainer renderer 使用 `--no-check`，没有声称通过其自带浏览器门禁；Excalidraw 使用同一官方组件的浏览器导出 API，没有运行 Skill 配套的 headless Playwright 脚本。最后将 Excalidraw 初始适配系数从 0.84 降为 0.70，为工具栏留白；该最后参数未再次截图。

## 版本与交付边界

| 来源 | 固定版本 |
| --- | --- |
| [visual-explainer](https://github.com/nicobailon/visual-explainer) | Skill 0.14.0，commit `5f378868e0ea745a6284b51e710c390f0c76f72c` |
| [fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph) | 1.2.0，commit `1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f` |
| [excalidraw-diagram-skill](https://github.com/coleam00/excalidraw-diagram-skill) | commit `8646fcc9f74f38539c6cdb4c969723336a96ddcd` |
| Excalidraw 原生组件 | `@excalidraw/excalidraw 0.18.1`、React/ReactDOM 18.3.1；本地打包，不依赖先前失败的在线 ESM 导入 |

Excalidraw 的 HTML 外壳仅负责载入、预览、编辑和下载本地场景，图形与编辑器由官方组件提供。修改需下载保存；它不会自动覆盖磁盘源文件。页面预置真实导出 SVG，供编辑器尚未加载时查看。页面测试采用本机 HTTP；直接以文件方式打开的浏览器兼容性未实测。

fireworks 是通用技术图，不能将其几何校验算成电气功能验证；本图展示选择机制，不是逐引脚原理图。SVG/HTML 字体在其他设备上可能回退；PNG 固定了本轮字形。

本轮没有全局安装这些 Skill，没有上传或发布。上游 MIT 许可文本与组件依赖声明随产物保存；社区 Excalidraw Skill 的仓库许可未明确，本次未分发其全文或脚本。临时 clone、虚拟环境及打包依赖在收尾时清理，产物、源文件及复现记录保留。

## 复现

visual-explainer 与 fireworks 的完整固定版本、命令和依赖分别见 [visual-explainer-notes.md](visual-explainer-notes.md)、[fireworks-notes.md](fireworks-notes.md)。复现前重新 clone 到记录中的临时路径。

Excalidraw 的本地打包入口为 `excalidraw-runtime/entry.js`。在该目录执行 `npm install`、`npm run build` 可重建组件 bundle、CSS 与字体；直接依赖固定在 `package.json`，未保留含本机临时绝对路径的 npm lockfile。交付的 `editor.js` 已构建完成，无需重建即可使用。

迁入 YiZhi 后，重跑 Fireworks 构建需设置 `FIREWORKS_SOURCE` 指向原记录版本的外部源码目录；必要时以 `FIREWORKS_PYTHON` 指定其 Python。随附页面仍可直接查看，外部构建依赖未随本项目安装。
