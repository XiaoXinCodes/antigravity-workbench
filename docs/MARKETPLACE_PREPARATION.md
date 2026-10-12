# Marketplace 发布准备

用户安装优先使用 Marketplace，GitHub Release 提供 VSIX 备用。此页记录维护者准备 Marketplace 更新时的检查项目；打包成功本身不代表发布完成。

| 项目 | 当前状态与后续工作 |
| --- | --- |
| 品牌图标 | 清单 `icon` 指向 256×256 PNG，README 使用同源 512×512 PNG。官方最低为 128×128，256×256 适合 Retina 显示；原图、缩放脚本和来源记录保留在完整源码中，未使用 Google 官方图标。 |
| 扩展身份 | 当前 ID 为 `xiaoxincodes.antigravity-account-manager`，显示名为 Antigravity Workbench。发布更新前核验现有 Marketplace publisher 的发布权限；清单中的 `publisher` 字符串不能代替权限核验。不要仅为改品牌而随意改变已安装扩展的 ID。 |
| 许可证 | 项目自有部分采用 [MIT License](../LICENSE)，包清单和锁文件根包标记为 `MIT`；随包第三方材料保留独立许可，见 [第三方声明](../THIRD_PARTY_NOTICES.txt)。服务条款与账号权限独立于代码许可。 |
| 仓库与支持链接 | 清单的 `repository`、`homepage`、`bugs` 已指向项目 GitHub 页面。公开详情页必须提供匿名可访问的文档、图片与支持入口，并实际核验 [安全报告流程](../SECURITY.md) 中的私密渠道。仓库可见性或访问权限变化须单独审阅。 |
| README 与 CHANGELOG | 上架前核对正文、链接和图片，并预览最终详情页。图片必须解析为 HTTPS URL，普通自有 SVG 不符合 Marketplace README/CHANGELOG 图片要求。打包后文档与图片链接固定到源码提交，离线校验覆盖链接重写与 Marketplace 文档处理；发布前仍需检查在线访问和详情页。 |
| VSIX 内容 | 当前构建校验覆盖版本、许可证、运行依赖、源码完整性及敏感内容排除。品牌变更后还需核验 PNG 格式、尺寸、清单路径、VSIX 中的文件以及详情页渲染；打包成功本身不能替代上架审查。 |
| 分类与关键词 | `Machine Learning` 对应图片生成与模型服务工具，`Other` 对应账号管理与迁移；8 个关键词描述现有用途，低于官方 30 个上限。发布包中检查实际 categories / keywords，避免把研究中的 IDE 兼容性写成已支持。 |
| 兼容与说明 | 清单声明 VS Code `^1.95.0`。三平台隔离宿主 CI 已通过，但不等于所有受支持宿主和真实服务端功能均验收。保留 Google Antigravity 依赖、宿主位置、账号操作、图片请求和日志处理的明确说明。 |
| 发布身份与操作 | 发布前核验 publisher 归属、采用官方支持的认证方式，并由维护者确认适用条款。GitHub Release 与 Marketplace 是独立渠道；当前 CI 仅处理 GitHub Release，发布配置变更需要独立审阅。 |

官方依据（核验日期：2026-10-04）：[Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)、[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。源码镜像：[Microsoft 的 manifest 文档](https://github.com/microsoft/vscode-docs/blob/main/api/references/extension-manifest.md)。

## Open VSX（待兼容性验收与单独授权）

2026-10-12 对当前扩展 ID 的公开 API 查询返回 404，尚未发现公开可下载版本。独立 Antigravity IDE 兼容性未验证，详情见 [0.1.15 验证范围](VALIDATION_0.1.15.md)。

官方支持网页上传 VSIX，前提是 Eclipse / GitHub 关联、签署 Publisher Agreement，并取得 `xiaoxincodes` namespace owner 权限；Marketplace 已存在的扩展须保持相同 publisher / name。协议、凭证、namespace 和新渠道上传不在当前 GitHub Release 授权中。不要仅为上架改扩展 ID 或把上架状态写成运行兼容性结论。

依据：[Publishing Extensions](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions)、[Managing Namespaces](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces)，核验日期 2026-10-12。
