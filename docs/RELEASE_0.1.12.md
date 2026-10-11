# Antigravity Workbench 0.1.12

## 简体中文

模型选择跟随账号的服务端目录，新增型号无需更新插件。

- 保留原始模型 ID 和服务端名称，明确区分图片模型、普通请求和未知用途。
- 切换账号或端点时隔离目录；查询失败保留原选择、上次展示及查询时间。
- 升级保留账号、收藏、图片草稿与历史、定时任务和成功额度读数。
- 图片页保留独立账号选择及其额度显示，移除跨账号额度推荐，完善中英文诊断提示。

旧定时任务的用途若没有服务端证据，请编辑任务并明确确认用于普通文本请求。图片选项须由服务端明确图片清单支持；目录缺项不代表没有权限。真实服务端请求兼容性和用户窗口中的界面验收仍待确认。详见[模型目录说明](MODEL_CATALOG_REFACTOR.md)与[验证范围](VALIDATION_0.1.12.md)。

## English

Model selection follows the account's server catalog, so newly listed models appear without a plugin update.

- Preserve original model IDs and server names, with explicit handling of image models, text requests and unknown use.
- Isolate catalogs by account and endpoint; retain selections, previous display data and query times on refresh failure.
- Preserve accounts, favorites, image drafts and history, scheduled tasks and successful quota readings on upgrade.
- Keep independent image account selection and its quota display, remove cross-account quota recommendations and improve diagnostics in both languages.

For existing scheduled tasks without server evidence of their use, edit the task and explicitly confirm ordinary text use. Image options require the server's explicit image list; a missing catalog entry does not establish lack of permission. Real server request compatibility and UI acceptance in the user's window remain unconfirmed. See the [catalog guide](MODEL_CATALOG_REFACTOR.md) and [validation scope](VALIDATION_0.1.12.md).
