# React Flow 架构验证样例

这是系统架构讨论中的独立技术验证，用真实课程内容检查渲染与交互边界。它是候选渲染层实验，不替换正式应用，不锁定最终桌面／浏览器形态，也不替资料导入、知识抽取、生成、校验与发布全流程作架构选型。它不是最终视觉或布局方案，也未接入真实 Agent 和课程写入服务。

## 证据时点

`results.json`、`startup-trials.json` 和 [验证记录](验证记录.md) 属于动态补丁之前的固定尺寸 bundle，不代表当前代码的性能。原 bundle SHA-256 为 `43280ca582edd126035c12e8fb470efa6f79e56f187d20711c13aee5d0810f79`。本次没有重跑旧四场景全量基准。

动态补丁的代码 hash、实测矩形和检查结果独立保存在 [dynamic-results.json](dynamic-results.json)，结论见 [动态布局验证](动态布局验证.md)。

## 打开

在本目录运行 `python3 start.py`，打开 <http://127.0.0.1:8772/>。已保留构建产物，单纯查看无需安装 Node 依赖。服务只提供文件读取，不提供正式课程写接口。

默认仍是固定预测量布局。显式入口：

- [500 合成对象／动态局部让位](http://127.0.0.1:8772/?count=500&mode=managed&dynamic=1)
- [500 合成对象／固定布局基线](http://127.0.0.1:8772/?count=500&mode=managed&dynamic=0)

工具栏也提供模式切换，切换单元数／正文策略会保留动态模式。动态模式挂载正文后用实际 DOM 高度；原位材料展开、模拟段落持续增长会使碰撞链临时让位，收起从最新手动基线计算。拖动手势的位移合入基线，不把展开造成的临时位移固化。两个模式使用不同的样例 localStorage 命名空间。

可切换 84／500 单元、全量正文／按视野加载正文；500 单元由 84 个真实单元复制生成，副本有独立身份。点击“模拟实时修改”查看增量；滚轮或空白拖动接管视野，再用“返回并继续跟随”回到最新修改对象。文字、公式和实验输入自动保存在本样例专用的浏览器 localStorage 中。

“按需正文”在阅读尺度挂载可见范围及缓冲区内的完整内容，低倍率保留对象壳体和摘要；当前输入、选区拥有的对象保留现场。所有课程单元仍在数据中，显示范围不决定知识是否存在。

## 文件与复现

- [验证记录](验证记录.md)说明结论、测量范围与未覆盖项目；[results.json](results.json)保留机器输出。
- `fixture.json` 是只含课程视图的副本，无个人状态；`heights.json` 是当前宽度下 84 个原始单元的尺寸测量。布局采用简易分栏，不用于证明既定课程阅读顺序或正式局部让位规则。
- `src/main.jsx` 是验证源；`src/dynamic-layout.js` 实现固定宽度、向下投影的隔离算法；`dynamic-probe.mjs` 只验证动态组合路径；`dist/` 是生产模式构建；`probe.mjs` 进行四种负载测量及交互检查。
- `source-pages/` 保留正文引用的 20 张原页图片副本，避免把缺图当作完整负载。其余资源只读复用同一项目中的 `复习画板/web/content/`、样式演示的 MathLive／Rough.js 和 `期中/资源/`。保留项目目录关系即可运行，不是可脱离项目单独分发的包。

重建或复测，在本目录执行：

```sh
npm ci --no-audit --no-fund
npm run build
# 另一个终端保持 python3 start.py 运行
npm run calibrate
npm run probe
```

单独复现动态检查（不需要校准、旧全量基准或已有 8772 服务）：

```sh
npm ci --no-audit --no-fund
npm run build
npm run probe:dynamic
```

脚本自动启动专用随机 loopback 端口服务和全新 headless 浏览器上下文，结束时关闭；不会连接用户浏览器。保留 `dynamic-results.json` 和 `dynamic-preview.png`。本轮集成审查后已删除临时 `node_modules`，查看已构建样例不需要依赖。

单独复现动态增高与局部平移／缩放并发的 7 秒性能场景（先按上文安装依赖，已有最终 bundle 时无需重建）：

```sh
node dynamic-performance.mjs
```

结果保存在 [dynamic-performance.json](dynamic-performance.json)；负载、异常与解释见 [动态布局验证](动态布局验证.md)。脚本只跑这一条新场景，不调用旧四基准或 26 项功能检查；不设硬 FPS 验收门槛。

默认使用本机安装的 Google Chrome，不下载浏览器；其他安装位置可通过 `PROBE_CHROME` 指定。测量固定 1440×1000、deviceScaleFactor 1。更新课程副本时，先启动正式课程服务，再执行 `python3 prepare-fixture.py`；脚本经知识地图统一查询接口核对单元身份和 `sourceHash`，随后重新校准和复测。它只读取课程。

## 边界与依赖

此样例仅证明被检查的机制，不能充当正式应用验收。原生中文输入法、真实鼠标／触控板切换、跨浏览器、复杂实验的计时器暂停、长聊天、断线重放和正式存储耐久性均未在此验证。固定模式仍使用预测量；动态模式只验证当前固定宽度分栏负载的局部让位与前端组合流程，边界见动态报告。关系线绕行、片段标注及正式持久化未因此获得验证。

样例保留 React Flow attribution；新增打包运行依赖采用 MIT／ISC 等宽松许可，没有引入 tldraw、Pro 示例或生产授权密钥。[第三方声明](THIRD_PARTY_NOTICES.md)列出打包运行库；既有 [MathLive 许可](../style-math-prototype/vendor/mathlive/LICENSE.txt)和 [Rough.js 许可](../style-math-prototype/vendor/roughjs/LICENSE)随项目保留。

[设计取舍记录](../../docs/adr/设计取舍记录.md) · [返回演示索引](../README.md)
