# 独立生图账号设计

独立图片账号支持在不切换官方当前登录的情况下读取所选账号目录并提交图片任务。验证边界见 [验证说明](VALIDATION_0.0.8.md)。

## 行为

“跟随当前登录”保留原官方 Hub 目录、身份及当前授权读取路径。在提交时解析实际 accountId，完成前置核验后固定 bearer；生成前后不再因官方当前登录变化而改写此请求。

显式选择保存账号 B 时，页面保持 B，即使官方当前 A 的状态刷新。首次使用需在宿主弹窗确认本窗口的独立生图用途，才可读取 B 的加密副本、必要时刷新并安全写回、查询身份/project/图片模型。此确认不持久化，不读取或迁移其他密钥，不创建新 OAuth 授权。生成仍由原逐批确认批准消耗。

## 数据边界

- 普通页面只拿到账号标签、ID、模型列表和固定状态；bearer、refresh token、project、存储 revision 都只留在扩展宿主。
- `SavedImageAccounts` 的许可和缓存按账号元数据指纹、端点、加密记录 revision 分区；缓存最多 5 分钟且提前于 token 过期。主动重查清除当前缓存。没有持久模型/project/token 缓存。
- 身份前后核验使用同一 bearer。project 和模型目录从同一所选端点解析；严格要求该账号响应中的 `imageGenerationModelIds` 和对应未禁用记录，不借用 A，不硬编码 project。
- 每批只绑定一次账号和模型。各张图片携带实际 accountId，任务卡显示账号标签、邮箱和账号编号。失败停止，没有自动跨账号或跨端点重试。

## 并发与刷新

复用 `SavedAccountQuotaClient.withAccess` 的已测试授权事务。quota 原行为保持；新通用方法仅包围身份和元数据请求，禁止把计费生图放进可能为过期授权重试的事务。

所有保存账号凭据操作仍使用现有宿主 filesystem operation lock，与配额刷新、移除、切换共用。图片 metadata 请求在当前宿主内排队，取得锁后重新读加密记录，避免使用排队前的旧 refresh token。同宿主其他窗口持锁时明确报忙，不强抢锁。

刷新响应先写 SecretStorage pending，服务端核验身份后提交；保存前比较原 slots 和完整记录 revision，保存后回读核验。取消已开始的 refresh exchange 时，先有界完成安全暂存/身份核验/提交，再报告取消，不把可能轮换的 refresh token 丢弃。删除或替换账号后不复活记录，迟到响应不更新模型页面或缓存。

SecretStorage 本身没有 CAS；此设计依靠同宿主互斥与 revision 前后复核，不宣称能够阻止外部设备或官方客户端使用同一授权的内部轮换。首次用途提示明确说明此风险。

## 网络与真实验证边界

固定 Google HTTPS 目的地：`www.googleapis.com/oauth2/v2/userinfo`（既有身份传输），`oauth2.googleapis.com/token`（只在需要刷新时），所选 `daily-cloudcode-pa.googleapis.com` 或 `cloudcode-pa.googleapis.com` 的 `/v1internal:loadCodeAssist` 与 `/v1internal:fetchAvailableModels`。生成沿原固定图片端点。拒绝重定向、未知目录形状和超限响应；不记录正文。

在 Windows VS Code + WSL 的已授权实测中，账号 B 的身份、Daily project 和模型目录返回 200；生成前验证同一 bearer、project 和模型归属后，仅提交一次图片请求并成功保存。官方账号 A 的身份在前、中、后均保持不变。该次未触发 refresh；刷新事务、并发与取消仍以模拟回归覆盖，不把单次成功外推为所有平台和长期服务保证。

## 验证

新增回归覆盖独立用途确认、A/B 并发隔离、同号刷新、轮换持久化、revision 冲突、删除、官方当前号变化、整批冻结、错误不回退、取消及迟到结果、模型联动与参数保留。交互 fixture 使用生产 HTML 与合成宿主响应；实际控制器另有单元测试。浏览器截图验证五种宽度及原生键盘选择/按钮激活，不证明真实账号调用。
