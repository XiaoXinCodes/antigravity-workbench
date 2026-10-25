# 切换与恢复 / Switching and recovery

在目标账号卡片点击“切换”，确认任务中断范围后，由 Workbench 核验同一登录范围内的相关后台、等待退出、写入一次、恢复后台并重新核验身份。普通切换不要求恢复密码、外部终端或关闭整个 VS Code。操作期间不要在其他窗口并行切号、重新登录或手动重连后台。

进度直接显示在目标账号按钮附近。窗口数量只表示当前恢复或核验阶段已处理的数量，不等于整次切换成功；最终结果以新取得的服务端身份和事务提交为准。

账号已提交但后台收尾未完成时，工作台分别显示两种状态，不自动写回旧账号。按提示重试恢复；只有明确安装或提交证据才提供宿主重启恢复。该退路需要用户确认，可能中断同窗口其他扩展、调试或任务；不修改 VS Code 的登录、profile 或同步配置。

未知新凭据不会被自动覆盖，唯一备份不会因超时删除。历史离线事务继续提供其原有读取、取消和恢复入口；它们不是新切换的默认流程，不要手动删锁或恢复材料。

兼容性以实际接口、配置、宿主与进程归属为准，不按官方版本号一律准入或拒绝。官方自身启动失败、无法确认存储范围或外部并发登录仍可能中断操作。当前有效自动恢复配置开启时，不应假定停止会取消所有在途恢复；按具体提示处理，Workbench 不会静默更改官方配置。

## English

Select an account and confirm the interruption scope. Workbench checks related backends, waits for their exit, writes once, restores backends and freshly verifies identity. The normal route requires no recovery password, external terminal or closing all VS Code windows. Do not switch, sign in or manually reconnect concurrently from other windows.

Progress appears beside the selected account. Window counts refer only to the current step. Account commit and incomplete backend cleanup are reported separately. Explicit host restart recovery requires installed/committed evidence and user confirmation; other extensions, debug sessions or tasks in that window may be interrupted. VS Code login, profile and sync configuration are not changed.

Unknown external credentials are not overwritten. Timeouts do not delete the only backup. Older offline transactions retain their original cancellation/recovery routes but are not the default for new switches. Compatibility depends on actual capabilities, configuration and ownership, not a version-number allowlist. Official startup or storage-scope verification can still fail; no unconditional success is promised.
