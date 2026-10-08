# Antigravity Workbench 0.1.0

发布日期 / Release date: 2026-10-08 (UTC)

## 简体中文

- **中英文界面。** 插件默认简体中文；在 `antigravityAccounts.language` 中手动选择 `en`。已打开的工作台、图片面板、状态、诊断和快速入门立即更新，保留草稿、所选账号、参考图、布局与任务。命令面板、视图标题和设置说明遵循 VS Code 显示语言。
- **保存当前账号。** “添加账号”与“保存当前账号”同组显示。唯一匹配的已核验身份有可用本机副本时显示不可点击的“已保存”；凭据缺失或不可用时更新原记录，保留账号 ID，不重复添加。保存状态仅表示本机检查通过，不保证服务端授权有效。
- **启动与恢复。** 图片账号检查遇到组件启动中的暂时错误会有限重试，保留所选账号；账号切换与恢复使用事务及核验修订保护，迟到结果不能清理较新的操作。
- **图片额度。** 在图片工作室按所选账号与模型查询服务端剩余比例、重置时间及更新时间。接近满额的值不会四舍五入成 100%，旧结果明确标记，不换算成可生成张数。
- **继续创作与用进项目。** 从已保存结果继续修改、比较版本、恢复草稿、复制相对路径或 Markdown，以及明确插入当前文本目标。保留原图，不自动保存编辑器、不自动重发任务；支持单张移除或清空参考图。
- **模型目录。** 使用同账号可信图片目录的成员校验，兼容不含 `image` 的合法模型 ID。可按需比较脱敏目录；模型名称不保证权限或实际可调用性。
- **完整双语说明。** [中文 README](../README.md) 与 [English README](../README_EN.md) 提供对应语言的功能步骤及真实界面截图。截图中的账号、额度与图片均为演示数据。

从本 Release 的附件下载 `.vsix`，在目标 VS Code 窗口执行 **Extensions: Install from VSIX…**。Workbench 与 Google Antigravity 应位于同一宿主；WSL 用户需检查安装目标。升级保留已有账号与图片。创作记录兼容已有 schema 1 / 2 并写入 schema 3；直接降级可能使旧版无法读取新记录，请先保留数据备份。

发布提交、资产清单与哈希见随包的 `release-manifest.json` 和 `SHA256SUMS`。自动化覆盖 Linux、Windows、macOS 的完整回归、隔离实际 VS Code 宿主、打包及许可检查；另外验证中英深浅主题、窄窗口和确认期间切换语言。真实 Google 账号接入及本次版本的真实图片请求尚未作为发布验收执行。可用模型、服务端权限、图片效果与额度以实际账号返回结果为准。

项目自有部分采用 [Sustainable Use License 1.0](../LICENSE)，属于 source-available，非 OSI 开源许可。第三方许可保持不变；本 Release 不授予 Google 服务访问权，也不向 Marketplace 发布。

## English

- **Manual Chinese / English UI.** Simplified Chinese is the default. Select `en` in `antigravityAccounts.language`; open workbench and image panels, status, diagnostics and the quick start update immediately while preserving drafts, account selection, references, layout and tasks. Static Command Palette entries, view titles and settings descriptions follow VS Code's display language.
- **Save the current account.** Add account and Save current account share a toolbar. A uniquely matched verified identity with a usable local copy displays a disabled Saved button. Missing or unusable credentials update the same record and retain its ID without adding a duplicate. Saved describes local checks, not a guarantee of server authorization.
- **Startup and recovery.** Image account checks retry transient component-startup failures within a bounded window and retain the selected account. Transaction and verification revisions prevent late identity results from clearing newer switch/recovery operations.
- **Image quota.** Query the selected account and model for server-reported remaining fractions, reset times and update times. Sub-full fractions never round to 100%; stale readings are marked and are not converted into image counts.
- **Continue creating and use results in a project.** Continue editing saved results, compare versions, restore drafts, copy relative paths or Markdown, and explicitly insert into the displayed text target. Original images are retained; editors are not automatically saved and tasks are not automatically resubmitted. Remove references individually or clear them all.
- **Model catalogs.** Validate membership in the same account's trusted image catalog, including legitimate model IDs without `image`. Sanitized catalog comparisons are available on demand. A model name does not guarantee access or a successful call.
- **Complete bilingual documentation.** [Chinese README](../README.md) and [English README](../README_EN.md) include matching feature walkthroughs and actual rendered screenshots with fictional accounts, mock quota and local demonstration images.

Download the `.vsix` attachment and run **Extensions: Install from VSIX…** in the target VS Code window. Workbench and Google Antigravity must run on the same host; check the target when using WSL. Upgrades retain accounts and images. Creative records read existing schema 1 / 2 and write schema 3. Older versions may not read newer records, so retain a data backup before downgrading.

The exact release commit, asset list and hashes are recorded in `release-manifest.json` and `SHA256SUMS`. Automation covers full regressions, an isolated actual VS Code host, packaging and license checks on Linux, Windows and macOS. Additional checks cover both languages/themes, narrow layouts and language changes during confirmation. Real Google account integration and real image requests for this version have not been executed as release acceptance. Available models, service permissions, image behavior and quota depend on actual account responses.

Project-owned material uses the [Sustainable Use License 1.0](../LICENSE), a source-available license rather than an OSI open-source license. Third-party licenses remain unchanged. This release grants no Google service access and is not published to Marketplace.
