# Hub 进程核验阻止切号：调查与回归方案

本文为修复授权前的调查记录；授权后的产品实现、审查和验证见 [候选验证记录](VALIDATION_HUB_RECOVERY_CANDIDATE.md)。下文“本轮只增加合成回归”等描述指最初调查阶段。

日期：2026-10-22。基线 `080f2cc11f6f43ff928c1f8025d5cfc670be4447`（0.1.17）；只读 `git ls-remote origin refs/heads/main` 确认当时远端 main 与检出一致，本地 origin/main 引用过期。本轮分支 `investigate/hub-process-verification`。只增加合成回归和本文，没有产品修复、发布、安装或真实账号操作。

已读 CONTRIBUTING.md、docs/README.md、COMPATIBILITY.md、ENVIRONMENTS.md 与相关源码/测试。根路径及项目没有可用 AGENTS.md；`/workspace/.agents` 为空，项目不存在 `.agents/skills`，没有可应用的本地技能文件。

后补现场证据（另一任务提供，本轮未独立读取）：Workbench 0.1.17；官方扩展 Windows/WSL 均为 **1.8.0，并非初始请求中的 1.9.0**；VS Code Server 1.143.0；Hub Server 2.25.0 / CLI 1.4.4。两类锁均不存在。有三个真实监听 Hub，另一个仍活着的扩展宿主，其 Hub 经 30000ms / 14 次启动探测超时后收到 SIGTERM 退出。截图窗口尚未与宿主对应，**不能认定超时窗口就是故障窗口，也没有证据确认该宿主残留 exports**。不将项目名、真实 PID/端口或现场原始日志纳入源码。下面优先核验实际 1.8.0；1.9.0 仅保留为未来兼容回归目标。

## 已证实的最小条件

`prepareBackendAction`（src/live-ui.ts）在以下条件同时成立时直接报 `OFFICIAL_HUB_PROCESS_UNVERIFIED`：

1. 官方扩展 active，导出合法 port / csrfToken，generation 不是 stopped。
2. 扫描返回已定义的 currentCount，却没有 current。

不需要其他进程，也不需要事务开始，更不需要 0.1.17 收尾失败。0、1、4 个 unknown 行均可复现。登录身份核验走 `resolveOfficialReadOnlyHub` 的限定 capability RPC，不要求进程独占，因此“登录已核验”与此错误并不矛盾。

扫描列表 `processes` 排除 current，剩余包含 other、detached、unknown。workbench-view 使用整个列表长度渲染 `officialProcess.count`，中文为“检测到 N 个其他后台”。四个 unknown 会被统计为四个“其他后台”，但没有任何一个被证明为其他窗口。没有 current 时也不能断言这些行都与当前 Hub 无关。

Windows `AgProcess.Scan` 捕获单行 Fixed 异常后，仅 environment 阶段保留 `environment-unreadable`，其余阶段和错误码均折叠为 `process-identity-unverified`。路径、架构、读取权限、参数、稳定性等失败因而无法从当前列表区分。`InspectOnly` 有固定 stage/code，但正常 scan 没有保留这些信息。

新增测试是现状复现/安全边界回归，不是修复通过证明，也不证明官方 1.9.0 兼容。

## 完整判定链

