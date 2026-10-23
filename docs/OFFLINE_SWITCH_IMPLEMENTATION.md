# 关闭后切换再重开：实现进度

2026-10-22。用户已允许关闭相关窗口，明确操作前保存并确认。当前按正常单用户操作约束实现：事务期间不新开、不重连相关客户端，不修改凭据/配置。扫描用于发现违约或自然残留，不声称能强制禁止全部未来启动。未操作用户环境、真实账号，未安装真实扩展或发布；WSL 文件范围已接通产品命令与外部终端执行器，尚未通过真实 WSL 平台闭环验收，不可视作可发布完成品。

## 当前用户流程（WSL 文件范围）

1. 普通账号“切换”按钮转入离线准备，不先结束 peer。用户确认保存、关窗及任务中断影响，输入两次恢复密码。UI 以官方精确源码合约、当前 live 文件路由、fresh 登录、稳定文件字节确认备份，再加密保存目标、备份、原身份及执行范围。
2. UI 原子建立 schema 4 恢复标记；旧版恢复逻辑拒绝未知格式，不能清除。显示外部终端命令，参数只有路径、事务/主机 ID 和操作类型，密码不在命令或环境里。这里尚未切号。
3. 用户在同一 WSL 发行版的独立外部终端运行命令，输入密码。执行器重新核验主机、解密材料、接管既有跨进程操作锁；等待用户关闭相关窗口，最长 5 分钟。拒绝新宿主、无 Hub 活宿主、孤立后台和未确认的发现结果。用户不得新开或重连窗口；此约束不是技术强制禁启。
4. 实际写入前再次扫描、重比旧值；文件同步及 rename 后目录同步，再记录 installed。终端显示可手动重开，而不是猜测已失效的 WSL IPC CLI 或声称自动重开成功。
5. 重开后执行“完成关闭后切号”，核验 fresh RPC、进程路由、账号及 refresh 凭据一致，允许正常 access-token 刷新。先持久记录 verified，再解除 schema 4；加密恢复材料仍保留。
6. 失败或取消保留记录。将外部命令末尾 install 改为 restore，可在再次关闭窗口后按当前槽位精确 CAS 恢复备份。只接受原/目标 refresh 凭据的值；第三方值不覆盖。恢复文件后仍保留 restored 与标记，重开并 fresh 核验原账号后才解除保护。

关闭的是用户确认的相关窗口；实现没有自动 kill 或 close 命令。需要独立外部终端和恢复密码，这是当前预览的明确交互成本。

## 已落地代码

- `src/offline-switch.ts`：不依赖 vscode 的事务核心；确认、串行、跨进程锁接口、旧值比较、准备/安装/恢复记录、每槽检查、部分写入保护、重开失败处理。已知身份矛盾在准备前拒绝；原生写入 Promise 拒绝不当作服务侧结束，禁止自动回滚。
- `src/offline-recovery-envelope.ts`：独立恢复格式，固定 scrypt N=32768/r=8/p=1、AES-256-GCM、随机 salt/nonce、完整性验证、主机与事务绑定，错误信息不回显解密内容。
- `src/offline-recovery-store.ts`：复用 PrivateState 的私有目录、跨进程 CAS、临时文件同步及原子替换；追加同步整条目录链，覆盖新建父目录入口。密码不落盘，可在另一进程解锁。Windows 目录持久/ACL尚未验收，因此此存储实现明确拒绝 Windows save，不能宣称 Windows 完成。
- `src/offline-process-census.ts`：Linux/WSL 只读发现普通扩展宿主启动标记、直接探测已知 PID/birth，以及 agy 残留；覆盖无 Hub 宿主。HOME 缺失/解析失败不是退出证据；file-only 按实际凭据目录/文件身份判断别名，共用 keyring 时包含同用户不同 HOME。
- `OfficialTokenSlots.write`：增加可选 `beforeMutation`，在原生 keyring 写入、文件 rename/unlink 前调用，并在异步检查后重比预期值。未提供回调的既有调用路径保持原行为；离线执行器必须提供回调。

- `src/offline-session.ts`：实际文件执行适配、持久准备接管、有界等待、每次写前 census、文件目录同步、保留恢复标记。
- `src/offline-cli.ts`：外部终端执行入口，重新绑定 WSL 主机；密码仅从 TTY 输入、不回显，Ctrl+C/D 恢复终端模式。
- `src/offline-ui.ts`：准备/继续/完成三个产品命令，普通 WSL switch 已转入；inline replacement 删除及历史继续意图在任务取消/结束 peer 前阻断，提示先离线切换。
- `LiveLocks` schema 4：与原操作 mutex 整合，旧 recovery 清理路径保守拒绝；真正 main 旧实现已测试拒绝且保留原字节。

## 已执行验证

- `test/host-control-feasibility.test.cjs`：5 项；4 项真实合成子进程实验，另 1 项启动旁路状态模型；Node22/24 通过。
- `test/offline-switch-prototype.test.cjs`：13 项合成回归，含匿名管道交接、密文篡改、启动冲突、部分写入和重开失败。
- `test/offline-switch.test.cjs`：13 项事务核心回归；最初缺实现失败，再实现转绿。
- `test/offline-recovery-envelope.test.cjs`：5 项封装回归；最初缺实现失败，再实现转绿。
- `test/offline-recovery-store.test.cjs`：跨进程密码解锁、旧版本 CAS、错误密码、无明文以及目录同步回归；正常 UID 映射下运行，未放宽原私有路径校验。
- `test/offline-process-census.test.cjs`：无 Hub、PID 复用、新代际、遗漏枚举直接探测、HOME别名、共享目录/文件等。
- `test/offline-native-slots.test.cjs`：3 项，含实际合成文件和模拟 keyring；第二槽前发现新实例不替换文件，guard 期间外部变化不覆盖。

