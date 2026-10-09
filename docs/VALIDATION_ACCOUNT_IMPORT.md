# 账号导入改进验证 / Account import validation

以下记录首次实现的本地验证（2026-10-08）；当时的本地审查分支 `feat/verified-account-import`。基于实际远端 main `fd3944399815b97826a3a565a08fda599acf178c`（0.1.4）。当时未修改版本、模型或 Fast 配置，也未 push、合并、发布或操作实机。后续 0.1.5 发行验证见 [VALIDATION_0.1.5.md](VALIDATION_0.1.5.md)。

## 实现范围

- 导入候选直接执行服务器 identity → quota → identity；当前官方同邮箱也不使用 Hub 凭证代替候选。
- 同邮箱、同 host 支持覆盖或跳过；旧记录重复时必须选择具体目标。覆盖保留 ID 与列表位置，容量仅计算新增。
- 有效身份可保存无额度、403、429 或额度请求超时结果；401、身份不匹配及身份请求失败分别停止提交。
- 候选、交换开始标记和返回响应仅存入 SecretStorage。保留接收时间与最新轮换，取消等待安全收尾；相同迁移文件重试不重新提交过期 refresh token。后续保存账号的额度刷新也更新迁移绑定。
- 与原副本共用 grant 时先保全原副本的已确认轮换。混合新增/覆盖通过 schema 2 before/after 事务恢复，兼容 schema 1 journal；失败恢复列表时保留最新轮换。
- 未知轮换结果禁止旧 token 再交换或安装；明确选择的新授权候选可核验后覆盖。旧隔离标记仅在提交成功后清理，回滚保留标记。
- 不写 activeEmail，不写官方凭证槽，不切号、不重启。导出不修复导入或刷新记录；删除保存副本同时清理它拥有的候选凭证。
- 中英文 UI、开始使用和迁移说明同步。

## 检查证据

| 检查 | 结果 |
| --- | --- |
| `npm run check`（原生 Linux，标准 umask 022） | 类型检查、lint 通过；1,220 tests，1,216 pass，4 Windows-only skip，0 fail |
| `python test/release-safety.test.py` | 23 pass；发行模拟夹具，未修改实际 Release/tag/assets |
| `python test/package-docs.test.py` | 5 pass |
| `npm run test:host`（隔离 VS Code 1.141.0 + Xvfb） | 激活、命令、集成视图、指南、持久语言切换通过，exit 0 |
| `node scripts/render-workbench.cjs --all-screenshots` | 36 布局与点击流程通过 |
| `node scripts/render-i18n.cjs` + `python scripts/review-i18n.py` | 116 渲染用例、2 次进行中文案切换、24 截图通过 |
| 本地 VSIX、`verify-release.py` 与 `verify-marketplace-vsix.cjs` | 运行模块、文档、许可和离线 Marketplace 校验通过；仅审查包，版本字段仍为 0.1.4 |

运行环境为 Linux x64、Node 24.19.0。初始沙箱将 `/` 与 `/tmp` 属主映射成 uid 65534，使既有私有存储测试按设计拒绝；原生执行显示实际 uid 0。标准 umask 022 用于权限拒绝夹具。未修改或放宽产品存储安全校验。

针对性测试包括新增/覆盖/跳过、50 账号容量、指定重复目标、当前同邮箱的候选核验、缓存失效、重复点击、并发索引与凭据变化、取消与迟到响应、每个 SecretStorage get/store/delete 和索引步骤的操作前后失败、混合批次每个写入阶段崩溃、旧 journal、轮换后失败和重启恢复、后续轮换、删除候选以及未修改官方槽。

## 验证边界 / Boundaries

全部账号与 token 均为合成数据。服务器 identity/quota/OAuth 响应和 SecretStorage 故障通过注入夹具验证；未读取真实登录、未向 Google 进行真实账号验证。真实 Linux 文件权限、进程与隔离 VS Code 宿主已运行；未运行 Windows/macOS 原生或实际 WSL 宿主验收，也未验证真实 OS keychain 的故障行为。

SecretStorage 不提供 fsync 或跨 Google 响应的原子提交。断电发生在收到轮换响应且尚未成功持久化之间时，只能保留交换未知标记并禁止重用旧 refresh token，不能保证恢复一段从未落盘的响应。不同应用或窗口不遵守宿主操作锁时也无法建立跨进程 CAS。错误会保留固定分类与恢复信息，不声称完成真实账号验收。

All credentials are synthetic. Server and SecretStorage fault behavior is mocked; native Linux filesystem/process checks and an isolated VS Code host are real. At this initial implementation stage, no Google login, real credential access, native Windows/macOS/WSL account acceptance, push, merge or publication was performed. See VALIDATION_0.1.5.md for subsequent release validation. SecretStorage has no fsync guarantee; an unpersisted server rotation cannot be reconstructed after power loss, so uncertain outcomes block reuse of the prior refresh token.
