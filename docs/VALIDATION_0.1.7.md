# 0.1.7 验证范围 / Validation scope

本版整合独立用户流程审计确认的交互修复与后台范围确认流程。变更及复现说明见 [PR #4](https://github.com/XiaoXinCodes/antigravity-workbench/pull/4)；用户可见摘要见 [发布说明](RELEASE_0.1.7.md)。

## 用户流程与回归

- 真实隔离 Linux VS Code 1.141 界面及原生确认框验证取消、A → B → A、两个合成遗留后台的一次范围确认、窄窗口入口与日志预览。图片面板在 500ms 桥延迟和 200ms 连续输入下，最终显示及生产核心实际提交均为 ABC。截图仅含虚构数据。
- 账户、凭据槽位、官方 API、Hub 生命周期与上述界面中的后台身份使用合成夹具；不是实际 Google 账号或真实官方组件验收。Linux `/proc` / pidfd 与 Windows PowerShell / HANDLE 另使用实际合成子进程验证归属与保护。
- 回归覆盖本地 `vscode-userdata` URI、旧草稿响应、额度刷新取消身份重核验、签出状态的跨宿主副本删除、图片缺参数与停止终态、迁移锁分类及释放、语言切换和隐藏异常区域重扫后的按钮。
- 已加载官方停止钩子的异步等待限定为 30 秒。实际调用未结束时禁止再次调用或重启；迟到完成不会自动写凭据或继续操作。同步阻塞 JavaScript 事件循环仍需要重载宿主恢复。
- Windows CI 暴露同进程并发快照保存的 `.write.lock` / `EPERM` 竞争。按目录串行至锁清理结束，同时保留跨进程 `wx` 独占、权限错误拒绝和两秒等待期限；排队超时任务不会迟到写入。保留原有 16 并发保存的数据完整性断言。原生 CI 证实故障，具体内核原因未追踪；注入竞争复现不等同于内核原因验证。

## 原生 CI 与发行门禁

修复源码在 [三平台运行 37893775876](https://github.com/XiaoXinCodes/antigravity-workbench/actions/runs/37893775876) 完整通过：Linux 1,320、Windows 1,249、macOS 1,308 项通过，零失败；分别有 4、72、13 项按既有平台适用条件跳过。三平台均通过类型、lint、完整回归、发行拒绝路径、文档、隔离实际 VS Code 宿主与 VSIX 校验；Linux 另有生产 HTML 布局和点击检查。

0.1.7 版本提交的 PR 精确 head 与合并后的 main 精确提交分别重跑上述矩阵，实际结果保留在 [PR 检查](https://github.com/XiaoXinCodes/antigravity-workbench/pull/4/checks) 与 [发行工作流](https://github.com/XiaoXinCodes/antigravity-workbench/actions/workflows/ci.yml)。仅 main push 且全平台通过后发布；禁止覆盖已有标签、Release 或附件。

工作流上传 VSIX、源码包、`release-manifest.json` 和 `SHA256SUMS`，下载回读核对四份附件后才公开 Release。清单核对版本、扩展 ID、源码、运行模块、许可及文档提交；不上传 Marketplace。

普通本地沙箱的完整检查曾因根目录 UID 与测试进程 UID 不同，在 18 项私有日志存储检查中失败。相关产品模块及测试与 0.1.6 相同，但未完成干净正式版在同一沙箱的完整 A/B 对照。额外权限复跑被自动审批拒绝后没有重试或绕过；没有放宽产品权限检查、删除断言或新增跳过。最终产品验证使用用户授权的上述 GitHub 原生 CI。

## 未验范围

未使用真实凭证、用户机器、Google OAuth、真实配额或生图服务。真实官方 Hub 停止钩子及跨窗口生命周期、Windows/macOS 用户界面人工操作、实际 WSL / DrvFS 凭据和 Keyring、SSH / 容器宿主仍未完成验收。空账号宿主 smoke 与三平台 CI 不证明这些场景可用。

All accounts, credentials, official API responses and fault injections are synthetic. Actual isolated VS Code interfaces and native synthetic child processes provide separate GUI and process evidence. Native CI and empty-account host smoke do not establish real Google, official Hub, user-machine, WSL/DrvFS or keyring acceptance. Release assets preserve commit and byte-level verification evidence.
