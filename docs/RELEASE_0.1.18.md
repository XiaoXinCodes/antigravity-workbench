# Antigravity Workbench 0.1.18

改善多窗口切号、失败恢复与就地进度。

- 改善多窗口切号与失败恢复，保留备份及未知新凭据保护。
- 修复 WSL 共用启动日志造成的证明丢失；在已确认范围内独立重新取证，不借用其他窗口证明。
- 分开显示账号提交与后台恢复结果，避免旧提示误导；在账号卡片旁显示实际进度。
- 移除实验入口，性能诊断仅在主动开启调试时记录。不更改官方插件或 VS Code 登录配置。

Improve multi-window switching, recovery and inline progress.

- Improve multi-window switching and recovery while preserving backups and unknown external credential changes.
- Recover missing WSL startup evidence within the confirmed scope, without borrowing another window’s proof.
- Separate account commit from backend recovery and show actual progress beside the account card.
- Remove experimental entry points; record performance diagnostics only with debug enabled. Do not modify the official extension or VS Code sign-in settings.

