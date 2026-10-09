# Antigravity Workbench 0.1.7

## 简体中文

改善账号操作的后台处理，修复账号与图片界面的交互问题。

- 切换、添加与恢复通过一次范围确认处理本窗口后台和已核实的遗留任务；冲突时显示恢复详情，停止等待超时会给出明确提示。
- 修复本地宿主识别、刷新额度后的登录状态、已签出时删除跨宿主副本，以及 Windows 并发保存账号快照的问题。
- 保留连续输入的图片草稿，补齐缺参数与停止后的提示，并修复语言切换后遗留的错误文案。
- 导入导出更准确地提示任务占用，并在确认后等待本插件图片任务释放。

## English

Improve background handling for account operations and fix account and image interactions.

- Switch, add and restore accounts with one confirmation covering this window's background processes and verified leftovers. Show recovery details for conflicts and a clear error when stopping takes too long.
- Fix local-host detection, login state after quota refresh, removing foreign-host copies while signed out, and concurrent account snapshot saves on Windows.
- Preserve image drafts during rapid typing, clarify missing-input and stopped-request messages, and update existing error text when the language changes.
- Clarify task conflicts during import and export, and wait for confirmed Workbench image tasks to release their resources.
