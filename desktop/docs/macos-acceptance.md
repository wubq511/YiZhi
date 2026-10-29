# macOS 连续学习验收工具

这些工具记录 #29 的实际组合证据；结果与实体操作记录单独保存在指定的 persistent scratch。跳过的 opt-in 测试不计通过，程序输入、浏览器 rAF、减少动效模拟与实际实体设备使用分别记录。最终迁移、500 单元和安装验收必须先取得 parent 明确确认的 T25/T26 最终集成输入。

先在当前树 `npm ci`、`npm run build`。本树独占 `dist`。独立小样本检查：

```sh
node --test dist/tests/acceptance-input.test.cjs \
  dist/tests/acceptance-observation.test.cjs \
  dist/tests/acceptance-fairness.test.cjs dist/tests/growth-fixture.test.cjs

YIZHI_ACCEPTANCE_SMOKE=1 YIZHI_EVIDENCE_DIR=/persistent/t28-artifacts/harness-small \
python3 /absolute/run-ui-serial.py npx playwright test tests/acceptance.spec.ts \
  --grep 'small development' --output=/persistent/t28-artifacts/small-ui
```

小样本使用生成课程，覆盖同应用两课共享 Core、B 在真实 dirty-index 批次／正式历史预览／PDF 解析期间读写、导航与局部展开、输入和选区保护、跨控件 Undo、未完成公式草稿、实验离屏续接、PDF 切页、窄窗键盘焦点和模拟减少动效。它不提供最终迁移课／500／安装或实体输入结论。

最终输入就绪后，先合入 parent 指定的最新 integration。停止并复制最终迁移课程；如果输入是完整备份，先由最终 Core 的 `backup.verify` 核对归档，再复制到新恢复目录，之后才打开写入。不能把内容交换包当完整备份，也不能手造或重封目录 authority marker。

增长工具只操作新副本，要求 source 的 WAL 已关闭／checkpoint，正文已完整物化。它先用指定 Worker 正常打开目标，再追加明确合成的单元／块／布局身份；原 payload 字节、revision 和 ID 保持，关系与资料不伪造。再次 Core 打开／逐个读取新增单元，并保存 `growth-fixture.json`。marker 保持原字节，任何 admission 拒绝都必须由实际 authority 能力解决。

```sh
node scripts/prepare-growth-fixture.mjs \
  --source /persistent/final-restored-copy --target /persistent/t28-artifacts/growth-500 \
  --total 500 --worker /absolute/this-tree/desktop/dist/worker.cjs

npm run package:mac -- --out=/persistent/t28-artifacts/package-FINAL-SHA
```

提交源码后才生成最终包。包清单记录 source commit、dirty 状态和实际交付入口摘要；最终测试拒绝 dirty／旧来源包。parent 的最终 run input 使用 `yizhi-t28-final-input-1`，包括 `parentConfirmedFinal: true`、`parentFinalEvidence` 路径、40 位的 `t25FinalSHA`／`t26FinalSHA`／`integrationSHA`／`sourceSHA`，以及 `app`／`growthCourse`／`migratedCourse` 绝对路径。这是外部验收输入记录，不是课程 authority 协议。

```sh
YIZHI_ACCEPTANCE_INPUT=/persistent/t28-final-input.json \
YIZHI_EVIDENCE_DIR=/persistent/t28-artifacts \
python3 /absolute/run-ui-serial.py npx playwright test tests/acceptance.spec.ts \
  --grep 'final installed' --output=/persistent/t28-artifacts/final-ui
```

测试复制完整 `.app` 到 persistent `Applications`，使用空 cwd、最小 PATH、缺失执行器和断网启动，记录实际运行时及文件摘要。500 个节点逐一导航；在合成单元上准备真实历史与编辑，在同 app 的不同 courseId 上核对重叠读写，检查已迁移原件首屏、保存、重开及原始 payload/revision 保全。成功后写 `physical-input.json`；实体验收仍由 parent／Robert 操作。

`YIZHI_OBSERVE=1` 启用宿主只读 Core 观测与 renderer 聚合器。计数覆盖阅读／编辑／MathLive／实验实例、PDF 文档和 range cache、正文缓存、测量元数据／待处理项／布局批次、事件保留／游标落后／消费批次与 Core 排队。JSON 还记录设备、macOS、runtime、viewport/DPR、RSS/heap、程序输入／保存／导航时序、rAF 直方图和 longtask。观测不设新的 FPS、内存或时延验收阈值；DOM 峰值采用 mutation／100ms 采样，资源生命周期计数另列，Core RSS 与宿主是同一进程，不能相加。

可从原始 JSON 生成带缺口说明的只读指标表：`node scripts/report-t28.mjs --input /persistent/measurement.json --output /persistent/new-report.md`。报告保留 preparation／最终自动检查／实体未验的区别；输出已存在时拒绝覆盖。

实体工具可以脱离工作树保存，先 build，再执行：

