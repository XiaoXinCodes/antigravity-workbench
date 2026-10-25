# 整个扩展宿主控制：可行性评估

2026-10-22。仅研究和隔离合成验证，未修改产品运行路径，未操作用户进程、账号、配置，未安装/发布。保留此前修复工作；旧 v2 与当前工作树均非可交付候选。

## 结论

| 方案 | 结论 | 已有证据与缺口 |
| --- | --- | --- |
| 公开 VS Code API/CLI 保留窗口、暂停全部相关宿主并锁住新启动 | 当前已核对接口不足以实现 | 重启命令立即重启；没有取得可持有的全局暂停/启动 fence |
| 仅杀死或冻结已知宿主 PID | 不满足要求 | 监督进程会重建；Hub 子进程不因父宿主暂停自动暂停；新窗口不在旧 PID 集合中 |
| 独立执行器在原宿主退出/暂停后执行事务 | 部件可行 | Linux 合成进程实测通过；不能推导真实 VS Code 范围封闭、Windows 或 WSL 验证通过 |
| 从启动时纳入封闭控制范围的监督进程、宿主和后台 | 条件可行，尚非产品方案 | 必须包括所有创建者并隔离范围外的共享凭据访问；现有窗口不能靠扫描证明已纳入 |
| 用户保存并关闭所有相关窗口，期间不新开、不重连 | 有操作前提的离线路线 | 仍须确认监督者不自动重建、相关 Hub 退出；禁止新开是用户承诺，不能伪称技术强制保证 |

因此本轮不建议直接开始跨平台产品实现。能成立的部件是独立执行器；决定成败的缺口仍是**控制范围完整性和启动准入**。

## VS Code 与 WSL 合约

缓存 VS Code 1.141.0 的 product commit 为 `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`。读取对应官方源码，并对照本地编译产物确认 `workbench.action.restartExtensionHost` 是 stop 成功后直接 start，没有等待外部写入的阶段。同一源码存在本地与远程宿主异常退出后的自动重启。内部 `IExtensionService` 不是扩展可持有的公开暂停 API。

来源：[固定版本 nativeExtensionService](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts)、[固定版本 abstractExtensionService](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/services/extensions/common/abstractExtensionService.ts)。现场 1.143.0 未做运行验证；不能将 1.141.0 结果冒充现场精确版本实测。

