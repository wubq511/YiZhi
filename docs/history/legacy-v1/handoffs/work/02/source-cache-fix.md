# SourceLibrary.page_image 缓存并发修复

日期：2026-10-26。已完成独立红测、修复和指定范围绿测。

## 结论与归因边界

实际阅读了 `复习画板/reviewboard/sources.py`、`material_sources.py` 及两份对应测试。旧 `page_image` 将公开 target 的无后缀路径直接传给 `pdftoppm`；工具写文件期间，第二个调用会因 `target.is_file()` 命中而返回半成品。两个调用均在文件出现前进入时，又会重复生成。非零退出分支还会 unlink 公开 target，可能删除其他发布者已经完成的缓存。

这些问题已由直接调用真实 `SourceLibrary.page_image` 的测试复现，但不能据此认定它们就是主线原 HTTP 故障的原因。主线的 `request_queue_size=128`、真实 12 并发热缓存请求和 HTTP 回归 6 项通过，以及原故障为 connection reset，均属于任务传入上下文，本次未重新验证，也不改变其归因。

## 修改范围

只写入以下三处：

- `复习画板/reviewboard/sources.py`
- `复习画板/tests/test_sources.py`
- `.scratch/review-board-v1/work/02/source-cache-fix.md`（本记录）

源码修复使用标准库：实例内按缓存 target 保存 `Lock`，注册锁只保护锁字典；每页锁覆盖缓存检查、生成和发布，同页等待者取得锁后重新检查缓存，不同页可同时渲染。锁保留至实例释放，不在等待者仍可能持有引用时移除。

`pdftoppm` 输出改到 cache 文件系统上的私有 `TemporaryDirectory`，仅在进程成功退出后使用 `Path.replace` 原子发布完整输出。非零退出、缺少输出、超时、工具缺失及其他 `OSError` 统一转为 `StoreError(code="source_unavailable")`，退出上下文清理私有目录，失败路径不再 unlink 公开 target。

`_source`（含路径范围和版本摘要）与 `_pdf_location` 页码校验仍在任何缓存命中之前执行，未修改校验逻辑或资料来源。`MaterialSourceLibrary` 沿用继承的方法，未修改该类。未新增第三方依赖。

## 正确的并发 seam

新测试 `PageImageCacheTests` 使用独立临时资料和真实 `_source` 摘要校验，仅用 fake `subprocess.run` 控制渲染行为；不替换 `page_image`。两个线程实际调用同一个 library 的同页方法，返回后立即读取字节，避免先等待渲染结束再读而掩盖问题。

- 同页两种时序：第一渲染尚未创建输出、第一渲染已写出 PNG 的前半段。`rendering` Event 发出后才启动第二调用；包装 `_pdf_location` 调用真实校验并通过 `second_validated` 确认第二调用确已进入方法；`finish` Event 控制补写及进程成功返回。读取完整字节、不得提前返回、公开 target 不得中途出现、只渲染一次和最终无临时残留均有断言。等待窗口为 0.2 秒，事件/线程结果的 5 秒上限用于避免测试挂住；没有使用 sleep。
- 不同页两个调用：两个 fake renderer 都须在 `finish` 释放前发出 started Event，实际证明无全局渲染串行锁。
- 五类失败：非零退出、成功退出但无输出、TimeoutExpired、FileNotFoundError、OSError；验证错误码、无私有残留、随后能成功重试。
- 模拟独立发布者在本次渲染期间写好公开缓存，再让本次渲染非零退出或超时；验证完整缓存保留且后续命中不再次调用工具。这里的另一发布者是受控文件发布，并非额外真实进程。

## 红测命令与实际结果

cwd 必须是 `/Users/robertwu/Documents/大二上/数字逻辑与部件设计/复习画板`。

新增测试后、修改源码之前连续运行两次：

```sh
rtk proxy python3 -B -m unittest discover -s tests -p test_sources.py
```

两次退出码均为 1：

```text
Ran 7 tests in 0.538s
FAILED (failures=2, errors=5)

Ran 7 tests in 0.523s
FAILED (failures=2, errors=5)
```

两次均精确复现以下两个并发子用例失败：

```text
partial_output=False: AssertionError: 2 != 1 : same page rendered twice
partial_output=True: AssertionError: ... : a concurrent caller read a partial PNG
```

5 个错误分别来自失败者删除另一发布者缓存后的再次读取，以及未转换为 StoreError 的 timeout（两个用例）、工具缺失和 OSError。不同页并发及原有 3 项测试通过。unittest 将子用例分别计入失败/错误数量，因此数量不等于测试方法数量。

## 修复后绿测命令与实际结果

相同 cwd，只运行指定源测试及继承检查：

```sh
rtk proxy python3 -B -m unittest discover -s tests -p test_sources.py
```

```text
Ran 7 tests in 0.718s
OK
```

```sh
rtk proxy python3 -B -m unittest discover -s tests -p test_material_sources.py
```

```text
Ran 8 tests in 0.165s
OK
```

无 skip。原有源测试实际渲染课程 PDF；继承检查也实际渲染两个教材版本为 PNG，验证版本区分仍成立。测试创建的临时资料、输出与缓存由 TemporaryDirectory 清理，无需保留额外脚本或输出文件。

## 已知边界

- 去重锁作用于同一个 SourceLibrary 实例中的线程；不同实例/进程仍可能重复渲染，但各自使用私有输出并原子发布，失败者不删除公开缓存。本次未引入进程间锁。
- 渲染成功以工具退出码和可发布输出为依据，不增加 PNG 解码校验，也不主动检测/修复历史已存在的损坏缓存。
- 保留原 60 秒工具超时；这不是 HTTP 队列、连接或压力验收测试。未运行全套测试，未启动或停止服务，未使用浏览器，未修改 http/service/provider/app、canonical、票据或其他类。
