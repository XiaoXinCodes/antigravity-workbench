# 0.1.5 验证范围 / Validation scope

账号导入的设计、故障覆盖与初次实现证据见 [账号导入验证](VALIDATION_ACCOUNT_IMPORT.md)。本版不更改账号或图片的数据目录，也不执行真实账号迁移、官方登录切换或图片请求。

## 本地发行检查

2026-10-09，Linux x64 / Node 24.19.0；私有目录权限检查在原生执行环境与标准 umask 022 下运行，未放宽产品权限检查。

- `npm run check`：类型检查、lint 和完整回归；1,220 tests，1,216 pass，4 Windows-only skip，0 fail。
- 发行拒绝路径夹具 23 项、打包文档夹具 5 项通过；已有 Release、标签和附件禁止覆盖。
- 隔离 VS Code 1.141.0 + Xvfb 实际宿主 smoke 通过；生产 workbench 36 项布局与点击验证通过。
- 中英文生产渲染 116 项、进行中文案切换 2 项与 24 张截图检查通过。
- 0.1.5 VSIX 通过离线发行与 Marketplace 结构校验；核对扩展 ID `xiaoxincodes.antigravity-account-manager`、版本、许可、文档提交与全部运行模块字节。不上传 Marketplace。

## 发布门禁

PR 精确 head 和合并后 main 精确提交必须分别通过 Linux、Windows、macOS CI。矩阵执行完整检查、平台适用的合成原生测试、隔离实际 VS Code 宿主和 VSIX 打包校验。发布仅由通过 main 矩阵的 workflow 执行；创建新标签及四个附件后下载核对，再正式发布。最终运行与提交、附件哈希保留在 GitHub Actions、`release-manifest.json` 和 `SHA256SUMS`，并在交付时再次下载验证。

## 边界

所有账号、token、身份、额度与故障响应均为合成数据；候选服务器核验、轮换与 SecretStorage 故障通过注入夹具覆盖。隔离宿主测试使用实际 VS Code，但不使用真实 Google 登录或真实 OS keychain 故障。Windows/macOS CI 的原生运行不等同于用户实机或实际 WSL / DrvFS 账号验收。

SecretStorage 没有 fsync 或跨服务器响应的原子提交保证；无法恢复从未成功持久化的轮换响应，此时保留未知标记并阻止重用旧 refresh token。跨进程不遵守操作锁的外部应用不具备 CAS 保证。

All credentials and server/fault responses are synthetic. Real isolated VS Code hosts and platform-appropriate native checks complement mocks; no real Google authorization, user-machine operation, image request or Marketplace upload is part of this release. CI and downloaded release assets supply the final commit and byte-level evidence.
