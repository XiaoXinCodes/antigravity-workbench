# 0.1.12 验证范围 / Validation scope

用户可见变化见[发布说明](RELEASE_0.1.12.md)。模型目录审计、服务端字段证据和数据缺口见[模型目录重构记录](MODEL_CATALOG_REFACTOR.md)。本版保留 MIT、扩展 ID、账号与图片数据兼容及 0.1.11 成功额度读数保留修复。

工程检查覆盖未知新 ID、目录新增及移除、禁用、能力缺失或矛盾、重命名、账号与独立生图账号切换、端点隔离、目录失败及刷新、最终请求 modelID 和参数、普通定时请求路由、选择迁移及中英文显示。AST 回归检查约束生产型号依赖。1525 项测试在 Linux 上有 4 项 Windows 条件跳过；许可、发布安全及打包文档另有 8、34、5 项检查。

隔离 VS Code 使用合成账号和阻断的模型传输验证扩展激活、额度及窗口重载、语言、图片历史、普通和高级定时任务；不使用真实用户凭据或生成图片。三平台 CI 对精确 PR 提交和合并后的 main 运行工程、宿主及包检查；Linux 另运行额度、语言、定时任务和实际界面截图。最终状态以 [GitHub Actions](https://github.com/XiaoXinCodes/antigravity-workbench/actions/workflows/ci.yml) 为准。

发布流程回下载正式 VSIX、源码包、release-manifest.json 和 SHA256SUMS，核对源提交及编译字节。成功后只清理本次 `refactor/server-model-catalog` 分支，并核对发布标签、精确已合并 PR、分支头与 main；拒绝独有提交或并发更新。

用户本机已安装同提交的先前候选并完成 102 个运行模块比对，用户尚未确认实际界面验收。真实 Google 参数接受情况、账号操作及 Windows／WSL／macOS 升级仍需实机验证。本轮不再次安装用户本机，不上传 Marketplace。

Tests use synthetic accounts and blocked model transports. CI validates the exact PR and merged main commits on Linux, Windows and macOS; release assets are downloaded and compared with their source and runtime bytes. The previous candidate was installed locally and its 102 runtime modules matched, but user UI acceptance and real Google request compatibility remain unconfirmed. Marketplace upload is outside this release.
