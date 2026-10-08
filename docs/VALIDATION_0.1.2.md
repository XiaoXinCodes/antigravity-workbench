# 0.1.2 验证范围 / Validation scope

- `npm run check` 执行类型检查、lint 和完整回归。云端修复检查为 1101 通过、2 跳过、0 失败；最终发布提交以三平台 CI 作业为准。
- 实际云端 Linux 文件设置为 `644/666/777` 后，均可完成密文导出、按密码解密及字节比对；导出不读取挂载信息，也不调用 chmod。Windows/macOS 平台值在云端使用模拟；发布 CI 则使用各自原生平台。
- 回归覆盖实际模式变化、系统 EACCES 不重试或更改权限、独占并发创建、已有文件拒绝覆盖、部分写入、同长度密文损坏、写入及读回或目录检查期间的文件替换、符号链接替换、父目录身份变化、取消清理，以及中英文导出提示和敏感信息不泄露。
- 真实账号、凭据、OAuth 服务和图片生成均不参与测试；仅使用虚构账号和密码，内部凭据、明文和日志存储权限保护未改。
- Linux、Windows、macOS 发布门禁运行相同回归、隔离实际 VS Code 宿主、包与许可校验；最终资产从 GitHub 下载后核对提交、源归档、运行模块和哈希。
- 云端完整离线回归在临时断网用户命名空间中执行，避免云端根目录 UID 映射影响原有私有日志检查；不修改宿主挂载、权限或生产策略。

真实 WSL / DrvFS 的 Windows 目录尚未实测，三平台 CI 不等于实际 DrvFS 验证；也未使用真实账号执行完整迁移。GitHub 与 Marketplace 发布独立，Marketplace 更新包需要单独上传。

English: tests use fictional accounts and passwords without real OAuth, credential stores or image calls. Cloud Linux checks accept actual broad file modes and retain encryption, exclusivity, same-descriptor ciphertext readback and replacement-safe cleanup. Windows/macOS values are simulated locally and run natively in release CI. An actual Windows directory on WSL / DrvFS and complete real-account migration have not been tested. GitHub publication and the separately uploaded Marketplace update are independent.
