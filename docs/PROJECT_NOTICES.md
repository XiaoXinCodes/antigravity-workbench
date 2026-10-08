# 项目与服务说明

Antigravity Workbench 是独立开发的 VS Code 扩展，与 Google 不存在隶属、授权或背书关系。项目自有部分采用 [Sustainable Use License 1.0](../LICENSE)，通过 GitHub Release 交付，尚未在 Marketplace 发布。

## 许可边界

SUL 允许个人、非商业及自身内部商业用途的使用和修改；向他人分发或提供软件必须免费且用于非商业目的。超出范围需向相应权利人另行取得授权。收费咨询或支持不是一概禁止，但不能借此绕过软件使用或对外提供的条件；见许可作者的[采用说明](https://blog.n8n.io/announcing-new-sustainable-use-license/)。以根目录完整英文正文为准，本页不增删条款。

这是 source-available（源码可见）许可，不是 OSI 标准开源许可。项目许可不会覆盖随包第三方材料的独立条件，见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.txt)。其中 TypeScript 编译器注入的辅助代码保留 Apache 2.0 许可。开发工具不作为项目自有代码重新授权，`node_modules` 不进入 VSIX 或源码包。

## 服务边界

使用 Google Antigravity 时，应遵守适用的服务条款、账号权限和组织政策。第三方工具能够完成某次调用，不代表服务方承诺持续兼容或允许所有使用方式；服务可拒绝调用、变更接口或要求重新授权。Google 附加条款第 6 条限制第三方工具访问，并可能涉及账号暂停或终止；部分企业订阅适用其他条款，见 [Antigravity 服务条款](https://antigravity.google/terms)。

图片请求可能消耗 Google 账号额度。请求已提交后取消，不保证服务端没有执行或计费。产品不提供自动账号轮换、跨端点回退或绕过服务限制的行为。

## 本机数据

已保存账号通过 VS Code SecretStorage 保管，加密导出包仍属于敏感登录备份。图片保存在所选目录；日志由用户预览后自行导出，不会自动上传。

实现保护与限制见 [安全边界](SECURITY.md)，实际执行范围见 [验证说明](VALIDATION_0.0.8.md)。

## 参考与素材

文档的信息层级参考了 [Antigravity-Manager README](https://github.com/lbjlaq/Antigravity-Manager/blob/main/README_ZH.md) 与 [文档目录](https://github.com/lbjlaq/Antigravity-Manager/tree/main/docs)。本项目的流程和文案按自身实现整理；该结构参考不是对参考项目代码或素材的再许可。

项目的 A、轨道与底座标志由 ChatGPT 图像生成工具生成：README 和扩展清单使用透明 PNG，活动栏使用同形单色 SVG。原始素材、派生脚本和摘要见 [品牌素材](https://github.com/XiaoXinCodes/antigravity-workbench/blob/main/assets/branding/README.md)。模拟界面与真实使用截图应明确区分。

图片协议与授权更新的互通行为参考了公开实现的固定提交，引用与接口边界分别见 [图片客户端契约](DIRECT_IMAGE_PROTOCOL_CONTRACT.md) 和 [授权更新](OAUTH_REFRESH.md)。参考项目采用 CC BY-NC-SA 4.0；该条件不会被本项目 SUL 覆盖，项目作者也不能代替第三方授予商业权限。引用不构成 Google 的接口兼容承诺。

本项目的图片请求使用 TypeScript 构造和合成 fixture，响应解码执行大小、冲突字段与图片格式检查。project 查询使用用户选定的固定端点；授权更新固定已核验的 consumer client。安装包不包含参考项目的 Rust 源文件、重试器或完整模型目录。

上述说明限定于列明的来源和当前交付内容，不是完整版权清查结论。若确认包含受保护的第三方改编，必须按原许可处理或取得原权利人授权；项目许可标签不能替代来源核验。
