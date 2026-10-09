# Antigravity Workbench 0.1.8

## 简体中文

改善 WSL 账号切换的后台确认与官方启动兼容性。

- 后台归属未知时，核验同一登录范围后支持明确确认处理，并提醒可能中断相关窗口的任务。
- 兼容官方 1.7 默认启动方式与多根工作区，保留取消、身份变化和无法核验时的保护。
- 补齐 Windows 后台检查的系统配置目录环境。

## English

Improve background confirmation for WSL account switching and official launch compatibility.

- Allow explicit handling of a background process with unknown window ownership after verifying its shared login scope, with a warning about interrupting related windows.
- Support the default official 1.7 launch and multi-root workspaces while retaining cancellation and identity checks.
- Preserve Windows system profile paths for background checks.