| 阶段 | 当前实现与判定 | 失败含义 |
| --- | --- | --- |
| 实际宿主 | native-host.ts + officialExtensionForHost；原生 URI、extensionKind、remoteName、覆盖配置 | Windows UI 打开 WSL 工作区不等于扩展跑在 WSL；同远程窗口不同 kind 拒绝 |
| 官方导出 | live-hub.ts：port 为 1–65535 整数，CSRF 为 16–128 个限定字符；二者生成 generation | active 不等于 Hub ready；有效导出也不是进程身份证明 |
| 扫描请求 | OfficialProcessRecovery 固定当前宿主 HOME 下 `.gemini/bin/agy[.exe]`；携带 ownerPid 和 capability；扫描前后检查 generation/扩展 | 不跨 Windows/WSL 查另一宿主的进程，也不以端口号单独认领 |
| Windows 身份 | 进程句柄、创建时间、用户 SID、映像路径；PEB 架构及参数块；原生 argv 解码；二次稳定性读取 | 任意核验失败保留阻断；目前缺少具体失败诊断 |
| Linux 身份 | `/proc` uid、exe、argv、birth 等；Python helper 额外核验 HOME/环境和参数；独立 TS 检查路径用于 lifecycle | 两套校验严格程度不同，应防止准备阶段与生命周期阶段判断分叉 |
| 当前 Hub | 官方映像/启动结构成立后，端口与 CSRF 同时匹配；不是直接 PPID 匹配 | 中间 launcher 合法；父子关系单独不能替代 capability |
| 凭据范围 | HOME、认证/配置环境覆盖、支持的启动参数 | 当前进程可识别但凭据范围未知时仍阻止写入 |
| 多后台 | 非 current 均阻断；scope 单独描述 current-window / other-window / detached / unknown | unowned 并不必然等于其他窗口，也可能是当前宿主的旧 Hub |
| 操作准备 | 当前 Hub 缺失优先抛上述错误；通过后才形成确认和锁内重验 | 截图错误发生在 stop / 写凭据 / restart 之前 |
| 停止与重启 | 已加载同宿主 CommonJS deactivate；等待进程退出两次且导出 port 清除；reconnect + panel.focus；稳定的新进程和 capability 后再做身份核验 | 命令存在/返回不证明重启成功；晚到 stop 不得与重试竞态 |

现有绑定包含 birth/命令证明，结束动作使用 held handle / pidfd，选择 ID 每次扫描失效。这里没有理由删除活锁、扩大结束对象或降低核验要求。

## 尚待现场证据的候选原因

| 候选 | 能否解释当前错误 | 判别所需最小证据 |
| --- | --- | --- |
| Windows PEB/架构/读取权限或路径匹配失败 | 能，扫描会得到 unknown 且没有 current | 每行固定 stage/code；系统/进程架构；路径相等布尔值；不要原始环境/argv |
| 导出已更新但进程仍在启动，或导出仍指向旧 Hub | 能，零匹配；扫描期间变 generation 则应为 HUB_CHANGED | 同一扫描前后 generation 是否一致、进程 birth 是否稳定、capability 是否匹配；时间序列 |
| 官方 1.9.0 启动路径、必要 argv 或导出能力变更 | 可能；当前没有 1.9.0 合约夹具或源码证据 | 现场固定版本入口摘要及只读启动合约结果，脱敏成合成 fixture 后验证 |
| 多窗口、脱离宿主的旧 Hub、同窗重启遗留 | 可能是真阻断，也可能与上述失败同时存在 | 当前 Hub 必须先匹配；其他行身份/凭据范围/ancestry 独立核验，parent gone 不能证明无任务 |
| Windows 与 WSL 跨宿主 | 可能，但已知 kind 不同通常先报 OFFICIAL_HOST_MISMATCH | 两扩展实际 kind/platform、远程类型、当前发行版身份；不能只看窗口标题 |
| 新增普通参数或配置环境 | 若保留原 Hub 形状，Windows 通常仍有 current，只是 credentialScopeVerified=false，倾向 OWNERSHIP_UNVERIFIED；不能一概归因于此 | 区分必要 Hub 参数不匹配、额外参数和环境范围失败 |
| deactivate / reconnect 生命周期改变 | 可能影响后续切换，但不是此次准备阶段错误的直接证据 | 已加载模块是否有 stop、调用是否只停止 Hub、导出清除时序、命令实际行为；隔离无账号验证 |

实际 1.8.0（以及后续 1.9.0）核验要检查模块导出是否仍可从已加载 CommonJS cache 取到、deactivate 是否还保留 reconnect 所需资源，以及 focus 是否能重新启动。若改为 ESM、销毁所有注册、保留过期 exports 或改变启动入口，必须明确报兼容能力不足并设计版本合约适配，不能再次 activate、私自 require 官方模块或让用户反复重载试错。现有测试中官方启动语义主要有 1.7.0 合成形状，不能外推。

## 启动失败、stale exports 与无法靠等待恢复

