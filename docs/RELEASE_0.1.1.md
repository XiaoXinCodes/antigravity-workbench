# Antigravity Workbench 0.1.1

发布日期 / Release date: 2026-10-08 (UTC)

## 简体中文

- **WSL 切号检查更准确。** 核对当前 Hub 的可执行文件、宿主、端口与进程启动身份。检测到外部或遗留 Hub 时，明确说明任务状态未知并阻止继续操作，不自动终止它，也不将其直接认定为另一窗口。
- **等待受控停机实际完成。** 官方停机钩子返回后，最多等待十秒确认后台退出和导出状态清空，再继续操作。受控重启后重新绑定进程身份，保护连续切号与恢复操作；保留 macOS / Windows 原有排他检查。
- **保持凭据与任务保护。** 未知进程、身份变化、PID 复用及退出超时均不会成为跳过检查或写入切号凭据的理由。没有按进程名称批量结束任务的行为。

此版没有修改官方组件在启动期间的取消或清理机制，不宣称根治扩展宿主退出后遗留 Hub。官方导出接口没有已核实的任务活跃性查询，因此无法自动判断旧后台是否可以安全终止。十秒等待从官方停机钩子返回后开始，不保证钩子自身挂起时也能在十秒内完成。

升级保留扩展 ID、账号与图片数据；无需删除登录文件或会话历史。从附件下载 `.vsix`，在目标窗口执行 **Extensions: Install from VSIX…**。Workbench 与 Google Antigravity 应运行在同一宿主，WSL 用户需检查安装目标。

发布门禁包含 Linux、Windows、macOS 完整回归、隔离实际 VS Code 宿主、打包及许可检查。真实 Google 账号的完整切号与真实生图未作为本次验收；手动结束已定位旧后台不等于补丁实机验收。具体提交与资产哈希见 `release-manifest.json` 和 `SHA256SUMS`，范围见 [验证说明](VALIDATION_0.1.1.md)。

GitHub Release 与 Marketplace 是独立渠道；Marketplace 更新使用同源单独打包的 VSIX。项目自有许可与第三方声明保持不变，本次发布不授予 Google 服务访问权。

## English

- **More precise WSL switch checks.** Verify the current Hub's executable, host, port and process start identity. An external or leftover Hub blocks further work with an explicit unknown-task-state explanation. It is not automatically terminated or assumed to represent another window.
- **Observe controlled shutdown completion.** After the official stop hook returns, wait up to ten seconds for backend exit and cleared exports before continuing. Controlled restarts rebind process identity to protect consecutive switches and recovery. Existing macOS / Windows exclusivity checks remain in place.
- **Preserve credential and task protections.** Unknown processes, identity changes, PID reuse and shutdown timeout do not permit skipping checks or writing switch credentials. No task is terminated by process name.

This version does not change the official component's startup cancellation or cleanup, and does not claim to prevent leftover Hubs after extension-host exit. There is no verified task-activity query in the official exported interface, so an old backend cannot automatically be declared safe to terminate. The ten-second observation deadline starts after the official stop hook returns; it does not bound a hung hook itself.

Upgrades retain the extension ID, accounts and images. Do not delete login files or session history. Download the `.vsix` attachment and run **Extensions: Install from VSIX…** in the target window. Workbench and Google Antigravity must run on the same host; check the installation target for WSL.

Release gates include full regressions, an isolated actual VS Code host, packaging and license checks on Linux, Windows and macOS. Complete real-account switching and real image generation were not acceptance tests for this version. Manually stopping an identified old backend is not live validation of the patch. See `release-manifest.json` and `SHA256SUMS` for the exact commit and asset hashes, and [validation scope](VALIDATION_0.1.1.md) (Chinese) for details.

GitHub Release and Marketplace are separate channels. The Marketplace update uses a separately packaged VSIX from the same source. Project-owned and third-party licenses remain unchanged; this release grants no Google service access.
