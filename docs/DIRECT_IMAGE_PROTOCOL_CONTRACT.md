# 图片客户端契约

本项目独立实现固定 HTTPS 图片请求。主要模块为 `direct-image-protocol`、`direct-image-binding`、`direct-image-project-transport`、`direct-image-transport`、`direct-image-response` 与 `direct-image-vscode`。

| 环节 | 实际行为与边界 |
| --- | --- |
| 端点 | 用户级设置只接受 Daily / Production，默认 Daily；每次确认后固定，不接受任意 URL、代理或跨端点回退 |
| 当前账号 | 从官方后台读取身份与图片模型，绑定同宿主保存副本；生成前重新检查，不由界面缓存推断 |
| project | 使用本次已核验授权向选定端点查询 `loadCodeAssist`，仅在本次内存使用，不混用其他端点的 project 或写回凭据 |
| 请求 | 固定 POST `/v1internal:generateContent`，包含 project、requestId、request、model、requestType；不附加 body userAgent |
| 标识 | 请求和 trajectory 使用新 UUID，不冒用官方会话；HTTP User-Agent 使用 Workbench 自身包版本 |
| 模型 | 采用当前可用图片模型 ID，标签优先使用后台字段，不给未知模型借用已知映射 |
| 参数 | 保留用户提示词、参考 PNG、尺寸与比例；不关闭安全设置，不伪装客户端身份 |
| 传输 | Node 原生 HTTPS、443、证书验证、固定目标、受限响应体；不跟随重定向或模拟其他客户端 TLS 身份 |
| 次数 | 确认的 1–4 次请求逐次运行，每次最多发送一次；拒绝、失败、取消或未知结果均不自动重发 |
| 响应 | 验证首个候选中的 PNG/JPEG 内容、多 part 与冲突字段；HTTP 200 不等于存在有效图片 |
| 保存 | 校验候选图片后独占创建文件并读回检查；部分保存失败保留已验证产物，不覆盖源文件或制造官方历史 |
| 状态变化 | 真正换号、模型不可用、端点改变及未完成恢复阻止继续发送；普通窗口焦点刷新不是账号切换 |

协议互通观察参考 [Antigravity-Manager 固定提交](https://github.com/lbjlaq/Antigravity-Manager/tree/6e8b982aee7e3d3d53501825431142eea9a3f9ab)，来源许可证为 [CC BY-NC-SA 4.0](https://github.com/lbjlaq/Antigravity-Manager/blob/6e8b982aee7e3d3d53501825431142eea9a3f9ab/LICENSE)。本项目采用独立 TypeScript 构造和合成 fixture，未打包其 Rust 源文件、重试器或完整模型目录；已核对的行为差异与来源审阅范围见 [项目与服务说明](PROJECT_NOTICES.md#参考与素材)。这不是对所有历史来源的完整版权清查结论。参考行为不构成 Google 的公开接口兼容保证。

合成测试覆盖序列化、账号/project 绑定、错误分类与产物校验。真实服务和发行包验证范围见 [验证说明](VALIDATION_0.1.0.md)。Production 429 原因仍未确认，不能把通用资源错误解释为个人图片张数用尽。
