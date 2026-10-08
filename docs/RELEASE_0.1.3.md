# Antigravity Workbench 0.1.3

发布日期 / Release date: 2026-10-08 (UTC)

## 简体中文

改善窗口重开后的登录核验，使面板自动恢复核验，并准确区分身份确认与本机副本保存。

- 窗口启动和面板重建时自动核验官方登录，并合并正在进行的检查。后台确认前，可显示同宿主已保存账号的“上次确认的登录：邮箱（待后台确认）”；它不会获得当前登录标记，也不代表本机副本已保存。
- 为慢启动提供更长的有界身份核验等待；重复缓存身份或同一错误不再无限续期失败重试。仍需服务端新鲜身份确认，失败时保留明确状态和重新检查入口。
- 身份确认后及时结束“正在核验”。本机副本保存另行限时等待，较慢时显示尚未完成；底层操作保留安全锁，迟到结果不能完成已取消或身份已变化的旧保存。
- “重新检查身份”取代旧等待，并发检查合并；窗口关闭及迟到响应不会覆盖新身份。已有账号列表保留。

升级保留扩展 ID、已有账号和图片数据。下载本 Release 的 `.vsix` 并执行 **Extensions: Install from VSIX…**，或在 VS Code Marketplace 的手动更新发布后升级。Workbench 与 Google Antigravity 应运行在同一宿主；WSL 用户需检查安装目标。GitHub 发布与 Marketplace 手动更新为独立渠道。

本 Release 的同一个正式 VSIX 可直接用于 Marketplace 的 **Update**：发布者为 `xiaoxincodes`，扩展 ID 为 `xiaoxincodes.antigravity-account-manager`。随包 README 与文档、图片链接固定到本版源码提交的 HTTPS 地址，运行模块与源码一致。打包门禁执行 vsce 的离线市场检查；实际市场上传、认证及后端接收由发布者手动完成。

测试使用虚构身份、假时间和本地 mock，覆盖慢启动、身份请求或保存挂起、视图重建、并发重新检查及迟到响应。发布门禁在 Linux、Windows、macOS 执行回归、隔离实际 VS Code 宿主、打包和许可检查。未使用用户真实窗口、真实账号、真实登录或图片调用验收，亦不宣称已定位所有实机启动等待原因。详见 [验证范围](VALIDATION_0.1.3.md)；提交及资产哈希见 `release-manifest.json` 和 `SHA256SUMS`。

## English

Improve login verification when a window reopens. The panel resumes verification automatically and distinguishes confirmed identity from local-copy saving.

- Automatically verify the official login at startup and when the panel is rebuilt, joining an existing check. Before background confirmation, a saved account on the same host may appear as “Last confirmed login: email (pending background confirmation).” It receives no current-login badge and does not establish that a local copy was saved.
- Allow a longer bounded identity wait for slow initialization. Repeated cached identities or the same error no longer continually renew failed retries. Fresh server identity proof remains required; failures retain a clear state and a recheck action.
- Finish the identity-checking indicator promptly after confirmation. Local saving has a separate bounded wait and remains visibly unconfirmed when slow. The underlying operation keeps its secure lock; late results cannot complete an old save after cancellation or an identity change.
- Rechecking supersedes the old wait and coalesces concurrent checks. Window closure and late responses cannot replace a newer identity. The existing account list remains available.

Upgrades retain the extension ID, accounts and images. Download this release's `.vsix` and run **Extensions: Install from VSIX…**, or update through VS Code Marketplace after its manual update is published. Workbench and Google Antigravity must run on the same host; check the installation target for WSL. GitHub publication and a manual Marketplace update are independent channels.

The same formal release VSIX can be used directly for Marketplace **Update**, with publisher `xiaoxincodes` and extension ID `xiaoxincodes.antigravity-account-manager`. Packaged README, documentation and image links use HTTPS URLs pinned to this release's source commit; runtime modules match the source. Packaging gates execute vsce's offline Marketplace checks. The publisher completes actual authentication, upload and backend acceptance manually.

Tests use fictional identities, fake time and local mocks, covering slow startup, hanging identity requests or saves, rebuilt views, concurrent rechecks and late responses. Release gates run regressions, an isolated actual VS Code host, packaging and license checks on Linux, Windows and macOS. The user's actual window, real accounts, real login and image calls were not acceptance tests; this release does not claim to identify every cause of waiting on a real installation. See [validation scope](VALIDATION_0.1.3.md), `release-manifest.json` and `SHA256SUMS` for boundaries, commit and asset hashes.
