# Hub恢复与在线切号：候选验证记录

2026-10-22。基线main `080f2cc11f6f43ff928c1f8025d5cfc670be4447`；分支 `investigate/hub-process-verification`。未发布、安装、操作真实账号或结束用户进程。

**未完成、不可交付：v2全禁用不是修复；当前工作树已将 WSL switch 接到关闭后外部终端切换，仍待真实平台验收；Windows 原生与其他在线入口不能据此宣称消除下述跨宿主风险。不得试装或发布。**

## 事实、现场与证据

现场官方为1.8.0、Workbench0.1.17；有一个宿主启动超时，但截图窗口未与该宿主对应。用户重开恢复不证明根因。Workbench过期登录核验、unknown误计peer、缺失current无法恢复的问题均有代码及合成回归。

官方全文摘录通过Library读取：`libfile_9d4247a68614819191b479457ee11217`（30262 bytes、127/127行）；1.9恢复与心跳 `libfile_f7277e362f1881918a9ba0d12df76046`（16914 bytes、38/38行）。未执行官方代码。原VSIX ZIP无法在本消费环境下载，未重新核算原包哈希；以下源码哈希由提供方从原包核验，运行时准入会比对已安装源码：

- 1.8.0 extension.js：`09de6ab0d4431872ad6a6293e33315a15359a1b7fe2b6af7c0cb14294afc8ec9`
- 1.9.0 extension.js：`f77a37c4bd66612f4ed26d9e80ce3969af543f853e2cc113ca466e7f8b6aa880`

## 更正v2的过宽结论

旧反例从pre-spawn或missing-current状态开始：1.8 stop不等待startingPromise；1.9在途restart可跨过第二次stop。它们证明空扫描不足以写入，**不证明正常ready路径不安全**。

两版start在发布serverUrl/port后到finally清startingPromise没有await。外部任务观察真实ready current时，该次pre-spawn启动已结束。普通桌面setup同步进入manager.start；失败后的retry需要用户操作，不能当作无用户操作的后台启动反例。

1.9残余旧restart可能还在await旧stop。该stop同步注册5000ms的实际Promise完成定时器。首次ready观测后在**同一扩展宿主**注册相同延迟5000ms定时器，旧timer及其Promise continuation先执行；若还是同一ready current，start同步复用它。若等待期间自动恢复停止current，它同步清引用；该进程不能被start重新认领，末次动态exports、fresh RPC与PID/birth核验将拒绝。不能用墙钟轮询或任意固定等待替代这项源码与事件循环条件证明。

最后同步代际检查到loaded stop调用不增加异步任务。stop取消未触发的recovery timer，设置isStopping并推进heartbeat/stop代际，停止后仍等待实际退出及零相关Hub。

## 在线准入与恢复行为

- 1.8普通ready路径直接准入；1.9默认配置可用，首次准入增加约5秒可取消核验。不自动修改官方配置。
- 精确版本与源码哈希共同限定合约；排除未审查实现、CDE/远程认证覆盖和身份不完整的状态。当前进程必须有fresh RPC、动态exports及PID/birth证据；Windows/Linux适配器执行原有身份检查，macOS没有相同完整进程证据，不据此声称支持。
- 许可绑定生命周期与当前birth；只有该生命周期完成自己的stop才获得已停止写入许可。新建空状态resolver不能继承。reload清许可，重复准入仍核验原身份。
- 安装、隐式失败回滚、备份恢复的三个实际写入点保留准入检查；prepareLogin/completeLogin/install/restore在副作用前检查。跨窗口锁、journal、比较写入和回滚保护保留。
- 确认提示要求操作完成前不要在官方面板重连、retry或改配置。这不是阻止同用户其他扩展主动调用重连、恶意篡改或任意外部启动的系统级锁；它覆盖已审查官方正常生命周期的自然并发。
- missing-current先恢复组件，不能把其空扫描直接当写入许可。已有journal且后台已停：保留备份，打开官方面板使用启动重试，ready后回工作台继续核验/恢复；不让用户删除journal或活锁。恢复状态可支持已有的精确目标核验恢复入口。
- RPC失败/exports失效撤销旧登录核验；unknown与真实peer分开计数。
- “重启当前后台”需任务中断确认，重验PID/birth/代际，只调用已加载本宿主deactivate；已验证正常peers可共存。reconnect刷新已resolved view，focus只在需要时resolve，不能把命令返回视作启动成功。
- 组件恢复超时或结束等待不释放仍在途操作的互斥，重复点击只观察同一次启动。恢复不写凭据、不自动切号。