公开 CLI 提供禁用扩展启动及独立 user-data/extensions 目录，没有文档化的跨窗口持久暂停令牌。独立 user-data-dir 不等于官方账号文件隔离：不能假定改变编辑器目录就改变官方凭据位置。[CLI 文档](https://code.visualstudio.com/docs/configure/command-line)

一个编辑器配置可同时含本地、web、remote 宿主。WSL 不能仅检查 Linux agy，也不能把 Windows PID 当作 Linux PID。应按真实凭据文件范围分别协调；不同范围不必无谓联动，但路径映射、环境覆盖、共享挂载无法证明时必须拒绝操作。[宿主架构](https://code.visualstudio.com/api/advanced-topics/extension-host)

`wsl --terminate` 终止整个发行版，`wsl --shutdown` 终止所有运行发行版及 WSL2 VM；它们不是单宿主暂停接口，不适合作为默认恢复动作，也没有本轮执行。[WSL 命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

## 进程控制能做什么

Linux cgroup v2 可以冻结所属进程和后代 cgroup，并通过 frozen 状态确认完成；移动父进程不会自动搬迁已存在的后代，范围外进程不受它控制。需要从创建链路纳管且防止逃逸/旁路，不能把多轮扫描当成封闭证明。本轮未设置 cgroup 或安全配置。[内核合约](https://docs.kernel.org/admin-guide/cgroup-v2.html)

Windows Job Object 支持进程组管理和通常的子进程继承，但存在 breakaway 等边界。文档不提供“任意现有 VS Code 所有后代原子暂停并禁止所有新实例”的保证。不能用未验证的线程枚举/SuspendThread 或私有 Nt 接口补写成受支持方案。本轮无 Windows 原生执行验证。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

冻结旧 Hub 还保留旧账号内存，直接恢复它不能证明新账号已加载。若宿主/Hub 已退出，恢复也必须使用新的启动身份，旧 PID/ACK 作废。仅限制用户不新开窗口不能排除现有监督进程自动重建。

## 独立执行器最小原型

运行 `node --test test/host-control-feasibility.test.cjs`，本轮 Linux 上 5/5 通过：

1. 合成发起宿主退出后，其 detached/unref 且无继承 stdio 的执行器继续写入合成标记。
2. 将本测试创建的合成宿主 SIGSTOP，读取内核状态确认停止；独立执行器继续工作；随后恢复并清理该合成进程。
3. 写入后注入合成核验异常，经 catch 恢复旧标记后才标记完成；未模拟真实磁盘 I/O 故障。
4. 执行器在替换后退出，另一恢复进程读取保留 journal 并恢复旧标记。
5. 使用 Map 状态模型展示已知宿主均停止不妨碍监督者替代实例或新窗口启动；此项不是实际进程重建实验。

存活机制符合 [Node detached 合约](https://nodejs.org/api/child_process.html#optionsdetached)。测试只有临时目录内的 synthetic-old/new 标记，不读真实凭据。文件轮询仅同步测试事件，不用于证明进程独占。原型无生产级权限检查、fsync、账户加密或多文件原子事务，**不证明断电安全**；不得复用为产品凭据执行器。Windows console/job 生命周期、WSL 发行版退出和 VS Code 的子进程清理策略仍未运行验证。

## 最小后续路线及验收门槛

若继续研究保留窗口方案，应先证明封闭控制，而不是先写账号功能：

1. 隔离环境用自建监督进程→宿主→Hub 多进程树，外部执行器位于控制范围外。所有创建者纳入启动门控，门控期间拒绝新增实例；另造范围外创建者验证旁路必须被明确拒绝而非被扫描忽略。
2. 宿主身份绑定 OS 用户、boot/session、PID/birth、可执行文件和凭据范围；记录无 Hub 宿主。任何未参与者、路径别名或范围未知阻断。不得只接受注册文件自报身份。
3. 在真实平台上证明控制范围与新启动屏障后，才将已有 journal/CAS/恢复逻辑抽入独立执行器。请求经受保护本地 IPC 传递，argv/日志不含凭据；执行器掌握唯一写入权，UI 不参与关键收尾。
4. 准备阶段取消可直接撤销；写入开始后必须完成提交/回滚。执行器故障后保持阻断，接管者确认旧执行者退出与 I/O 不再继续后恢复 journal。绝不能租约到期就恢复所有宿主。
5. 存储读回完成后，仅放行一个新验证 Hub；失败先停止并重新围住验证实例再回滚，最后统一恢复。需要保留窗口时可能必须暂停 renderer/监督者，窗口会暂时无响应。

若改为用户关闭窗口的离线路线，要明确这是不同体验：先保存全部普通文本及自定义编辑器文档，停止调试/扩展任务；外部执行器准备完成后关闭相关实例并确认其监督者与后台退出。期间禁止新开或重连相关窗口。该约束只能在受控会话里作为前提，不能在现有普通桌面环境自动验证成全局独占；若要求强保证仍需 OS/启动器控制。

## 用户影响与研究边界

宿主暂停会暂停该宿主全部扩展：语言服务、调试器、任务提供者、自定义编辑器和远程连接可能超时。终端或扩展派生进程不保证随宿主暂停/退出。普通文本缓冲区通常位于编辑器端，但这不构成所有未保存内容不丢失的保证；custom editor 状态可能在宿主内。关闭窗口必须遵守原生保存提示，不能绕过；冻结监督者还可能冻结窗口交互。

本轮没有真实 VS Code stop/restart 实验，没有 Windows/WSL 实测，没有构建新候选；研究型进程测试单独运行，不作为完整产品回归已完成的声明。独立安全审查确认公开接口缺口及封闭范围前提。下一步应由父线程依据上述条件评估是否继续隔离封闭范围原型，不能先承诺可用的保留窗口方案。
