# Antigravity Workbench 0.1.17

改善切号成功后的收尾恢复，并让后台状态更容易查看。

- 切号核验成功后，短暂的存储或清锁失败可继续重试，不再因界面关闭或旧回调中断已提交的收尾。
- 区分登录处理中、等待清理和状态未确认，提供对应的重试或重新检查入口；旧残留缺少完成证据时仍保留保护。
- 其他后台列表默认折叠，展开后查看状态和操作；进程详情按需显示，保留用户的展开状态。
- Linux / WSL 在有明确启动目录信息时显示关联工程名称；无法确认时显示“未识别”，不将工程关联当作窗口标题。Windows / macOS 暂不提供工程识别。

---

Improve completion recovery after account switching and make backend status easier to inspect.

- Retry transient storage or lock-cleanup failures after successful switch verification; closing the view or receiving an old callback no longer interrupts committed completion.
- Distinguish login in progress, cleanup pending and unconfirmed state, with retry or recheck actions. Older leftovers without completion evidence remain protected.
- Collapse other backends by default. Expand to inspect status and actions, with process details available separately and expansion choices retained.
- On Linux / WSL, show associated project names when explicit launch-directory evidence is available. Otherwise show unidentified; an associated project is not a verified window title. Project identification is not yet available on Windows / macOS.
