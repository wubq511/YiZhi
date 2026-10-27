# TH-07 第二批候选交付（2026-10-26）

KU-032、KU-033 两个目标已完整落盘于 `units/`，可供主线逐块审核。032保留既有讲解及稳定块ID并修错，033补齐五种代数方法、完整例题和练习。本记录仅确认候选正文、原页及计算/schema核验。

## 内容与修正

- KU-032：明确两级表达式先项数、再总文字数的比较口径。分别证明F=AB+BC+AC、G=AB+BC各自最简，用101说明不同函数不能替换；补课件六输入因式分解例，直接SOP为5门/17输入脚/2级，分解后为4门/9脚/3级，交代门库与成本前提。
- KU-033：并项、吸收、消去、消项、配项均有恒等式及理由；Q-106与Q-107均有完整题干、逐步推导、最简覆盖证明及接线说明。先验证等价再判断最简，不把局部不能并项当作全局证明。
- 正式题提案仅保存在KU-033的 `questionUpdates`：Q-106、Q-107，包含完整stem、solution、answerNature，待主线统一。

## 实际查看的原页

已通过 `view_image` 实际看过13个不同来源页，复用已有页图：

- SRC-C02 PDF50～61，`pages/c02-p<N>-<N>.png`。
- SRC-EX07 PDF8，`pages/ex07-full-08.png`。

引用版本为C02 `VER-SRC-C02-1c152428693e`、EX07 `VER-SRC-EX07-94ba9b89b204`。脚本重新计算原件SHA-256并比对版本元数据；没有将OCR或历史审计输出当成原页核对。

## 实际验证

从项目根运行：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 .scratch/review-board-v1/work/02/TH-07/verify_candidate.py
PYTHONDONTWRITEBYTECODE=1 python3 .scratch/review-board-v1/work/02/TH-07/verify_candidate.py --all
```

本章通过103项检查，含5个最简案例；九单元合并通过930项检查、40个最简案例。每次均重新使用正式CLI查询identity/outcome/internals/direct questions，并把实际候选reading及对应questionUpdates应用到完整地图的内存深副本，`validate_reading`无错误。所有JSON可解析，coverage目标与正式outcome一致。

验证器从实际题干读取布尔式/最小项/d，从实际答案表读取待验证结果，独立枚举全部真值、全部3^n子立方体及最优覆盖；没有读取旧audit答案。另核验五种方法恒等式、门数/输入脚/最长级数。共同引擎的内存错误注入已确认能拒绝错误答案、错误必要质蕴含标记和错误共享接线，未落盘坏数据。

## 交接边界与未完成项

本章候选正文无缺稿或计算待核项。正式组包、共享题冲突统一、provider/浏览器阅读与正式导入由主线处理，本轮未执行，也不宣称通过。未启动服务、未修改canonical/票据/其他章节或第一批TH03/04。旧audit、verification.json、package/map-preview均为历史资料，不作为本轮验证结果。
