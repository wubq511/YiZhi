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

实体工具可以脱离工作树保存，先 build，再执行：

```sh
node scripts/stage-t28-physical.mjs --out=/persistent/t28-artifacts/physical-harness
python3 /absolute/run-ui-serial.py \
  node /persistent/t28-artifacts/physical-harness/t28-physical.cjs \
  --input /persistent/t28-artifacts/installed-RUN/physical-input.json
```

工具只被动观测；`sample LABEL` 取样，`mark CATEGORY pass|fail|unverified NOTE` 保存操作者声明，`quit` 收尾。`background` 仅在实际检测到 live composition 且目标是合成单元时，通过正式提交路径更新独立段落；它不发送 composition 或键盘事件。通过父任务向 PTY 发送命令，避免切换到终端打断候选。未记录实体结果的项目始终保持未验。
