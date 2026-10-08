<p align="center">
  <img src="media/brand-logo.png" width="144" height="144" alt="Antigravity Workbench A 标志">
</p>

<h1 align="center">Antigravity Workbench</h1>

<p align="center">在 VS Code 中管理多个 Google Antigravity 账号并生成图片。</p>

<p align="center"><strong>Source-available · Sustainable Use License 1.0</strong></p>

<p align="center">简体中文 · <a href="README_EN.md">English</a></p>

<p align="center">
  <a href="https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest">下载安装</a> ·
  <a href="docs/README.md">使用文档</a> ·
  <a href="https://github.com/XiaoXinCodes/antigravity-workbench/issues">提交问题</a>
</p>

## 功能

| 功能 | 用途 |
| --- | --- |
| 多账号管理 | 通过浏览器 OAuth 添加并保存多个账号；选择已保存账号切换，自动重启官方组件并核验身份，完成后生效 |
| 服务端配额 | 按账号查看模型额度、重置时间和查询状态，无需先切换当前账号 |
| 图片生成 | 跟随当前登录或独立选择已保存账号；按所选账号获取图片模型、比例和请求次数，保存并预览 PNG/JPEG，也可恢复已有 PNG |
| 创作记录 | 自动保存草稿、账号选择与任务卡，重载后恢复；中断任务保留状态，不会自动重发 |
| 继续修改与版本对比 | 将已保存结果放入可编辑草稿，保留来源与原图；查看已保存版本 |
| 用进项目 | 复制相对路径或 Markdown；明确点击后在所示文本文件插入，不自动保存 |
| 账号迁移与排障 | 导出账号、导入账号；命令面板的高级排障入口支持按需诊断及日志导出 |

## 运行环境

- VS Code 1.95 或更高版本，以及可用的 Google Antigravity 扩展和登录。
- 适配 Windows、macOS、Linux 本机扩展宿主，以及 WSL Linux 工作区宿主。Workbench 与 Google Antigravity 应运行在同一侧。
- 图片模型、可用额度与权限以 Google 所选账号返回的结果为准。

SSH 和容器扩展宿主尚未核验。平台适配与自动化检查不代表所有真实账号场景都已验证，详见 [兼容性](docs/COMPATIBILITY.md)。

## 安装

1. 打开 [最新 Release](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest)，从附件中下载最新的 `.vsix` 安装包。
2. 在目标 VS Code 窗口执行 **Extensions: Install from VSIX…**，选择文件。WSL 用户应确认安装到 Google Antigravity 所在的 WSL 宿主。
3. 按提示重载，在活动栏打开 **Antigravity Workbench**。

安装不会要求清空账号、登录文件或官方会话与图片。详见 [最新发行说明](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest)。

## 快速开始

**账号：** 点击“添加账号（OAuth 登录）”，在浏览器完成授权。添加仅保存新账号并恢复原登录；需要使用时，在账号卡片点击“切换”。也可以在“添加账号”旁点击“保存当前登录”。已保存且本机凭据可用时显示“已保存”；凭据缺失或失效时可更新原记录，不重复添加。这个状态只表示本机保存检查通过，不保证服务端授权仍然有效。切换完成后自动核验身份，卡片中可独立查询服务端配额。

**图片：** 打开图片生成面板，默认跟随当前登录，也可选择其他已保存账号。页面自动检查所选账号的可用模型；填写提示词、比例和请求次数，确认后生成。默认保存到当前项目，可选择其他目录；生成结果可直接预览。草稿和任务卡保存在本机，重载后恢复。需要找回已有图片时选择恢复入口，无需重新生成。

[账号管理](docs/INDEPENDENT_ACCOUNTS.md) · [服务端配额](docs/INDEPENDENT_ACCOUNT_QUOTA.md) · [图片详情](docs/IMAGE_GENERATION.md) · [完整文档目录](docs/README.md)