## 回归与审查

新增真实合约模型覆盖：旧stop exit/timeout两条路径；pre-spawn空扫描反例；ready同步清startingPromise；1.9旧停止链排空；同端口新birth拒绝；取消及最终RPC中取消；真实相同延迟5000ms timer与事件循环阻塞5300ms导致两timer同时到期的顺序。无真实账号、进程或官方扩展执行。

此前组件恢复28/28独立通过；在线首轮针对性集成204/204通过。最终完整检查、宿主smoke和候选信息在结束后更新。

独立审查纠正v2泛化错误，复核有界旧stop排空的条件证明及许可缓存/自身stop/三处写入；发现的末端取消问题已修复。未将模拟通过当作Windows/真实WSL多窗口实测。

## 原26项环境失败

相同Node24、依赖、TMPDIR下，原main与早期候选的26个失败名称逐项一致（debug-log-store25项、image journal1项）。沙箱将根目录映射为UID65534；仅换TMPDIR无法绕过祖先校验。正常文件系统、项目规定umask022下，原main1751通过、0失败、4跳过。最终检查串行运行，未放宽产品权限规则或断言。清单和日志在 `.test-results/hub-recovery-validation/`。

## 平台及后续边界

云Linux x64、Node22.23.3与隔离VS Code1.141.0/Xvfb可测；真实Windows、WSL1.143.0及官方1.8/1.9多窗口仍需用户另行批准试装验收。没有发布、安装或真实账号授权。

当前在线方案不要求停止编辑器宿主或部署独立凭据执行器。若后续不受支持的官方实现无法满足该时序证明，离线方案需另行确认关闭哪些共享凭据窗口/宿主、全部扩展任务中断、独立执行器的凭据交接及崩溃恢复，不能默认杀进程或将它宣称已实现。

