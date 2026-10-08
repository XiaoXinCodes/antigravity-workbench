# Changelog

## 0.0.8 — 2026-10-07

- 默认简体中文，用户设置手动选择 English；打开的界面与帮助即时切换，保留输入、参考图、账号、布局与任务。
- 添加账号与保存当前账号同组；本机副本可用时显示“已保存”，缺失或不可用时更新同一记录，防止重复添加。
- 组件启动时有限重试图片账号检查；切换与恢复的事务修订防止迟到核验清理较新操作。
- 图片额度按所选账号/模型查询，标记旧值，未满比例不显示为满额，不换算生成张数。
- 支持合法的不含 image 的图片目录成员 ID，提供按需脱敏目录对比，不保证模型权限。
- 已保存结果继续修改、版本对比、草稿恢复、项目路径/Markdown、明确编辑器插入与不覆盖的图片复制；原图和任务历史保留。
- 创作记录兼容 schema 1 / 2，写入 schema 3；改善 Windows 盘符与路径边界处理。
- 完整中英 README、快速入门与实际渲染功能截图。

English: manual Chinese/English UI with preserved live state; grouped idempotent current-account saving; bounded startup checks and revision-safe recovery; account/model image quota without false full readings; trusted catalog membership; continued editing, version comparison and project actions; compatible creative-record migration; complete bilingual documentation and rendered screenshots. See [release notes](docs/RELEASE_0.0.8.md) for installation and validation boundaries.