正常生图无需配置请求端点。图片确认后固定本次账号和模型；失败不会自动重试、切号或切换端点。需要排查连接问题时，参见 [高级排障](docs/TROUBLESHOOTING.md#高级排障图片端点)。

## 功能演示

下面的截图来自当前代码的实际 Chromium / VS Code 渲染，使用虚构账号、模拟额度和本地演示图；没有登录真实账号或发送生图请求。截图展示源码中的界面，安装包以最新 Release 为准。

1. **管理与保存账号。** 在同组工具栏添加账号或保存当前登录；已核验且本机副本可用时显示不可点击的“已保存”。账号卡片标明当前登录，保存状态不代表服务端授权保证。
2. **刷新模型额度。** 在对应卡片点击“刷新”，查看该账号的模型剩余比例、重置时间和更新时间；无需先切换登录。图中的账号和百分比均为演示值。

<img src="docs/images/accounts-zh-CN.png" width="410" alt="中文账号工作台：添加与已保存同组、当前登录标记和模型额度">

3. **准备图片请求。** 在图片工作室选择生图账号、服务端目录中的模型、提示词和请求次数。参考图区支持单张移除或全部清空；确认后才提交。图片额度属于所选账号与模型，百分比不换算张数。

<img src="docs/images/image-studio-zh-CN.png" width="960" alt="中文图片工作室：独立账号、模拟模型额度、参考图与已保存演示结果">

4. **清理参考图并保留结果。** 点击参考图右侧“移除”，或“全部清空”。下图是实际宿主执行清空后的状态，原图和右侧已保存结果仍保留；需要时可从结果继续修改。

<img src="docs/images/image-studio-cleared-zh-CN.png" width="960" alt="中文图片工作室清空参考图后，已保存结果和原图仍保留">

5. **即时切换语言。** 在设置中将 `antigravityAccounts.language` 改为 `en`，现有面板立即切换并保留输入、账号、参考图和任务。查看 [英文版相同演示](README_EN.md#feature-walkthrough) 的实际界面截图；改回 `zh-CN` 即恢复中文。

## 界面语言

插件默认使用简体中文，不跟随系统语言。点击工作台“设置 / Settings”，或在 VS Code 设置中搜索 `antigravityAccounts.language`，手动选择 `zh-CN` 或 `en`。选择保存在用户设置；已打开的工作台、图片面板、提示和快速入门立即更新，草稿、参考图、账号选择、布局与任务继续保留。

VS Code 的命令面板、视图标题和设置描述属于静态贡献项，随 VS Code 的显示语言加载；改变 VS Code 显示语言可能需要重载窗口。插件的手动语言选择不会改变这些静态项。

## 隐私与使用边界

账号凭据存放在 VS Code SecretStorage 或当前宿主的受限存储中；账号导出使用 `.agwenc` 加密格式。草稿、参考图路径和任务记录保存在当前宿主，图片写入你选择的目录。日志和账号导出包不会自动上传。生成时，所选账号的授权、提示词和选定参考图会发给相应 Google 服务；请只提交你有权使用的内容。

切换账号会写入官方组件的本机凭据并重启组件。遇到未完成事务或身份核验失败，应按恢复提示操作。不要把 token、凭据文件、导出包或未经检查的日志放进 Issue。模型是否可用、能否调用和额度含义以服务端结果为准；模型名称不保证权限，额度百分比不等于可生成张数。

## 调试与反馈

从命令面板打开“Antigravity Workbench: 高级排障…”，选择开启调试日志，复现一次问题后关闭。通过“预览 / 导出日志”检查内容并保存，在 [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues) 提供扩展版本、系统与宿主、复现步骤、预期结果及错误码。不要附上凭据文件或账号导出包；插件不会自动上传日志。疑似漏洞请按 [安全报告流程](SECURITY.md) 私下报告。

[日志说明](docs/DEBUG_LOGS.md) · [兼容性与限制](docs/COMPATIBILITY.md) · [项目与服务说明](docs/PROJECT_NOTICES.md)

## 开发

源码包含 TypeScript、测试、构建脚本和锁文件，无运行时 npm 依赖。

```sh
npm ci --ignore-scripts
npm run check
npm run test:host
npm run package
```

无显示器的 Linux 使用 `xvfb-run -a npm run test:host`。CI 覆盖 Linux、Windows、macOS 的检查、隔离 VS Code 宿主和打包；Release 提供 VSIX、完整源码与 SHA-256 校验文件。

问题讨论、提交步骤与来源要求见 [贡献指南](https://github.com/XiaoXinCodes/antigravity-workbench/blob/main/CONTRIBUTING.md)。

## 许可

项目自有部分采用 [Sustainable Use License 1.0](LICENSE)，属于 source-available（源码可见）许可，不是 OSI 标准开源许可。

允许个人、非商业及自身内部商业用途的使用和修改；向他人分发或提供软件必须免费且用于非商业目的。超出正文许可范围的用途，需要向权利人另行取得授权。收费咨询或支持本身并非一概禁止，但软件的使用、分发和提供仍须满足正文条件。这段摘要不增加或替代 [LICENSE](LICENSE) 的条款。

实际随包的第三方代码保留独立许可，见 [第三方声明](THIRD_PARTY_NOTICES.txt)。该许可不授予 Google 服务访问权，也不覆盖第三方代码、素材或商标的权利，详见 [项目与服务说明](docs/PROJECT_NOTICES.md)。