独立审查已修复：目标身份矛盾、未知服务写入结束错误假设、guard 后 CAS、首建目录持久性、HOME解析失败误当退出、不同 HOME 共享凭据目录漏报。接线审查还修复了正常 access-token 刷新不能验收，以及 restore 未经 fresh 验证就提前解除保护。真实平台验收仍未完成。

## 隔离 VS Code 恢复入口实验

`scripts/research-offline-recovery-host.cjs` 在一次性 profile/HOME/extensions-dir 中运行两次 VS Code 1.141.0，仅使用自制测试扩展，无官方代码或真实账户。

CLI `--help` 明确：`--disable-extension` 不持久，仅对新开的窗口有效。最终实验在新窗口禁用 `google.google-antigravity` ID 的合成普通扫描扩展，而 Workbench 合成开发扩展仍可运行。日志 `/tmp/offline-recovery-host-v3.txt` 包含 `RESEARCH_PREPARE_OK`、`RESEARCH_SECRET_NOT_PERSISTED`、`RESEARCH_RECOVERY_OK`，两轮 exit0。

两项边界不可略去：

- 首次将被禁用对象也作为开发扩展的夹具无效：VS Code 明确永不禁用 development 扩展。已改为只在一次性 extensions-dir 放置自制普通扫描夹具，未执行安装命令或安装真实包。
- 云宿主无可用加密服务，SecretStorage 回退内存，首次读回成功但重开后不存在。这是采用独立密码恢复材料的直接理由；没有开启明文密码后端或更改安全配置。Windows/WSL 的真实 SecretStorage、禁用参数传播仍不能从此实验推定通过。

固定源码证据：[开发扩展例外](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/services/extensions/common/abstractExtensionService.ts)、[环境禁用判定](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/services/extensionManagement/browser/extensionEnablementService.ts)。

## 验证增量与未解决边界

- UI 接线回归 6 项；外部执行 session 5 项（真实合成文件、真实加密 journal/互斥，census 模拟）；终端输入回归 3 项。另有真实 detached 合成子进程闭环 2 项，不能把它说成真实 WSL 官方运行验收。
- main 旧锁源码 SHA256 `cc5240246943e6148527f59622a67bbe6cc1b070816c700b15cbec3e00be758f`；直接加载该 baseline 编译实现，`clearAbandonedRecovery` 与 `reconcileRecovery(null)` 均拒绝 schema4，原字节保留，2/2。
- 接线版第一轮全量 1897 通过、4 跳过；最终增量1902通过、4跳过，隔离宿主通过，见验证记录。

仍需真实 WSL 发行版中验证外部终端、VS Code Server 1.143、正常官方 1.8/1.9 的文件刷新、关闭/退出识别与手动重开。云 Linux 1.141 不能替代此平台验收。没有授权安装或操作用户账号，因此未在用户机器测试。

Windows 原生 keyring、Windows 宿主 census/ACL/持久材料尚未实现本离线流程；macOS同样不在本次接线范围。既有原生在线及其他登录/恢复入口不能据本轮 WSL switch 测试宣称已消除跨宿主生命周期风险。不能发布跨平台“核心切号全面修复”声明。

默认 WSL 文件路线要求准备时当前 Hub 能提供已核验的文件路由；若缺失当前 Hub，须先使用组件恢复入口。新实例违约时中止并保留备份；不同 refresh 凭据的外部更改不会自动覆盖。加密备份暂保留而不自动删除；遗忘恢复密码不能通过旧 SecretStorage 或删锁绕过。

## 试装前恢复出口补强（2026-10-22）

新增 `antigravityAccounts.live.offlineKeepCurrent`，在自有离线保护期间显示“保留当前登录并结束事务”。密码解密并绑定原 host/owner/id；整个核验、确认、持久记录和清标记过程持有同一 operation 锁。重复检查当前 Hub 的文件路由、PID/startTicks、端口代际、服务端登录及精确凭据字节；确认框展示本次核验账号并遵循隐藏身份设置。仅在用户确认和复验通过后记录 `kept-current` 与实际接受的身份，清除准确事务标记。不写任何当前凭据，不删除原始或目标加密备份，不宣称原切号成功。

refresh 凭据旋转或外部登录改变不再迫使覆盖还原：可明确接受当前已核验登录。取消、凭据变化、代际变化、服务端核验失败、旧格式/外来标记均保留保护；持久记录后核验失败允许重新核验重试。旧 CLI 不能重放已结束事务；`kept-current` 记录禁止 restore 覆盖当前状态。

自有 schema4 下允许单独恢复/重启当前组件，仍持同一 operation 锁排除独立 CLI 写入。正常 peer 不因此结束；普通在线 journal 或其他 owner 标记仍阻断。组件恢复不清离线保护，不自动切号。界面独立显示继续说明、完成核验、保留当前登录三个入口，并继续禁用凭据修改。事务状态变化立即撤销旧登录徽标后重新核验。

仍须保存恢复密码；密码丢失没有已验证的无损解锁路径。当前已退出登录时，须先通过官方登录建立可核验身份，再使用保留当前登录；不允许盲清保护。原生 Windows 在线写入不属于本候选的试装验证范围。
