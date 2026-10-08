# Antigravity Workbench 0.1.2

发布日期 / Release date: 2026-10-08 (UTC)

## 简体中文

修复从 WSL 向 Windows 目录导出加密账号迁移包时，因文件继承权限不同而被误判为文件变化的问题。

- 密码加密后的 `.agwenc` 导出不再校验实际 POSIX 权限模式，也不要求特定文件系统。创建时仍请求私有权限作为默认值，但不强制实际模式、不探测挂载、不更改目录权限或系统设置；系统拒绝读写时仍会停止。
- 保留 AES-256-GCM 加密和 scrypt 密钥派生、独占创建、防覆盖、符号链接拒绝、文件及父目录身份与长度校验。新增从同一文件句柄读回密文字节，检出同长度内容损坏；失败只清理自身创建的文件，保留其他进程的替换文件。
- 文件或目录变化使用明确的中英文导出提示，不再显示“读取中已变化，未导入”。此调整仅适用于密码加密后的导出文件，内部凭据、明文和日志保护保持不变。

升级保留扩展 ID 和已有账号、图片数据。在 VS Code Marketplace 更新可用后升级，或下载本 Release 的 `.vsix` 并执行 **Extensions: Install from VSIX…**。Workbench 与 Google Antigravity 应运行在同一宿主；WSL 用户仍需检查安装目标。Marketplace 是独立更新渠道，GitHub 发布不表示市场版本已更新。

发布门禁在 Linux、Windows、macOS 运行完整回归、隔离实际 VS Code 宿主、打包和许可检查。云端已验证实际 Linux `644/666/777` 文件可导出，模拟平台值与文件变化使用虚构数据。真实 WSL / DrvFS 的 Windows 目录尚未实测，真实 Google 账号迁移和真实图片调用未作为本次验收。详见 [验证范围](VALIDATION_0.1.2.md)；提交、资产及哈希见 `release-manifest.json` 和 `SHA256SUMS`。

## English

Fix encrypted account exports from WSL to Windows directories being mistaken for file changes because of inherited permissions.

- Password-encrypted `.agwenc` exports no longer enforce actual POSIX modes or a filesystem whitelist. A private creation mode remains a default request, without mount probing, directory permission changes or system settings changes. Operating-system read/write denial still stops the operation.
- Preserve AES-256-GCM encryption and scrypt key derivation, exclusive creation, no overwrite, symlink rejection, and file and parent-directory identity and length checks. Ciphertext readback through the same descriptor detects same-length corruption. Failure cleanup removes only the file created by this export and preserves external replacements.
- File or directory changes receive precise bilingual export messages rather than an import-while-reading error. This policy applies only to password-encrypted export artifacts; internal credential, plaintext and log protections remain unchanged.

Upgrades retain the extension ID, accounts and images. Update through VS Code Marketplace when its update becomes available, or download this release's `.vsix` and run **Extensions: Install from VSIX…**. Workbench and Google Antigravity must run on the same host; check the installation target for WSL. Marketplace is a separate update channel; a GitHub release does not mean the listing has been updated.

Release gates run full regressions, an isolated actual VS Code host, packaging and license checks on Linux, Windows and macOS. Cloud checks exercised actual Linux `644/666/777` files; platform-value simulations and mutation tests use fictional data. An actual Windows directory on WSL / DrvFS has not been tested. Real Google account migration and real image calls were not acceptance tests. See [validation scope](VALIDATION_0.1.2.md), `release-manifest.json` and `SHA256SUMS` for boundaries, commit and asset hashes.
