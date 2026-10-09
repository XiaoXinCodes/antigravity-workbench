# 导出文件覆盖修复验证 / Export replacement validation

2026-10-09 初次本地审查记录；分支 `fix/account-export-replace`，基于核对后的远端 main `1218745eaf45178c6747c30e21ff7b70f1a91463`。此阶段版本为 0.1.5，仅本地实现与验证，未推送、合并、发布或操作用户机器。后续 0.1.6 的发行检查与平台 CI 门禁见 [0.1.6 验证范围](VALIDATION_0.1.6.md)。

## 根因与交互

原 `live-ui` 使用保存对话框获得路径，然后调用 `writeMigrationArchive`。writer 的存在检查与 `O_EXCL` 创建始终拒绝已有文件，未接收替换授权，所以系统保存对话框确认覆盖后仍报 `MIGRATION_FILE_EXISTS`。

核对本地 VS Code 类型声明与 [官方 API](https://code.visualstudio.com/api/references/vscode-api#window.showSaveDialog)：`showSaveDialog` 只返回 URI 或 undefined，`SaveDialogOptions` 没有覆盖确认标记或禁用覆盖弹窗的选项。改用目录选择与文件名输入；导出范围与已有文件替换合并为一次明确确认，显示目标全路径。此处覆盖仅替换导出文件，与导入同账号覆盖无关。

## 文件保全

- 确认前只读捕获目标内容摘要、纳秒时间与完整 bigint 文件/目录身份；生成绑定路径的单次快照。取消不创建文件或事务标记。
- 新目标保留 `O_EXCL`。已有目标在同目录排他创建密文临时文件，写入、sync、同句柄读回与完整字节校验后关闭；重新核对目标、临时文件、目录和排他事务标记后，由同目录 rename 提交。
- 不先删除或截断旧文件，不在 rename 失败时退回普通写入。成功 rename 是提交点，之后只做不影响成功状态的所属临时文件清理。
- 所有导出 writer 的文件身份与失败清理使用 bigint，避免相邻 Windows 大整数 inode 被 Number 合并。被其他进程替换的临时文件与标记不作为自身文件删除。
- 并发写入使用排他事务标记；旧确认在其他写入完成后失效。权限与空间拒绝、目标变化、确认失效、事务冲突分别提示。
- 不读取挂载策略、不 chmod、不要求实际 POSIX 模式。仅请求 0600 创建默认值；系统拒绝访问仍停止。密码、明文与官方凭证槽处理沿用既有边界，导出不更改账号状态。

## 检查证据

| 检查 | 结果 |
| --- | --- |
| 最终 `npm run check`，原生 Linux / Node 24.19.0 / umask 022 | typecheck、lint；1,254 tests，1,250 pass，4 Windows-only skip，0 fail |
| 导出、迁移、迁移 UI 与 i18n 针对性检查 | 110 pass，0 fail |
| 发行拒绝路径 / 打包文档 | 23 / 5 pass；模拟夹具，无实际发布操作 |
| 隔离实际 VS Code 1.141.0 + Xvfb smoke | 激活、命令、集成视图、指南与持久语言切换通过 |
| 生产 workbench 与双语渲染 | 36 布局/点击；116 渲染、2 次进行中文案切换、24 截图检查通过 |
| 本地审查 VSIX | 0.1.5、`xiaoxincodes.antigravity-account-manager`，运行模块、文档、许可与离线 Marketplace 结构校验；未上传 Marketplace |

回归覆盖重复同名导出、失败后同名重试、取消目录/文件名/确认/两次密码输入、重复点击与迟到加密结果、写入/部分写入/损坏/sync/读回/关闭/rename 故障、目标内容与 inode/目录/符号链接变化、检查到打开间移除、标记与临时文件替换、两个独立合成进程争用，以及相邻大整数 inode 的确认与失败清理。

## 验证边界

全部账号、密码、token、文件和故障均为合成夹具。原生 Linux 文件 I/O、并发子进程与隔离 VS Code 宿主实际运行；文件选择和确认的 UI 流程通过注入 VS Code API 验证，宿主 smoke 不等同于手动点击原生保存控件。

Win32 盘符/路径使用 `path.win32` 加真实合成文件的路径映射模型；WSL 挂载路径通过 Linux workspace-host URI 与目录权限模型验证。初次本地审查未执行 Windows/macOS 原生 CI 或用户实际 WSL / DrvFS 验收，既有 0.1.5 CI 不作为此补丁证据。未读取真实登录或加密迁移文件，也未操作实际 Google、账号切换或图片服务。

可移植 Node 文件 API 不提供针对确认快照的原子 CAS，也不能冻结其他应用在最后检查与 rename 之间的路径操作；排他标记保护遵守协议的导出者，快照检查拒绝已观察到的外部变化，不声称能隔离拥有目录写权限的恶意进程。中断可能留下密文临时文件或未完成标记；不确定归属或状态时不会强行接管，可先选择新文件名。未承诺断电后的目录持久化或读取从未落盘的内容。

All data and injected failures are synthetic. Native Linux file operations, independent child processes and an isolated VS Code host were exercised. At this initial local-review stage, Windows paths and WSL mount behavior were modeled; no native Windows/macOS CI, real WSL/DrvFS acceptance, Google credentials, user-machine operation or publication was performed. See the 0.1.6 validation record for subsequent release checks. The final path check and rename are not an OS-level compare-and-swap against noncooperating directory writers.
