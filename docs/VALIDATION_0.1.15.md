# 0.1.15 验证范围

## 发布范围

从公开仓库 `XiaoXinCodes/antigravity-workbench` 的 main / v0.1.14 提交 `ddce0d1a8cd4f014e98792ea22018337a3ff9f27` 开始。只更新清单发现信息、版本与发布路径、中英文介绍及兼容性说明；同步两处请求 User-Agent 与离线协议样本的版本标识；不修改账号存储、官方配置或运行行为，不覆盖本机已装候选版本。

分类为 `Machine Learning`（图片生成与模型服务工具）、`Other`（账号管理与迁移），关键词共 8 个，均对应现有功能。官方允许分类及最多 30 个关键词，见 [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)，核验日期 2026-10-12。

## 检查与资产

发布检查使用 `npm run check`、许可、发布安全及包文档离线测试、`npm run package`、Release 和 Marketplace VSIX 校验。GitHub Actions 在精确 PR 提交及合并后的 main 上分别执行 Linux、Windows、macOS 矩阵与隔离 VS Code 宿主检查；真实服务调用与独立 Antigravity IDE 不属于这套 CI。公开截图沿用已审阅的合成账号和模拟记录，未添加用户截图、邮箱或真实请求。

main CI 成功后，现有发布脚本生成 VSIX、源码 ZIP、release-manifest.json 和 SHA256SUMS，并在下载比对成功后公开 Release。清理脚本仅针对本轮已合并的发布分支，要求已合入当前 main、无独有提交及精确分支 lease；不会清理其他分支。最终运行结果与哈希以对应 GitHub Actions 和 Release 资产为准。

## 独立 Antigravity IDE：只读发现

2026-10-12，在 pzh WSL 的 Linux 命令路径、桌面入口、dpkg 记录、标准程序目录，以及 Windows 的 Program Files、当前用户 Local Programs 和开始菜单入口中未发现独立 IDE。只读查询 HKCU、HKLM 与 WOW6432Node 卸载注册表，也没有名称匹配 Antigravity 的安装记录。发现 `~/.gemini/bin/agy` 后端文件，但它不能证明独立 IDE 已安装。该结果限于这些标准入口，不排除未提供路径的便携安装。

| 项目 | 本轮证据 / 状态 |
| --- | --- |
| 独立 IDE 安装路径与版本 | 未发现，版本未获取 |
| 清单与源码集成依赖 | 已检查：VS Code `^1.95.0`、同宿主 `google.google-antigravity`、`exports.port` / `csrfToken`、固定 Hub RPC、`~/.gemini/bin/agy`、官方 deactivate 与 `antigravity.reconnect` |
| 独立 IDE 加载 VSIX / 激活 / A 图标与页面 | 未验证；缺少目标 IDE |
| 独立 IDE 无账号能力检测与禁用反馈 | 未验证；缺少目标 IDE |
| 原生密钥库、OAuth、加密迁移与恢复 | 未在独立 IDE 验证 |
| 登录切换、后台停止 / 重启与 Hub 身份核验 | 未在独立 IDE 验证 |
| 模型目录、额度、图片生成与定时推理 | 未在独立 IDE 验证；本轮未发送相关真实请求 |

最小阻塞为明确的官方 IDE 安装路径与版本。具备后，先使用独立 HOME / USERPROFILE（平台允许时）、用户数据和扩展目录、空账号环境，验证启动、扩展加载、UI 与只读能力检测；不挂载当前用户的官方登录文件，不切换账号。遇到强制登录或新增权限时停止，并请求所需范围；不据此声称不兼容。真实账号与服务功能仍需另行授权与验收。

## Open VSX 分发边界

2026-10-12 对 [目标扩展 API](https://open-vsx.org/api/xiaoxincodes/antigravity-account-manager/latest) 的只读查询返回 HTTP 404：`Extension not found: xiaoxincodes.antigravity-account-manager latest`。这证明本次查询未发现公开可下载的该 ID 最新版本，不证明其他 namespace 或待审核上传不存在。

[Publishing Extensions](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions) 当前支持网页选择或拖放 VSIX；须关联 Eclipse / GitHub、签署 Publisher Agreement，并对已存在于 Marketplace 的同一 publisher 取得 Open VSX namespace owner 权限。归属流程见 [Managing Namespaces](https://github.com/EclipseFdn/open-vsx.org/wiki/Managing-Namespaces)。本轮没有签协议、建凭证、申请 namespace 或上传 Open VSX。Marketplace 仍由维护者手动上传。

独立 IDE 的扩展渠道与插件的运行兼容性分别核验；Open VSX 上架或安装成功都不能证明登录、额度或生成能力可用。