已证实的代码机制：generation 由 port/CSRF 和已观测重启 epoch 得出，不包含进程存活。只要 exports 保留合法旧值，`currentGeneration()` 就不会变成 stopped。`OfficialProcessRecovery.scan()` 在此情况下要求存在经过凭据范围核验的 current 才允许继续；即使列表已为零，也持续 blocked。新增平台回归复现“3 个非当前 Hub → 全部消失 → 重扫三次仍阻断 → 导出清除才成为 clear”。这证明杀掉其他后台不能解决 stale exports，亦不构成这样操作的建议。

UI 的 `officialAvailability` 只检查能力形状/已加载 stop hook，合法 stale exports 可能仍显示后台已启动。`processScan` 仅重新扫描；`processContinue` 在 canContinue=false 时返回。二者均不触发 Hub 启动或清理官方 exports。官方扩展已经 active 时，身份刷新也不会再 activate。身份重试有 12 次 / 90 秒上限；普通重新检查重置预算但仍是同一 capability 查询，不能修复官方启动状态。因此这是可能的“重复检查却无法恢复”路径，不是代码中无限等待同一个 Promise 的已证实结论。

另一个已证实的诊断缺口：`officialProbe` 每 5 秒做只读 Hub RPC；catch 只对 AUTH_INVALID / EMAIL_MISSING / CHANGED_DURING_QUERY / HUB_NOT_READY / API_UNAVAILABLE 触发 `requestOfficialRefresh`，**不包括 HUB_RPC_FAILED / HUB_RPC_TIMEOUT**。若合法旧 exports 指向退出的 Hub，连接失败不会由这条定期探测路径清除旧 activeEmail/activeVerifiedAt；直到显式或其他事件触发的 refreshIdentity 失败才清除。不能因此声称所有 UI 刷新均保留旧身份，但这足以要求“先成功核验→进程退出→exports 未变→仅定时 RPC 失败”的独立回归。建议失败时将当前身份降为历史/不可确认，以有限预算刷新，保持失败诊断可见而不自动启动或延长预算。

`pending` 属于账号 journal / recovery 的状态，不等于“官方 Hub 正在启动”。补充 UI 回归在登录先前已核验、无 journal、旧 exports + 三个 peer Hub 的条件下重复 scan/continue，确认 pending=false、busy=false、无停止/写凭据/创建恢复。现场两类锁不存在仍不足以证明 journal 不存在，但当前错误路径无需锁或 journal；不可通过删除锁、清 pending 缓存、清 journal 修复。

需要窗口关联后只读确认：同一宿主是否仍导出合法 API（只保留 present/valid 布尔值与一致性结果，不输出 capability）、当前进程匹配数、已知启动超时事件、listener 是否仍在同一进程 birth，以及模块 stop/reconnect 能力状态。窗口对应和 stale exports 均未证实时，不应标记为 confirmed-start-failed。

相应修复应把 `advertised`、`process-verified`、`rpc-ready`、`startup-failed` 分开；检测稳定缺失并用已知启动失败证据结束“正在等待”文案，给固定原因。只在经过官方 1.8.0 合约验证的恢复入口下设计显式、单次、有界的重试启动；保持同宿主、所有 peer 阻断、锁、generation/birth 重验和 stop 迟到守卫。不得直接写第三方 exports，或因 missing current 允许凭据变更。本轮只准备方案，不调用该恢复入口。

## 修复方案（待证据后实施）

