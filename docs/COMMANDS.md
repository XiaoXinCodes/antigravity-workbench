# 设置与命令

命令面板中以 **Antigravity Workbench** 为分类；部分命令要求可信工作区或当前可用状态。命令以当前扩展清单为准。界面按钮可能使用更短的名称，例如账号卡片的“刷新”对应“查询所选账号配额”。

## 用户级设置

以下选项位于 VS Code 设置中的 **Antigravity Workbench**。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `antigravityAccounts.language` | `zh-CN` | 手动选择简体中文或 English；即时更新运行时视图，不重载，不影响草稿与任务。 |
| `antigravityAccounts.images.endpoint` | `daily` | 高级排障覆盖；可手动选择 `production`，其图片请求稳定性尚未验证。相关 project 与保存账号模型使用同一端点核验，不自动跨端点重试。修改本身不发请求。 |

只读取全局用户值，工作区配置不会覆盖。端点变化后须重新核验相关账号信息，旧端点结果不能直接用于新端点；实际请求主机可在操作记录与已开启的调试日志中查看。见 [高级排障](TROUBLESHOOTING.md#高级排障图片端点)。

## 命令面板

| 命令名称 | 命令 ID |
| --- | --- |
| 添加账号（OAuth 登录） | `antigravityAccounts.live.login` |
| 保存当前官方登录 | `antigravityAccounts.live.capture` |
| 切换已保存登录 | `antigravityAccounts.live.switch` |
| 核验切换后的 hub 身份 | `antigravityAccounts.live.verify` |
| 查询所选账号配额 | `antigravityAccounts.live.quota` |
| 取消当前配额查询 | `antigravityAccounts.live.quotaCancel` |
| 快速查看额度 | `antigravityAccounts.quota.quickPick` |
| 批量刷新账号额度 | `antigravityAccounts.quota.refreshAll` |
| 取消额度刷新 | `antigravityAccounts.quota.cancel` |
| 取消状态栏额度置顶 | `antigravityAccounts.quota.unpin` |
| 查看额度历史 | `antigravityAccounts.quota.history` |
| 管理定时请求与提醒 | `antigravityAccounts.automation.open` |
| 隐藏或显示账号身份 | `antigravityAccounts.privacy.toggle` |
| 恢复切换前的登录 | `antigravityAccounts.live.restore` |
| 删除已保存的登录副本 | `antigravityAccounts.live.remove` |
| 打开图片生成 | `antigravityAccounts.images.open` |
| 取消当前图片任务 | `antigravityAccounts.images.cancel` |
| 打开使用帮助 | `antigravityAccounts.openHelp` |
| 重新检查工作台环境 | `antigravityAccounts.recheck` |
| 查看 Google Antigravity 扩展 | `antigravityAccounts.openOfficialExtension` |
| 导出账号（.agwenc 加密） | `antigravityAccounts.live.export` |
| 导入账号（.agwenc 加密） | `antigravityAccounts.live.import` |

## 高级排障

命令面板的“高级排障…”（`antigravityAccounts.debug.tools`）集中提供图片目录诊断、调试日志开启与关闭、预览和导出日志、运行位置检查与技术路径复制。普通主界面不显示这些工具。图片目录诊断仅在显式运行后显示进度与结果，可关闭；关闭不会让迟到响应再次打开区域。

“打开插件设置”（`antigravityAccounts.openSettings`）打开标准 VS Code 设置。

[文档目录](README.md) · [快速开始](GETTING_STARTED.md)

界面语言默认简体中文，不跟随系统自动改变。静态命令名称和视图名称采用 `package.nls.json` / `package.nls.zh-cn.json`，遵循 VS Code 显示语言与重载机制，插件语言设置不能即时改写这些静态贡献。设置入口提供双语名称；英文快速开始见 [English guide](GETTING_STARTED.en.md)。