Node公共API不承诺timer回调排序，因此本准入依赖已核对的Node20/22/24实现，其他系列拒绝1.9写入准入。源码把相同delay放入FIFO链表，并在回调之间处理Promise微任务。不同delay的列表可能批处理越序，已用真实5100/5000混合timer反例验证；屏障必须使用与官方完全相同的5000ms delay。
实现来源：[Node20 timers](https://raw.githubusercontent.com/nodejs/node/v20.19.5/lib/internal/timers.js)、[Node22 timers](https://raw.githubusercontent.com/nodejs/node/v22.23.0/lib/internal/timers.js)、[Node24 timers](https://raw.githubusercontent.com/nodejs/node/v24.10.0/lib/internal/timers.js)。[公共API边界](https://nodejs.org/api/timers.html)。

## 收尾发现：跨宿主自然自动恢复仍未解决

当前宿主same-delay FIFO准入只能排空当前宿主。现有consumePreparedBackend/endMany直接结束other-window Hub后，其宿主仍存活，官方manager的isStopping未设置；1.9可因exit进入scheduleRecovery，在本窗口扫描为空后启动新Hub，甚至与凭据写入交错。不能把自己的静默证明推广到其他宿主。新模型明确展示本地准入通过仍可有peer重生。

在增加该模型前，最新完整检查1840项1836通过、0失败、4跳过；宿主smoke和Python47项通过。它们不覆盖或消除上述风险。当前没有构建/上传新候选，Library仍为不可交付v2。

此前提出两条路线，用户现已明确选择第 2 条合作暂停：

1. 切号前要求用户关闭相关共享凭据窗口/宿主，并验证准确宿主退出；保留本窗口，组件恢复仍可与其他窗口共存。需要补宿主birth证据、无Hub但有待启动宿主的检测，不能只检查agy为空。
2. 新增跨窗口合作暂停协议：每个相应Workbench在自己的宿主执行官方stop和准入，回报绑定宿主/进程代际的静默状态；协调者在凭据事务内持有所有参与者租约，再按结果恢复。旧版或无Workbench的窗口不能握手，须关闭。握手超时、宿主消失、租约丢失均需阻止写入并保留备份。不能用原始kill模拟协作停止。

两条路线均未执行用户环境操作；后一条还需明确所有相关窗口的任务中断及后台恢复策略。产品选择已明确；继续核实发现现有官方公开接口缺少持续暂停及新实例启动准入，不能用 stop ACK 或租约替代。协议、故障矩阵与可执行反例见 [跨窗口暂停设计](COOPERATIVE_PAUSE_PROTOCOL.md)。这属于合约能力阻断，不是等待用户重复确认选择；不能以当前测试全绿宣告完成。

## 整宿主控制研究

用户随后授权可行性研究。结论、公开接口证据和隔离原型见 [整宿主控制评估](HOST_CONTROL_FEASIBILITY.md)。独立执行器部件验证通过不代表多窗口启动范围封闭；未扩展产品实现、未构建新候选。

## 最新路线：关闭后离线切换

用户已允许关闭相关窗口，并批准继续代码与隔离验证。当前最小路线及实现状态见 [关闭后切换进度](OFFLINE_SWITCH_IMPLEMENTATION.md)。不再要求保留窗口的全局暂停；不新开/不重连是明确操作约束，扫描只是发现冲突。当前仍未接线完成，不构建交付包。

## 2026-10-22 产品接线增量

参见 [关闭后切号实现](OFFLINE_SWITCH_IMPLEMENTATION.md)。普通 WSL switch 在旧后台处理前进入 offlinePrepare；独立终端使用已加密记录和 schema4 标记，5分钟关闭等待、实际文件适配及保留恢复已接通。通过 fresh 身份与 refresh 凭据核验后完成；restore也必须验收原身份。不自动关窗、不结束用户进程、不猜测重开客户端。

新增独立审查修复：access-token刷新卡死、restore提前退保护，以及删除当前账号的replacement在拒绝WSL前可能先取消任务/结束peer。完整增量测试和宿主结果以最后运行日志为准。没有实际安装或账号验收；旧 Library v2 仍不可交付。

### 最终检查与审阅产物（07:26 UTC）

- `npm run check`：1906 项，1902 通过、0 失败、4 跳过。Node22.23.3，正常 UID 映射；日志 `/tmp/offline-wired-reviewed-check.txt`。
- Xvfb + VS Code 1.141.0 隔离宿主：激活、全部命令（包含3个offline命令）、空闲操作、刷新、指南与语言持久化通过，退出0。日志 `/tmp/offline-wired-reviewed-host.txt`。
- 审查后密封 execution + originalEmail 接管补验5/5；UI/access刷新/恢复原身份/取消等对应回归通过。
- Python license8 + release-safety34 + package-docs5 = 47通过；`git diff --check`通过。
- `npm run package`、verify-release、verify-marketplace-vsix离线校验通过；没有上传Marketplace、安装或发布。
- 独立审查最终确认本轮指出的P1已修复，结论不覆盖未做的真实平台验收。

仅供审阅、不得试装：`antigravity-workbench-0.1.17-wsl-offline-review-no-install.vsix`，5062028 bytes，SHA256 `ae5d7e914e3a65a6b6c1f0ef55015548537bfa6df4f05da2aad806b971ef6173`。
Library ID `libfile_6f4af2264d8c81919f939ec855edd7e5`，version0。旧v2仍不可交付；这个新文件不代表获得试装/发布批准，也不代表Windows原生流程完成。

### 2026-10-22 08:05 UTC 试装前恢复出口完成（取代此前no-install结论）

新增kept-current安全退出，允许自有schema4期间组件恢复；详见OFFLINE_SWITCH_IMPLEMENTATION。原review-no-install包不要试装。
最终检查1913 total/1909 pass/0 fail/4 skip，Node22.23.3/umask022；Xvfb VSCode1.141.0宿主通过四个offline命令；Python47及VSIX两类离线校验通过。独立审查的取消误报成功已修复，复审未发现新增出口/组件恢复的已知P1。日志/tmp/keep-final-check.txt、/tmp/keep-final-host.txt。
新候选antigravity-workbench-0.1.17-wsl-offline-trial-v3.vsix，5063243 bytes，SHA256 21c73751acb5ef74f0c8a81700cc4c0ee1d94a369d6f0e83f5d199addfa79c0c。仅允许用户批准的WSL文件路线试装，不覆盖原生Windows/其他在线写入。密码丢失或无法获得当前身份仍无法安全退保护；必须保留材料，不手工清锁。候选内部版本仍0.1.17，须核对哈希。未执行任何安装/发布/真实账号动作。
首次本轮默认环境Node24/umask077造成一个已有日志权限测试失败；恢复既定工具环境及umask022后全量通过。工具不在默认PATH的Xvfb已从此前准备目录找到并成功验证，无产品权限放宽。
