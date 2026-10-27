# TH-18 二进制与 BCD 转换：完成记录

- 范围：仅 KU-077，未改身份、评级、关系或其他单元；KU-011 仅作知识引用。
- 原页：实际查看 C06 P37–P39，核对 4 位加 6 变体、8 位加 3 流程、修正时机和最后停止条件。
- 独立验证：`python3 .scratch/review-board-v1/work/02/TH-18/verify.py`，全部 256 个 8 位输入和 16 个 4 位输入通过，结果在 `verification.json`。
- 临时预览：`build_package.py` 生成 package；`复习内容.py import --map TH-18/map-preview.json --package TH-18/package.json` 成功；正式 `get KU-077` 返回 complete、9 个顶层块、1 个 coverage。
- 正式集成：串行导入 CP-TH-18-20261025-v1；源检查、build、完整 check 与知识地图 25 项测试通过。
- 浏览器：正式 CourseService 中 TH-18 新主题、知识引用和语义图可见；4 位与 8 位例题完整可读；练习“10000000₂ 的 BCD”揭示后显示逐轮修正和最终 128，重开保存正常。
- 未解决事项：无。
