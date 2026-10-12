# Antigravity Workbench 0.1.14

整个工作台采用统一布局和导航，切换功能时保留草稿、选择和筛选。

- 活动栏 A 图标打开完整编辑器工作台；宽屏保留左侧导航，窄窗口使用可键盘操作的“切换功能”。
- 账号、额度与历史、图片工作室、模型与 Token、定时请求、提醒、设置和帮助统一层级与操作反馈；支持中文／English、深浅色和高对比度主题。
- 模型与 Token 记录首次打开自动读取本机数据；每日趋势支持悬停、点按及方向键查看精确用量。
- 定时请求自动读取所选账号的模型目录；复用有效结果，刷新和取消保留已有列表。修复已复现的初始化／操作锁冲突，准备结束后自动继续读取。
- 明确区分“保存，暂不启用”“查看执行时间”和“立即执行一次”，避免把保存或预览误认为执行。

升级保留已有账号、图片、草稿和设置。请下载下方 VSIX，在原来的 VS Code 或 WSL 宿主安装后重载。Marketplace 由发布者另行上传。

---

The workbench now uses one layout and navigation while retaining drafts, selections and filters across modules.

- The A activity icon opens the full editor workbench, with persistent navigation on wide views and a keyboard-accessible Switch feature menu on narrow views.
- Accounts, quota and history, Image Studio, model and Token records, schedules, alerts, settings and help share consistent controls and feedback, with Chinese/English and native light, dark and high contrast themes.
- Local model and Token records load automatically on opening; inspect exact daily usage with hover, tap or arrow keys.
- Schedules load the selected account's model directory automatically and reuse valid results. Refresh and cancellation retain previous choices. Fixed reproduced initialization/operation-lock conflicts so loading continues when preparation ends.
- Save without enabling, View run times and Run once now clearly distinguish storing, previewing and executing a task.

Upgrading retains accounts, images, drafts and settings. Install the attached VSIX on the same VS Code or WSL host and reload. Marketplace upload is handled separately by the publisher.
