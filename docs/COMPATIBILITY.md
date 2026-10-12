# 兼容性与限制

Workbench 按实际组件能力判断是否允许操作，不依赖固定官方版本字符串放行或拒绝。官方组件更新仍可能改变接口、登录存储或服务行为，需要重新核验相关能力。

## 按功能检查

| 功能 | 依赖与边界 |
| --- | --- |
| 保存当前账号 | 当前宿主和官方身份可核验，登录存储可安全读取 |
| OAuth 添加 / 切换 / 恢复 | 支持的凭据结构与存储路由、后台停止和重启能力、操作互斥及服务端身份核验 |
| 账号配额 | 该账号的授权、服务端身份和配额响应；授权更新另有支持范围与确认 |
| 图片生成 | 当前已保存且核验的官方账号、服务端图片模型、同一端点解析的 project、有效输出目录 |
| 已有图片恢复 | 明确选择的受支持官方会话 PNG 和当前宿主输出目录 |

## 平台

适配 Windows、macOS、Linux 本机扩展宿主与 WSL Linux 工作区宿主。两个扩展需要处于相同宿主，详见 [运行环境](ENVIRONMENTS.md)。SSH / 容器扩展宿主尚未核验。

原生系统密钥库、跨设备授权和官方服务调用不能仅由模拟或隔离测试证明。三平台 CI 覆盖工程、隔离 VS Code、打包等检查；本次发布未以真实账号切换或生图作为验收，详见 [验证说明](VALIDATION_0.1.11.md)。尚无所有平台、所有账号的长期稳定性结论。

## 独立 Antigravity IDE / Standalone Antigravity IDE

当前支持说明以 VS Code 1.95+ 与 Google Antigravity 扩展在同宿主运行为前提。独立 Antigravity IDE 的无账号启动、工作台 UI 和实际集成能力尚未验证；不能把扩展渠道支持或安装 VSIX 等同于账号、额度及图片功能兼容。

代码依赖同宿主 `google.google-antigravity` 的 `exports.port` / `csrfToken`、Hub RPC、`~/.gemini/bin/agy`（Windows 为 `agy.exe`），以及官方组件停止和 `antigravity.reconnect` 重连能力。须在目标 IDE 中逐项检测，不能仅凭其 VS Code 基础或版本字符串推断。

The current support scope assumes VS Code 1.95+ and the Google Antigravity extension on the same host. Standalone Antigravity IDE startup, Workbench UI and integration capabilities remain unverified. Registry availability or successful VSIX installation alone does not prove account, quota or image feature compatibility.

本轮只读检查未在本机标准 Linux / Windows 安装入口发现独立 IDE，未获取 IDE 版本，也未启动或操作真实账号。最小下一步是在明确的官方 IDE 安装路径与版本上，使用独立用户数据、扩展目录及空账号环境验证加载、页面和能力检测；账号切换、授权更新、额度及生图服务仍需单独验收。完整证据与边界见 [0.1.15 验证范围](VALIDATION_0.1.15.md)。

## 服务与数据

图片和配额服务可能因容量、速率、账号权限、project 或服务策略拒绝请求。单凭 429 不能确定个人额度已耗尽；一个端点的结果不能证明另一个端点同样可用。插件不会自动换账号、回退端点或绕过服务拒绝。


数据处理与服务关系统一见 [项目与服务说明](PROJECT_NOTICES.md) 和 [安全边界](SECURITY.md)。
