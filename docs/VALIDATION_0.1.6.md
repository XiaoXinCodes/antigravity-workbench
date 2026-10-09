# 0.1.6 验证范围 / Validation scope

本版修复加密账号导出文件的同名替换。根因、文件事务设计、故障覆盖与初次本地检查见 [导出覆盖验证](VALIDATION_ACCOUNT_EXPORT.md)；账号导入保持 0.1.5 的核验与覆盖流程。

## 本地发行检查

2026-10-09，Linux x64 / Node 24.19.0，标准 umask 022。所有数据均为合成夹具，私有目录权限检查在原生执行环境运行，未放宽产品权限检查。

- `npm run check`：类型检查、lint 和完整回归；1,254 tests，1,250 pass，4 Windows-only skip，0 fail。
- 导出、迁移、迁移 UI 与 i18n 针对性检查 110 项通过；发行拒绝路径 23 项、打包文档 5 项通过。
- 隔离实际 VS Code 1.141.0 + Xvfb 宿主 smoke 通过；生产 workbench 36 项布局与点击验证通过。
- 中英文生产渲染 116 项、进行中文案切换 2 项与 24 张截图检查通过。
- VSIX 通过离线发行与 Marketplace 结构检查，核对扩展 ID `xiaoxincodes.antigravity-account-manager`、版本、许可、文档提交与全部运行模块。不上传 Marketplace。

## 发布门禁

PR 精确 head 与合并后 main 精确提交分别运行 Linux、Windows、macOS CI，包含完整检查、平台适用的合成原生测试、隔离实际 VS Code 宿主和 VSIX 打包校验。main 矩阵通过后由工作流创建新版本，禁止覆盖既有 Release、标签和附件。

正式发布前，工作流下载核对四个附件；交付时再次下载核对 `SHA256SUMS`、GitHub 资产 digest、`release-manifest.json`、VSIX 版本和 ID、源码及运行模块字节。最终提交、平台运行和资产证据保留在 GitHub Actions 与发行附件中。

## 边界

文件 I/O 和独立进程争用使用实际合成文件；取消、迟到结果、各步故障、路径变化与大整数文件身份使用注入夹具。隔离宿主使用实际 VS Code；导出文件选择与确认流程通过模拟 VS Code API 验证，不等同于手动点击原生控件。

Windows/macOS CI 不等同于用户实机或实际 WSL / DrvFS 验收。未读取真实凭证或迁移文件，未操作用户机器、真实 Google、账号切换或图片服务。导出不更改账号状态或官方凭证槽。

Node 的最后路径检查与 rename 不是针对其他应用的原子 CAS。排他标记协调遵守协议的导出者，快照拒绝已观察到的外部变化。中断留下的不确定标记不会强行接管；未承诺断电后的目录持久化。

All data and fault responses are synthetic. Native file operations and isolated VS Code hosts complement injected tests; platform CI does not establish real WSL/DrvFS or user-machine acceptance. Downloaded release assets provide commit and byte-level evidence. The final path check and rename are not an OS-level compare-and-swap against noncooperating directory writers.
