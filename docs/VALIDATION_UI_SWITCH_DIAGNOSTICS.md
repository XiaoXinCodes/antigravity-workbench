# 切换失败诊断与账号优先布局（2026-10-22）

本轮不安装、不发布，不生成新的可安装候选。现场底层切换失败原因仍未定位。

## 已证实与未证实

父线程现场只读报告：当前134模块匹配reopen-fix，三个活宿主14:41启动晚于更新；失败记录为14:46:02.119Z / switch / command / none / UNCLASSIFIED_ERROR。未发现恢复键、操作锁、恢复锁、离线事务目录或helper，没有证据进入凭据写入。旧诊断已丢弃原始触发码，不能认定三个正常后台就是根因。

本地复现：新增OFFLINE及COMPONENT固定错误码遗漏于安全枚举，导致已知错误也被压成UNCLASSIFIED_ERROR。现已补齐固定枚举，不允许任意错误文本。helper的就绪失败原先合并spawn、提前退出、超时与协议错误，且前置检查失败无失败ACK；现在使用有界固定码ACK，不读取或转发stderr，并等待close排空数据，覆盖exit先于ERROR数据交错。ACK超时仍保留事务/锁，未据超时推断写者死亡。

准备阶段现在通过固定标签定位程序分支：route、args、confirm、lock、contract、scope、census、prepare、helper。标签由offline-ui.prepare中的代码发出，helper对应offline-automatic.launchAutomaticOfflineHelper；不捕获原始堆栈/路径/参数/环境值。持久lastFailure保存安全码和阶段，调试事件保留switchStage。原始旧错误不能由新增诊断追溯恢复。

合成回归复现了census不完整、unknown证据和scope guard失败；三者均在journal、marker和helper创建前拒绝。它们是可能条件的回归，不是现场原因证明。

## 真实UI渲染

实际VS Code 1.141.0/Xvfb、生产WorkbenchView、四个虚构账号、三个虚构后台、长错误文本；无官方扩展、真实账号或RPC。240/440/680px侧栏截图及DOM测量见evidence。旧process-conflict-list展开状态仍存在时，新backend-diagnostics父层默认折叠，不沿用旧展开状态。账号列表在诊断之前，无逐个/批量结束后台按钮，无横向溢出。单账号切换操作位于额度详情之前。筛选/排序/批量工具可折叠。

渲染直接注入产品的error字段而不是仅warning；真实适配器错误会变为可见错误卡，登录身份核验不再呈现无范围说明的绿态。错误卡有重新检查入口；pending时保留核验与恢复操作。

用户原截图Library libfile_407fc7fc9d1c8191a1e477bac1e6836f已解析；受支持materialize helper两次返回download failed，未成功下载像素。Library image_file读取只返回元数据、caption/OCR和asset pointer。不能声称已查看用户原图像素；本包截图为本地实际渲染的合成状态。

## 只读本机预检（由父线程安排，不自动运行）

文件：scripts/read-only-switch-preflight.cjs。使用已核验候选的out模块；将脚本放于其scripts目录（可解压VSIX，不安装），在同一WSL用户会话执行：

    node scripts/read-only-switch-preflight.cjs <已核验的当前扩展宿主PID>

PID来自已有只读现场记录，执行前确认仍是本窗口宿主，不填Hub PID。脚本不启动子进程、不发终止信号、不写文件、不读token文件内容、不调用官方exports/RPC、不读恢复密钥。存活探测使用signal 0；生产census读取/proc中的cmdline/environ，临时字节可能含敏感值但不打印、不落盘、不导出；输出只有固定代码、布尔与计数。若不允许这种进程元数据读取，不运行脚本，报告缺失证据。

CENSUS_PASSED_ONLY只表示这次只读扫描完整，不证明事务期间独占或可写；scopeProof始终NOT_CHECKED_REQUIRES_LIVE_HUB。路径仅lstat元数据；不能替代准备入口的实时Hub归属与登录存储绑定。脚本仅用注入合成I/O验证，尚未在用户机器执行。

## 入口审查

WSL官方1.9普通switch进入自动关窗准备，不进入1.8组件停止。login仍走原在线流程；无offline fence的verify/restore进入组件恢复，schema4使用专用offline操作。旧processContinue在WSL拒绝，已从正常界面移除，不借简化UI放松凭据保护。官方1.9在线暂停合约限制仍在，本轮未改写切号架构。

## 验收边界

代码/合成回归与真实UI渲染通过不等于现场切号成功。当前仅交付UI和诊断纠偏证据，原失败原因、实际官方RPC及Windows/WSL真实关窗存活仍未验收。不要把本包当可发布或已根治切号的证明。
