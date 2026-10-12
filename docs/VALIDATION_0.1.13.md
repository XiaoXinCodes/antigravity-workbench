# 0.1.13 验证范围 / Validation scope

用户可见变化见[发布说明](RELEASE_0.1.13.md)，字段与读取边界见[记录与用量说明](REQUEST_MODEL_OBSERVATIONS.md)。本版保留扩展 ID `xiaoxincodes.antigravity-account-manager`、MIT 许可及已有账号、图片、收藏、草稿和定时任务数据兼容。

离线检查覆盖元数据字段、已知与缺失 Token、时间来源及本机时区边界、工作区识别、筛选、空结果恢复、分页和 CSV / JSON 导出。完整 Linux 检查有 1,647 项通过、4 项既有平台跳过；许可、发布安全及打包文档另有 8、34、5 项检查。最终精确提交和合并后的 main 均由三平台 CI 验证，状态以 [GitHub Actions](https://github.com/XiaoXinCodes/antigravity-workbench/actions/workflows/ci.yml) 为准。

隔离 VS Code 使用合成 SQLite 数据、账号和阻断的模型传输验证 22 项实际界面检查，包括首次全部、同页概览与列表、空时段恢复、筛选保留、重复操作、长列表、窄窗口、导出和中英文同步。README 截图来自该实际界面，全部使用合成数据；不读取私人会话或真实凭据，不发送 Google 模型请求。

发布流程核对 VSIX、源码、release-manifest.json 和 SHA256SUMS，上传后回下载比对全部资产字节，核验源提交及编译模块。正式发布后仅删除本次已合并的 `feat/request-model-evidence` 分支；验证其 PR、分支头和 main，拒绝未合并提交或并发更新。

本轮不额外安装用户本机，也不上传 Marketplace。真实 Google 生成参数接受情况和各平台官方活动 WAL 等边界仍依赖实机环境，工程检查不证明底层模型权重。

Offline checks and 22 actual VS Code UI checks use synthetic data and blocked model transports. CI validates the exact PR and merged main commits on Linux, Windows and macOS. All four release assets are downloaded and byte-compared before publication. Extension identity and saved data remain compatible. No extra local installation, real Google model request or Marketplace upload is part of this release.