```sh
node scripts/stage-t28-physical.mjs --out=/persistent/t28-artifacts/physical-harness
python3 /absolute/run-ui-serial.py \
  node /persistent/t28-artifacts/physical-harness/t28-physical.cjs \
  --input /persistent/t28-artifacts/installed-RUN/physical-input.json
```

指标采集本身被动；`sample LABEL` 取样，`mark CATEGORY pass|fail|unverified NOTE` 保存操作者声明，`quit` 收尾并关闭应用。`background` 是受控正式更新，仅在实际检测到 live composition 且目标是合成单元时，通过正式提交路径更新独立段落；它不发送 composition 或键盘事件，也不是模型调用。通过父任务向 PTY 发送命令，避免切换到终端打断候选。未记录实体结果的项目始终保持未验。

`wheel-start LABEL`／`wheel-stop` 收集最多 512 条原始 wheel 事件（delta、mode、修饰键、目标区域及事件阻止状态），记录丢弃数与前后精确相机；监听器不改写事件。`isTrusted` 也不能单独证明实体输入，需关联实际操作者和设备说明。复验捏合前通过正常目录导航进入中间倍率，先排除上下限截断；硬边界与指针锚点仍由受影响回归检查。

`arm-background` 提前布置一次独立更新，在下一次真实 trusted compositionstart 后执行，避免操作者切回聊天打断候选；`disarm-background` 取消。正式回执和 composition 前后状态均保存，候选已结束或焦点不在应用时不计重叠通过。此命令不生成输入，也不是模型调用。

前后两端均 active/trusted 不证明同一次 composition 始终未结束；必须保留 starts/ends 计数并单独记录操作者对候选、焦点与文本的观察。控制通道丢失时不回填原 session 的 mark/final/raw；如从仍存活的 renderer 恢复环形 buffer，另存恢复身份、total/dropped/limit，原起点相机不可得就记录 null。原入口总是 launch，没有 attach/resume；不能为恢复采样而重启仍在使用的应用。

实体发现导致手势修正后，`YIZHI_GESTURE_INPUT=/persistent/corrected-input.json` 可选择 `tests/acceptance-gestures-installed.spec.ts` 做受影响安装检查。输入沿用 final schema，另包含实际 `courseDirectory`、`profileDirectory`、`evidenceDirectory`、`editableUnitId`；绑定 corrected clean source／真实包清单。它复用原 500 隔离课程，只检查修正手势、正文/草稿保全与重开，不重复 500 连续导航。旧完整负载证据和新受影响证据需同时保留；实体仍由操作者复验。

正文选区与 pinch 合并修正的安装检查使用 `YIZHI_SELECTION_INPUT=/persistent/combined-input.json` 和 `tests/acceptance-selection-installed.spec.ts`，输入字段同上。它按真实字符矩形及浏览器命中位置执行原生鼠标点击、同一行／换行拖选，核对 0.85 和 1.2 倍率的 caret 与 Range，未用编辑器选区命令代替；拖动分段同步浏览器绘制。pinch 检查只控制浏览器帧调度边界，保留实际应用、事件处理和视口 setter；验证帧前不重复发布、帧后累计结果及指针锚点，再核对正文／草稿重开。程序鼠标和帧调度控制仍不是物理输入或手感结论。

正文草稿恢复的非 GUI 公共回归为 `draft-navigation.test.ts`；可见正文／未完成公式在导航与正常重开后的回归为 `draft-navigation.spec.ts`。实际安装检查选择 `YIZHI_DRAFT_NAVIGATION_INPUT=/persistent/corrected-input.json` 和 `tests/acceptance-draft-navigation-installed.spec.ts`：复用已关闭的既有 500 课程完整副本与独立 profile，不重新增长或改写原草稿。核对可见正文等于持久 patch.after、未完成公式保留、正式公式／独立段／正式单元不被覆盖。课程整体 revision 增长不替代目标 payload 和结构依据核对；同处冲突仍保留供显式处理。

包来源、自动验证来源和最终文档来源分别记录。仅测试观测或文档发生变化、真实运行时输入不变时，保留原包及其 manifest，不为改写来源身份重打相同包；保留实际通过的验证 revision 和后续差异。公有读取与可见内容的比较须限定在同一交互区间，不能把主动导航前的相机变化算作面板漂移，也不能只比部分 ReadingState 字段。

按实际覆盖记录 T-10 环境轴。画板 pinch／Cmd+wheel、DPR、窄窗口或 CSS/root 字号模拟不等于实际 OS 系统字号／文字缩放；后者未操作系统设置就保持 unverified。系统 Reduce Motion 的实际设置与浏览器模拟分别记录；Playwright 默认媒体覆盖若通过 `no-override` 清除，应明确注明这项测试设置。字体失败回退需真实请求失败、平台 glyph 与截图证据，不能从 computed font-family 推断。macOS Electron 结果不外推 Safari、Windows 或其他设备；T28 六条验收与环境覆盖分别报告。
