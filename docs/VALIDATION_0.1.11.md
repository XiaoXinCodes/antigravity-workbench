# 0.1.11 验证范围 / Validation scope

用户可见变化见 [发布说明](RELEASE_0.1.11.md)。额度显示缓存与执行请求的严格身份修订分开：成功读数可作为历史值恢复；恢复不刷新查询时间，不授权账号操作、额度推荐或自动模型请求。删除、明确替换、主体及宿主归属变化仍隔离旧数据。实现与状态转换见开发记录 `docs/QUOTA_DISPLAY_RETENTION.md`。

本地 Linux 检查涵盖类型、Lint、1486 项回归（1482 通过，4 项 Windows 条件跳过），以及许可（8 项）、发布安全（34 项）和打包文档（5 项）校验。隔离 VS Code 1.141.0 的生产扩展宿主、额度卡片、原生快速选择、置顶状态栏、图片页关闭重开及完整 Reload Window 通过；重载后恢复四张历史账号卡片和图片 37.50% 合成读数。新增用例覆盖 TTL、刷新失败、同身份重新捕获、明确替换、删除后迟到响应、跨控制器与磁盘恢复、缓存损坏和容量上界。

Linux、Windows、macOS 对精确 PR 提交运行工程、隔离 VS Code 宿主和打包校验；Linux 另验额度、语言、自动请求的合成夹具及实际界面截图。main 合并后重跑三平台矩阵；发布流程回下载 VSIX、源码包、manifest 和 SHA256SUMS，核对源码提交及编译运行字节。发布成功后只清理本次 `fix/quota-display-retention` 分支：核对精确已合并 PR、发布标签、main 与分支头，并用 Git 租约拒绝并发更新；有独有提交或归属变化则拒绝清理。执行记录见 [GitHub Actions](https://github.com/XiaoXinCodes/antigravity-workbench/actions/workflows/ci.yml)。

先前本地候选包已按用户授权安装至实际 WSL 扩展目录，安装后的 100 个运行模块与候选包一致；本轮发布不再次安装或重载用户窗口。真实 Google 服务、真实账号切换及用户现有窗口中的修复激活尚未验收。Marketplace 由维护者手动更新。本版保留 MIT、扩展 ID、第三方 NOTICE、账号和图片数据格式；不新增 README 社区链接。

Successful readings can be restored as historical data without renewing their query time or relaxing request identity checks. Local Linux regression and isolated VS Code checks use synthetic accounts and transports, including image-page reopening and a full test-window reload. CI validates the exact PR and merged main commits on Linux, Windows and macOS, and release assets are downloaded and checked against their source and compiled runtime. The user's current window and real Google services remain unverified; Marketplace upload is manual.
