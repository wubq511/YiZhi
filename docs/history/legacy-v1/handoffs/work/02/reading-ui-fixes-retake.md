# 正文渲染实测修正（2026-10-26）

1. 共享题解与作者完整children同时显示，导致解答出现两遍。现在有完整children时按其连续显示；无children时仍回退共享题解。
2. 原页figure图像按固有尺寸突破卡片边界。现在图片max-width:100%、height:auto，浏览器实测Q120原页宽815px，落在894px卡片内。
3. 画板平移是CSS transform。原生loading=lazy的图在画板平移后可能始终保持0×0、空白（KU014实际重现）；正文图改为正常加载并异步解码。来源页PNG有服务缓存，图片载入由ResizeObserver触发布局更新。

实际浏览器回归和全套测试由主线继续记录。

4. 全课刷新后多张原图偶发失败。诊断先区分PNG生成与HTTP请求：冷缓存4并发均得到完整PNG；热缓存12并发仍有3次Connection reset。最小TCP等待队列回归测试在旧实现稳定失败（12连接中7次重置），增加CourseHTTPServer.request_queue_size到128后HTTP六项测试通过。重启预览后原始12并发HTTP检查全部成功，见page-http-burst-fixed.json。提前公开未完成PNG是另一个源码并发窗口，由独立工作者在真实page_image并发seam验证并修复，不能把它与已确认的队列原因混称。
