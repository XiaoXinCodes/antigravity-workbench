# 0.0.8 验证范围

账号与图片服务测试使用虚构账号、mock 响应和本地演示图；这些检查不证明真实 Google 账号授权或模型可调用性。

- `npm run check` 执行 TypeScript 检查、静态检查与完整回归；发布流程在 Linux、Windows、macOS 上运行相同检查。
- `python test/release-safety.test.py` 检查发布与恢复的拒绝路径，使用虚构 release、commit 与 asset 数据，不执行网络或仓库写入。
- 隔离实际 VS Code 宿主检查扩展激活和手动语言设置。生产工作台渲染覆盖窄窗口、主题、布局和界面操作。
- 打包校验核对 68 个运行模块、源码归档、SUL 与第三方许可。正式结果以本次 Release 的提交、`release-manifest.json` 和 `SHA256SUMS` 为准。
- 中英 README 的六张截图展示实际渲染界面，使用虚构账号、额度与本地几何演示图。

## 边界

未将真实登录、OAuth、账号切换或生图作为发布验收。模型权限、服务端图片效果、额度、系统 keyring 和账号授权以实际使用环境为准。SSH / 容器宿主尚未核验。

静态 VS Code 命令、视图标题和设置描述遵循宿主显示语言；插件手动语言设置即时更新运行时界面。

[发行说明](RELEASE_0.0.8.md) · [中英界面架构](LOCALIZATION.md) · [兼容性](COMPATIBILITY.md)
