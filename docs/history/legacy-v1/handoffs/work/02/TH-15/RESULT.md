# TH-15 移位器：完成记录

- 范围：仅 KU-067，未改身份、评级、关系或其他单元。
- 原页：实际查看 C05 P59–P61；放大 P60 ror2 行。P60 第二列为常量 0，P61 的逻辑拼接为 d1,d0,d3,d2，正文明确差异并按循环定义复核，不将漏字当规则，不教授 HDL。
- 独立验证：`python3 .scratch/review-board-v1/work/02/TH-15/verify.py`，16 个输入×8 个控制码共 128 组全部通过，结果在 `verification.json`。
- 临时预览：`build_package.py` 生成 package；`复习内容.py import --map TH-15/map-preview.json --package TH-15/package.json` 成功；正式 `get KU-067` 返回 complete、7 个顶层块、1 个 coverage。
- 正式集成：串行导入 CP-TH-15-20261025-v1；源检查、build、完整 check 与知识地图 25 项测试通过。
- 浏览器：正式 CourseService 中 TH-15 新主题和语义图可见；控制表、ror2 差异说明、完整例题和自测答案沿正式 provider 阅读。完整单元计数随后更新为 6。
- 未解决事项：无。
