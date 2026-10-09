# 0.1.8 验证范围 / Validation scope

本版修复 0.1.7 中 WSL Relay 祖先使后台归属未知、切号恢复入口不可用的问题，并适配官方 1.7 默认启动形态。源码与检查见 [PR #5](https://github.com/XiaoXinCodes/antigravity-workbench/pull/5)；用户可见摘要见 [发布说明](RELEASE_0.1.8.md)。

## 已验证的行为

- 窗口归属与登录凭据范围分开核验。归属未知或来自其他窗口时保持真实标签；只有进程身份、官方启动形态和同一登录范围可核实时，才允许用户明确确认处理。
- 一次确认固定原始目标集合。取消不结束后台、不写入凭据；新进程、PID 换代、启动参数或相关环境变化不能继承旧确认。当前 Hub 仍由官方停止钩子处理。
- 官方 1.7 默认参数、重复的多根工作区目录参数和三个启动标记使用生产 helper 的合成夹具验证。未知自定义参数、认证或服务覆盖、缺少凭据范围证明仍被拒绝；不向界面输出原始参数、环境值或 CSRF 能力。
- 真实隔离 Linux VS Code 1.141 的 Webview 和原生确认框完成冲突展示、取消保留原账号、确认后切换并核验合成身份的点击流程。账号、官方 API、凭据与该界面中的后台均为合成数据，没有实际 Google 调用。
- Windows 原生 CI 编译生产 PowerShell / C# adapter，读取自建无网络子进程的实际 PEB 与 argv，覆盖官方启动标记、多根目录、六类不合格范围或参数以及强制结束自己的合成子进程。拒绝用例不提供结束授权，要求固定拒绝码和目标仍存活。

## 工程与发行检查

候选 `a26ae33b717aebe11c5ef6898be1da124a1fa60a` 的 [三平台 CI](https://github.com/XiaoXinCodes/antigravity-workbench/actions/runs/37910397446) 已完整通过。0.1.8 版本提交与合并后的 main 提交分别运行同一矩阵，最终结果以 [PR 检查](https://github.com/XiaoXinCodes/antigravity-workbench/pull/5/checks) 和 [发行工作流](https://github.com/XiaoXinCodes/antigravity-workbench/actions/workflows/ci.yml) 为准；版本更新不能复用旧提交的绿灯。

三平台检查包含类型、lint、完整回归、发行拒绝路径、文档、隔离 VS Code 宿主、打包和 VSIX 校验。仅 main push 且全平台通过后创建新正式 Release，回读 VSIX、源码包、`release-manifest.json`、`SHA256SUMS` 并比对字节后才公开；保留既有标签和资产，不上传 Marketplace。

Windows 首轮编译探测曾在 45 秒预算内超时。随后未修改实现的探测也通过，故准确原因尚未证实；最终候选仅补回 helper 的 APPDATA / LOCALAPPDATA，未继承认证、服务或自定义搜索路径，也未扩大超时或放宽目标保护。候选 runner 的原生探测约 30 秒，组合子进程测试约 8.4 分钟；这些耗时不是用户机器体验的保证。

受管沙箱旧完整检查出现私有存储权限失败，正式 0.1.7 相同模块在相同沙箱出现同组失败。未放宽权限、删除断言或增加跳过，最终工程验证使用获授权的 GitHub 原生 CI。

## 实机状态与未验范围

安装协调线程已报告：上述候选安装至用户 WSL，73 个运行模块匹配 CI。审计线程没有重载用户宿主或执行真实切号，尚未收到用户明确的切号成功反馈，因此不能称真实账号验收通过。

未重试被拒的实机进程参数或环境读取，未结束用户后台。实际目标的凭据范围、官方 Hub 生命周期、Google OAuth / 配额 / 生图、Windows/macOS 人工界面操作、实际 WSL / DrvFS 密钥库及 SSH / 容器宿主仍未完成本轮验收。

Actual isolated GUI and Windows native synthetic-process checks passed separately from simulated accounts and APIs. The candidate was reported installed in the user's WSL with matching runtime hashes, but no confirmed real-account switch result has been received. Installation and CI do not establish real Google, official Hub, native keyring or user-machine responsiveness acceptance.
