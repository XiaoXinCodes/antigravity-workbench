# 项目与服务说明

Antigravity Workbench 是独立开发的 VS Code 扩展，与 Google 不存在隶属、授权或背书关系。当前源码的项目自有部分采用 [MIT License](../LICENSE)。安装优先使用 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xiaoxincodes.antigravity-account-manager)，[GitHub Release](https://github.com/XiaoXinCodes/antigravity-workbench/releases/latest) 提供 VSIX 备用与源码。已发布版本以各自发行包中的许可为准。

## 许可边界

MIT 允许使用、复制、修改、分发、再许可和销售项目自有软件，条件是保留版权和许可声明；软件按原样提供，不附带担保。以根目录 [LICENSE](../LICENSE) 完整正文为准。

项目许可不会覆盖随包第三方材料的独立条件，见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.txt)。其中 TypeScript 编译器注入的辅助代码保留 Apache 2.0 许可。开发工具不作为项目自有代码重新授权，`node_modules` 不进入 VSIX 或源码包。

## 服务边界

使用 Google Antigravity 时，应遵守适用的服务条款、账号权限和组织政策。第三方工具能够完成某次调用，不代表服务方承诺持续兼容或允许所有使用方式；服务可拒绝调用、变更接口或要求重新授权。Google 附加条款第 6 条限制第三方工具访问，并可能涉及账号暂停或终止；部分企业订阅适用其他条款，见 [Antigravity 服务条款](https://antigravity.google/terms)。

图片请求可能消耗 Google 账号额度。请求已提交后取消，不保证服务端没有执行或计费。产品不提供自动账号轮换、跨端点回退或绕过服务限制的行为。

## 本机数据

已保存账号通过 VS Code SecretStorage 保管，加密导出包仍属于敏感登录备份。图片保存在所选目录；日志由用户预览后自行导出，不会自动上传。

实现保护与限制见 [安全边界](SECURITY.md)，实际执行范围见 [验证说明](VALIDATION_0.1.1.md)。

## 参考与素材

文档的信息层级参考了 [Antigravity-Manager README](https://github.com/lbjlaq/Antigravity-Manager/blob/main/README_ZH.md) 与 [文档目录](https://github.com/lbjlaq/Antigravity-Manager/tree/main/docs)。本项目的流程和文案按自身实现整理；该结构参考不是对参考项目代码或素材的再许可。

项目的 A、轨道与底座标志由 ChatGPT 图像生成工具生成：README 和扩展清单使用透明 PNG，活动栏使用同形单色 SVG。原始素材、派生脚本和摘要见 [品牌素材](https://github.com/XiaoXinCodes/antigravity-workbench/blob/main/assets/branding/README.md)。模拟界面与真实使用截图应明确区分。

图片协议与授权更新的互通行为参考了公开实现的固定提交，引用与接口边界分别见 [图片客户端契约](DIRECT_IMAGE_PROTOCOL_CONTRACT.md) 和 [授权更新](OAUTH_REFRESH.md)。参考项目采用 CC BY-NC-SA 4.0；该条件不会被本项目 MIT 许可覆盖，项目作者也不能代替第三方授予商业权限。引用不构成 Google 的接口兼容承诺。

本项目的图片请求使用 TypeScript 构造和合成 fixture，响应解码执行大小、冲突字段与图片格式检查。project 查询使用用户选定的固定端点；授权更新固定已核验的 consumer client。安装包不包含参考项目的 Rust 源文件、重试器或完整模型目录。

上述说明限定于列明的来源和当前交付内容，不是完整版权清查结论。若确认包含受保护的第三方改编，必须按原许可处理或取得原权利人授权；项目许可标签不能替代来源核验。