1. **先补可区分的核验结果**：Windows scan 保留有限枚举 proofStage / proofFailure；区分 inaccessible、unsupported-architecture、image-mismatch、argv-invalid、proof-changed 等。Linux 同步枚举。不要返回 raw argv、CSRF、环境值、SID、完整路径或未知异常正文。逐进程验证失败与全扫描不可用分开。
2. **将 currentProof、credentialProof、conflicts 分开**：当前 Hub 状态为 verified / not-observed / invalid / changing；列表分别统计已核验非当前后台与未核验进程；other-window 只能由对应 scope 证据说明。真实独占冲突至少需要当前 Hub 的稳定匹配与另一个经过身份/凭据范围核验的活后台；不能从 N 个 agy 推断 N 个窗口，更不能推断任务空闲。未核验项继续阻断，但提供真实原因，不提示关闭其他窗口。
3. **统一准备和生命周期检查**：复用同一个带宿主、extension identity、generation、process birth、credential scope 的快照模型；减少 TS proc 与 Python/Windows helper 的判断差异。每个 await 后保留 generation/身份重验，结束选择继续失效机制。
4. **仅对可证实的启动过渡做有界只读稳定重采样**：不重启组件、不操作凭据、不自动结束后台。稳定 generation 下仍不匹配应报告具体失败，不无限建议“等待”。有任何 generation/birth 变化废弃旧选择、停止后续写操作。
5. **根据实际合约修复具体兼容点**：如需支持新的官方参数/路径/生命周期，仅为有来源的合约加入精确校验；路径不能改成名称匹配、端口不能替代 capability、未知 flags/认证覆盖不能整体放行。修复后走隔离宿主回归，无本轮发布授权。

## 重开恢复后：结束后台的边界与风险

后补用户反馈：重开后当前已可用。故障现场已变化，仍保留上述根因调查；恢复不是 stale exports 假设的确认。用户仅询问强制关闭的后果，没有授权结束任何进程。本轮没有执行结束操作。

**会发生什么**：结束的是 agy 后台，不是设计为关闭 VS Code 窗口。依赖该后台的对话、生成或代理任务可能中断，尚未保存的结果可能丢失；已执行的文件写入或远端请求不会因杀进程自动撤销。强制退出不能保证官方会话/数据库完成收尾，不能承诺结果完整或一定可恢复，也不能承诺自动重启。它不是清理账号凭据或解锁操作，更不是修复“找不到当前 Hub”的通用办法。以上是进程终止语义与现有警告的风险范围，不是本轮已观察到的数据损坏。

| 保护项 | 源码结论 |
| --- | --- |
| 精确目标 | UI 仅提交一次性 opaque selection ID；宿主保留 PID、birth、command proof；每次 scan 使旧选择失效，不能任意传入 PID |
| Linux/WSL | 仅同用户、官方 executable/Hub 参数、凭据范围 verified 的 unowned-hub 可结束；pidfd 跨阶段持有；复核 PID/birth/boot/PPID/hash/scope；先 SIGTERM，4 秒未退出再 SIGKILL，再等最多 4 秒 |
| Windows | 同 SID、映像、PEB 启动参数/环境、birth/hash 复核；持有句柄，直接 TerminateProcess，等待最多 4 秒；没有正常退出阶段 |
| generation 与竞态 | endMany 每项和信号握手前重验扩展/generation/选择 revision；取消或宿主失联不授权下一阶段；批处理中首次失败停止，已结束项无法撤销 |
| 当前 Hub 排除 | helpers 仅 eligible(unowned-hub + credentialScopeVerified)；与当前 capability 匹配的 current 不可由该入口结束 |
| 工程归属 | Linux 仅从显式 --add-dir 提取有限 basename，可缺失、重名、多根；不表示准确窗口标题。Windows helper 当前不产生 projects，不能承诺显示工程名。scope 的祖先链和 capability 独立判断；scope unknown 仍可能有已核验凭据范围 |
| 用户警告 | 原生 modal 列 PID/启动时间与范围，明确任务未知、未保存结果风险；Windows 明示直接强杀，Linux 明示 4 秒升级；跨窗口/unknown scope 另提示会中断其他窗口任务 |

**需要改进的确定问题**：`endProcesses` 本身未要求 current 存在。若 current 缺失，但若干 peer 行满足 canEnd，用户仍可选这些精确 peer 结束；它没有绕过之后切号的 canContinue 检查，却可能在无法修复本窗口的情况下中断正常后台。其通用确认文案还声称“完成操作后恢复本窗口后台并自动核验新身份”，实际 standalone end 或 missing-current 分支不保证这一行为。文末“其他窗口的活跃后台不会自动结束”也不能抵消前文对确认目标的风险，需要明确“只结束你确认的列表，不追加目标”。这不是 PID 任意杀进程漏洞，而是恢复入口语义与前提不足。

建议明确分成两个入口：

