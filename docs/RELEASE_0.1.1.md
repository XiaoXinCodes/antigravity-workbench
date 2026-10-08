# Antigravity Workbench 0.1.1

发布日期 / Release date: 2026-10-08 (UTC)

## 简体中文

- **官方登录直接同步。** 核验并显示新的官方当前身份，自动保存同宿主加密副本，不需再次手动保存。返回窗口立即检查，空闲时每五秒从本机 Hub 探测变化；同身份保留 ID 与标签。保存失败仍显示已核实身份。旧添加事务仅可恢复本事务完整快照，未知变化不自动停机或写回。
- **移除当前账号安全接续。** 先安全切换至首个本地凭据可用的同宿主其他账号，核验成功再删除；失败保留原副本。没有替代账号时保持官方登录，抑制同身份立即重新添加，身份变化后解除。非当前或其他宿主副本移除不切号。
- **登录进度分阶段显示。** 官方 Login 返回有效授权结果后结束浏览器通知，后续核验、保存和恢复使用明确阶段；安全保存后及时刷新列表。Google 本人验证及既有身份、存储与恢复检查均保留。
- **额度刷新留在卡片内。** 点击刷新直接请求所选账号的服务端额度，不再额外确认或弹出成功提醒；加载状态、查询时间和失败重试均在账号卡片显示，查询与授权校验保持不变。
- **WSL 切号检查更准确。** 核对当前 Hub 的可执行文件、宿主、端口与进程启动身份。检测到外部或遗留 Hub 时，明确说明任务状态未知并阻止继续操作，不自动终止它，也不将其直接认定为另一窗口。
- **等待受控停机实际完成。** 官方停机钩子返回后，最多等待十秒确认后台退出和导出状态清空，再继续操作。受控重启后重新绑定进程身份，保护连续切号与恢复操作；保留 macOS / Windows 原有排他检查。
- **保持凭据与任务保护。** 未知进程、身份变化、PID 复用及退出超时均不会成为跳过检查或写入切号凭据的理由。没有按进程名称批量结束任务的行为。

此版没有修改官方组件在启动期间的取消或清理机制，不宣称根治扩展宿主退出后遗留 Hub。官方导出接口没有已核实的任务活跃性查询，因此无法自动判断旧后台是否可以安全终止。十秒等待从官方停机钩子返回后开始，不保证钩子自身挂起时也能在十秒内完成。

升级保留扩展 ID、账号与图片数据；无需删除登录文件或会话历史。从附件下载 `.vsix`，在目标窗口执行 **Extensions: Install from VSIX…**。Workbench 与 Google Antigravity 应运行在同一宿主，WSL 用户需检查安装目标。

发布门禁包含 Linux、Windows、macOS 完整回归、隔离实际 VS Code 宿主、打包及许可检查。真实 Google 账号的完整切号与真实生图未作为本次验收；手动结束已定位旧后台不等于补丁实机验收。具体提交与资产哈希见 `release-manifest.json` 和 `SHA256SUMS`，范围见 [验证说明](VALIDATION_0.1.1.md)。

GitHub Release 与 Marketplace 是独立渠道；Marketplace 更新使用同源单独打包的 VSIX。项目自有许可与第三方声明保持不变，本次发布不授予 Google 服务访问权。

## English

- **Synchronize direct official logins.** Verify and display the official current identity and automatically save its encrypted same-host copy. Check on window focus and detect changes through the local Hub every five seconds while idle, retaining IDs and labels. Saving failures keep the verified identity visible. Old add transactions may restore only their confirmed full snapshot; unknown changes prevent automatic stop or credential writes.
- **Continue safely after current-account removal.** Switch to the first different same-host account with usable local credentials, verify it, then delete the old copy. Failure retains that copy. With no replacement, keep the official login and suppress immediate re-adding until an identity change. Noncurrent or foreign-host removal does not switch.
- **Show distinct login stages.** Close browser progress after the official Login returns a valid auth result; show verification, saving and restoration explicitly, refreshing the list after secure saving. Google identity verification and existing identity, storage and recovery checks remain in place.
- **Quota refresh stays on the card.** Clicking Refresh requests the selected account's server quota without an extra confirmation or success notification. Loading, query time and retryable failures remain on the account card; query behavior and authorization validation are unchanged.
- **More precise WSL switch checks.** Verify the current Hub's executable, host, port and process start identity. An external or leftover Hub blocks further work with an explicit unknown-task-state explanation. It is not automatically terminated or assumed to represent another window.
- **Observe controlled shutdown completion.** After the official stop hook returns, wait up to ten seconds for backend exit and cleared exports before continuing. Controlled restarts rebind process identity to protect consecutive switches and recovery. Existing macOS / Windows exclusivity checks remain in place.
- **Preserve credential and task protections.** Unknown processes, identity changes, PID reuse and shutdown timeout do not permit skipping checks or writing switch credentials. No task is terminated by process name.

This version does not change the official component's startup cancellation or cleanup, and does not claim to prevent leftover Hubs after extension-host exit. There is no verified task-activity query in the official exported interface, so an old backend cannot automatically be declared safe to terminate. The ten-second observation deadline starts after the official stop hook returns; it does not bound a hung hook itself.

Upgrades retain the extension ID, accounts and images. Do not delete login files or session history. Download the `.vsix` attachment and run **Extensions: Install from VSIX…** in the target window. Workbench and Google Antigravity must run on the same host; check the installation target for WSL.

Release gates include full regressions, an isolated actual VS Code host, packaging and license checks on Linux, Windows and macOS. Complete real-account switching and real image generation were not acceptance tests for this version. Manually stopping an identified old backend is not live validation of the patch. See `release-manifest.json` and `SHA256SUMS` for the exact commit and asset hashes, and [validation scope](VALIDATION_0.1.1.md) (Chinese) for details.

GitHub Release and Marketplace are separate channels. The Marketplace update uses a separately packaged VSIX from the same source. Project-owned and third-party licenses remain unchanged; this release grants no Google service access.
