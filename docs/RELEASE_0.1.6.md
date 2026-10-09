# Antigravity Workbench 0.1.6

## 简体中文

修复导出账号包时，确认覆盖后仍无法保存同名文件的问题。

- 先选择目录与文件名，再一次确认导出范围和已有文件替换。
- 同名导出成功时替换旧账号包；写入或替换失败时保留旧文件。
- 检测确认后的文件变化与并发导出，并提示重新确认或稍后重试。
- 中英文提示同步更新，取消导出不会更改账号状态。

## English

Fix exporting to an existing account archive after confirming replacement.

- Choose a folder and filename, then confirm the export scope and replacement together.
- Replace the previous archive on success and retain it if writing or replacement fails.
- Detect file changes after confirmation and concurrent exports, with prompts to confirm again or retry later.
- Update Chinese and English messages; canceling export leaves account state unchanged.
