# 0.1.18 验证范围 / Validation scope

仅发布准备，未发布。冻结 route-repair 候选功能，SHA256 `8abac25e277a637d41848a066f7952ae5b98922e8c3bf5066324dd5ac3eeb37a`，154 个运行模块。最终提交重建包需逐模块与该候选一致；文档和提交固定链接变化单独审计。

## 现场证据

2026-10-25 08:48:38.863 UTC 新 switch-verified；154 个模块匹配，两宿主安装后激活，pending=false、操作锁和恢复锁均无，两个参与者 release 成功，无待恢复标记或新持久化失败。只读收尾核验未调用真实账号 RPC。日志不足以判断 route-proof 分支本次是否执行，不能把该次成功当作共享日志修复分支的直接实机验证或宣称根治。

此前 parallel-verification 双窗口成功可作为既有流程证据，未观察到明显提速。不再性能优化。

## 云端验证

修复后完整检查：主套件 2327 通过、4 跳过，Windows 合成套件 107 通过，零失败；包含类型、lint 和架构检查。独立审查完成，所发现的恢复入口、事务绑定及清理问题已修正。

合成回归覆盖共享 inode 初次证明丢失、A 证明取得后 B 覆盖日志、PID/birth/API generation 失效、新增或替换窗口不扩大确认范围、停止/启动失败、取消、崩溃前后派发歧义和持久恢复。测试不冒充官方真实 RPC 或全平台验收。

## 限制与恢复

官方启动可能等待用户 retry。持久化派发标志与实际启动之间崩溃时不能可靠区分是否已派发，因此只观察而不重复启动；可由官方 retry 或明确提示的保存后重载受影响窗口恢复。只有确认旧宿主和记录的后台出生身份退出才能清理无账号写入的恢复义务，不将此清理称作切号成功。

保留账号备份、互斥、写前比对、fresh 身份核验和未知新凭据不覆盖。仍存在官方在途恢复的工程残余竞态；不承诺所有未来进程均被技术封锁。

## English

The 154-module review candidate completed a native Windows + WSL two-window switch at 08:48:38.863 UTC with both participants released and no pending recovery or locks. Whether the route-evidence repair branch ran is unknown. Cloud tests cover that branch with synthetic fixtures, not real official RPC. Runtime modules must remain byte-identical in the final committed build; documentation changes are audited separately. Publication, native installation and any further account operations require separate authorization. No all-platform or race-free guarantee is claimed.