1. **结束所选后台（独立破坏性操作）**：只有目标身份/凭据范围已核验且绑定仍有效，展示具体 PID/启动时间、可获得的工程关联和未知项，并明确不可恢复风险后，才可以请求用户逐项/明确列表确认。不能标为“修复当前窗口”或承诺恢复/切号。未知身份目标不可提供结束按钮；不能根据旧截图预选全部。
2. **结束冲突并切号（恢复操作）**：还必须先验证当前 Hub 的完整稳定身份、当前扩展/宿主、停止/重启合约及锁/journal 状态，再展示当前与确证冲突对象。确认后锁内再次扫描与绑定重验；任何未知项、当前 Hub 缺失或 generation/birth 变化都中止，不结束 peer。生命周期失败应保留恢复证据，绝不放宽凭据变更条件。

在当前用户已经恢复可用、没有新授权的情况下，只解释风险并继续回归，不建议通过强关制造现场。新增待覆盖回归：missing-current + eligible peer 禁止“结束并切号”动作且 helper end 调用为零；独立 end 文案不承诺重启；取消零信号；批次目标不扩展；同名工程不冒充准确窗口；Windows 工程未知显式显示；扫描和确认后 PID reuse/current adoption/extension replacement 保持拒绝。

## 回归覆盖

本轮新增 8 项：UI 三项（0/1/4 unknown + 登录已核验 + 没有 current），Windows/Linux 恢复层各一项（四个 unknown），UI 一项（三个 peer + stale exports 重扫/继续），Windows/Linux 各一项（stale exports 下零进程仍阻断）。UI 使用真实 LiveSwitchService 和命令实现；准备失败断言无操作锁，所有新增场景均无停止、凭据写入、恢复开始或重启；恢复层断言 unknown 不可结束、无 helper end 调用。

后续修复验收矩阵：

- Windows 原生 UI、Windows UI + WSL 工作区、同 WSL workspace、两扩展跨宿主、两发行版；必须使用实际宿主而不是 remoteName 单独推断。
- Windows x64/ARM64、架构不支持、OpenProcess 拒绝、PEB 读取/环境读取失败、路径别名/大小写、合法/重复/缺失/分隔参数；使用仅测试创建的惰性进程，验证 scan 结果而非仅 InspectOnly。
- 单窗唯一 current；当前 + 1/4 个真实其他 Hub；同窗旧 Hub；脱离父进程；未知进程；重复 capability；当前身份失败与真实其他 Hub 同时存在；所有组合都不误报窗口数量。
- 导出先于进程、进程先于导出、旧导出、原地修改/替换 exports、扫描期间重启、PID reuse、组件版本/路径替换；确认后再变化必须拒绝旧选择。
- 实际 1.8.0 和后续 1.9.0 分别建立脱敏合约夹具：launch/exports/stop/reconnect/focus；启动超时后进程退出但 exports 未清、hook 早返回、迟到 resolve/reject、导出不清除、进程不退出、同 capability 新 birth；停止失败不得写凭据/重启。
- 保留 live-lock、journal 持久收尾、迟到读回、共享图片守卫、账号 B 的新鲜身份验证；真实冲突仍阻断，unknown 永远不能因为“修复可用性”变成放行。
- UI 展示 proof stage 和分类数量；unknown 不能叫“其他窗口”；重采样只读有界；日志/网页状态不出现 secret、argv、原始环境、私有路径。

复现命令（已有依赖，无需安装）：

```sh
npm run compile
node --require ./test/helpers/offline-only.cjs --test test/backend-operation-ui.test.cjs test/official-process-recovery.test.cjs test/official-process.test.cjs test/official-process-helper.test.cjs test/official-restart.test.cjs test/bounded-official-stop.test.cjs test/native-host.test.cjs
```

首轮七文件回归 174 项：172 通过、2 个 Windows 原生测试跳过；后补 stale exports 三项后，两修改文件共 76 项：74 通过、2 跳过。编译通过。Linux 上 Windows 原生测试会跳过，mock Windows 分支不能证明 PEB 在现场 Windows 成功。尚待截图窗口与现场宿主的对应、官方 1.8.0 启动失败导出合约证据；本轮未读取真实凭据、未调用官方生命周期、未结束真实后台。
