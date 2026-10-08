# Antigravity Workbench 0.1.3

## 简体中文

改善窗口重开后的登录显示与核验体验。

- 重开窗口时，可显示上次确认的登录，并标明“待后台确认”。
- 优化慢启动时的核验等待，身份确认后及时结束“正在核验”。
- 本机副本保存较慢时，显示明确的“保存尚未完成”提示。
- 面板重新打开后自动接续核验；“重新检查身份”可重新发起检查，旧请求不会覆盖新的登录状态。

## English

Improve login display and verification when reopening a window.

- A reopened window can show the last confirmed login, marked as pending background confirmation.
- Allow more time for slow startup and finish the checking indicator promptly after identity is confirmed.
- Show a clear unfinished-save message when saving a local copy takes longer.
- Resume verification when the panel reopens. Rechecking starts a new check, and older responses cannot replace the latest login state.
