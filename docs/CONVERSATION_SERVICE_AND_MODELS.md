# 定时请求：对话服务端点与普通模型目录

本次在 PR6 候选 `e34701f` 上修复“请求服务只有 Daily / Production，含义不清”。正式版本仍为 0.1.8；真实 Google 账号、计费和 WSL 尚未验收。

## 已确认的原因与证据边界

原界面把 Cloud Code 主机选择写成“请求服务”，选项只显示 Daily / Production。截图中的模型栏为空且未展开，不能据此证明选择或发送了图片模型。云端 Library 图片物化未成功；截图内容由本机线程读取，用户另行明确确认端点选项含义不清。本次没有获取该账号的实时模型目录，也没有保存或上传包含真实身份的原截图。

原 `wake-accounts.ts` 使用的 `readSavedImageModels` 实际调用通用 `fetchAvailableModels`，并不执行图片生成；原 `wake-transport.ts` 已发送短文本 `Hi`、`requestType: agent` 和正数输出预算，没有图片参数。代码可确认的另一项风险是：原普通目录只排除显式 `imageGenerationModelIds`，缺少分类清单时会放行整个 map。这是源码推断，不能说成用户账号已发生图片请求。

## Cockpit 实际调用链

核对当前 main `58d51e3074def47513cb1de6338f76e95b3a638e`、v2.1.52 的源码，未以 README 代替实现：

| 位置 | 证据 |
| --- | --- |
| [scheduler_service.ts](https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/58d51e3074def47513cb1de6338f76e95b3a638e/src/auto_trigger/scheduler_service.ts#L324) | 调度器调用配置对应的 trigger 回调 |
| [controller.ts](https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/58d51e3074def47513cb1de6338f76e95b3a638e/src/auto_trigger/controller.ts#L326) | 使用额度模型常量过滤可选模型，并执行选中的可调用 ID |
| [trigger_service.ts](https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/58d51e3074def47513cb1de6338f76e95b3a638e/src/auto_trigger/trigger_service.ts#L432) | 从服务端 `models` map 取得 ID；`info.model` 是用于匹配的常量，不是请求 ID |
| [cloudcode_client.ts](https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/58d51e3074def47513cb1de6338f76e95b3a638e/src/shared/cloudcode_client.ts#L256) | 元数据路径为 `/v1internal:fetchAvailableModels`，可带 project |
| [cloudcode_base.ts](https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/58d51e3074def47513cb1de6338f76e95b3a638e/src/shared/cloudcode_base.ts#L5) | Daily 与 Production 是不同 Cloud Code 主机；普通请求使用同一服务层 |
| [trigger_service.ts](https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/58d51e3074def47513cb1de6338f76e95b3a638e/src/auto_trigger/trigger_service.ts#L554) | 普通文本 body，发送到 `streamGenerateContent?alt=sse` |
| [reactor.ts](https://github.com/jlcodes99/vscode-antigravity-cockpit/blob/58d51e3074def47513cb1de6338f76e95b3a638e/src/engine/reactor.ts#L1220) | 服务端 agent 列表位于 `agentModelSorts[].groups[].modelIds`；引用项目额外硬编码加入图片型号，本项目未复制该做法 |

Cockpit 为 MIT。此次仅核对协议与响应结构，独立实现，不复制其系统提示、缓存回退、自动 onboarding、硬编码模型或池推断；本项目 SUL 不变。

## 本次改动

- 中文显示“对话服务端点”“普通对话模型”“读取该账号普通模型”，选项显示 Cloud Code Daily（默认）／Cloud Code Production，并说明其用于普通对话。英文同步改为 Conversation service endpoint／Conversation model。沿用已有用户级手动语言设置。
- 通用元数据传输移到 `account-model-catalog.ts`，普通请求使用 `cloudcode-service.ts` 的固定主机。图片模块保留兼容入口和自身图片选择器；普通目录由独立 `wake-model-catalog.ts` 解析。
- 有 `agentModelSorts` 时只使用该服务端 agent 清单中的 map key，并排除显式图片生成 ID；无 agent 清单而有显式图片清单时兼容 map 中其余可用模型。保留普通多模态模型，**不把 supportsImages、输入 MIME 类型、显示名称或型号字符串当成图片生成角色**，不把 quota bucket 或枚举常量当成请求模型。
- root map 和 `{response: ...}` 均支持。若两份 models 同时出现，或分类清单格式错误，拒绝目录。两种分类清单都缺失时无法确认角色，显示明确提示并禁止保存／发送；这项保守行为可能阻止仅返回 models map 的旧服务端，需要后续读取真实目录评审兼容性，不伪称已获得官方保证。
- 目录仍绑定所选账号、端点、身份指纹和加密记录修订；每次实际发送前强制重新查目录。刷新失败不复用旧目录；账号／端点变化和重复读取退役旧请求，迟到的失败也不能覆盖新账号的结果与提示。未确认可用模型时禁用保存按钮。
- 原有凭据轮换和身份核对算法保持不变，共享层只增加可选 catalog 归一化，并在归一化之前对原始响应检查凭据回显。`account-quota.ts` 只将两个固定的目录错误码加入原有安全白名单；未知错误仍脱敏。总开关、新／编辑任务仍默认关闭。

## 验证与待验收

`npm run check`：1466 项，1462 通过、4 项原有平台跳过、0 失败；类型和 lint 通过。新增 18 项测试已纳入该命令，覆盖服务端字段形状、普通／图片分离、输入图片支持、未来型号、精确 map key、root／wrapper、未知角色、账号与端点分区、强制重查、图片满额不能代替普通模型额度、取消／账号替换迟到、原始 wrapper 凭据回显检查。fixture 为合成数据，不是实时 Google 响应录制。

`npm run test:automation-host`：隔离 VS Code 1.141.0 / Linux，生产 UI 与协议、合成账号及内存 HTTPS，32 项全部通过。包含中英文标签、键盘切换、260px 中英窄屏（245/245px 内容／滚动宽）、焦点／滚动、空和未知目录、迟到成功／失败、重复与取消、持久化账号模型、两端点文本发送及零图片生成调用。CI 增加此脚本为 Linux 门禁。收据与实际窗口截图位于 `.test-results/automation-ui-host`。

跨四页全局语言 10 项及完整扩展宿主烟测也通过。语言测试沿用新的禁用保存行为，通过目录分类失败验证已有提示重新翻译，并断言语言变化没有额外目录读取或模型发送。

真实账号目录的分类字段、Google 实际接受普通唤醒、额度变化／计费和 WSL 仍待本机隔离验收；未使用真实凭据试错。原 0.1.8 实机切号成功反馈缺口仍保留。候选保持草稿 PR，由父线程审查、用户决定后续，不合并或发布。
