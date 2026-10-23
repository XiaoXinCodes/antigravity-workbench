# 1.9 重开收尾与已知缺陷核对

本轮在 0.1.17 同一扩展身份上修复，不创建发行版，不安装、不操作真实账号。旧候选 SHA256 `2617715d6a7da4b47c5b9a75cd3c79aad1f7c52b43d454f49a89052a007b8768` 的等待交互已被替代。

| 已知问题 | 本轮处理 | 边界 |
| --- | --- | --- |
| 用户不知道何时重开 | 明确“保存、关闭相关窗口后正常重开”。工作台持续显示等待、与写者协调、核验、目标已核验、原登录未变或需处理；结果在清 fence 前持久保存并读回 | 没有宣称窗口关闭期间有外部通知；重新打开才显示结果 |
| 过早重开只中止并留下手动事务 | 新宿主按初始完整 host birth 集合识别，取消本次等待；取得原写者持有的同一锁后重新读取 marker/journal/凭据。prepared 原凭据仍一致则自动核验原登录并结束；目标已写入则核验目标，不重复写凭据 | 官方启动抢跑仍可能使目标切换未完成；会明确保留原账号，而非假报切换成功。未知新 refresh 凭据不覆盖，仍需用户明确处理 |
| 重试被旧检查或旧启动动作取消／抢占 | reset 在 global 锁内产生 attempt UUID并返回，原样传入 helper；取消、启动和状态更新检查该 attempt。初始宿主集合独立于 Hub，既有 peer 不误算重开 | 不声称阻止用户所有未来进程启动 |
| 升级前 helper 与新尝试交错 | 旧控制字段保持 cancelled=true；新尝试独立使用 attemptCancelled/attemptStatus。旧 helper 的迟到状态不覆盖新状态 | 保留旧 schema4 与原备份／密钥，不直接删锁 |
| helper 释放锁后迟到发布状态 | 已核验终态单调，迟到 INSTALLED/CANCELLED 不擦除已核验结果 | 清 fence 前再检查存储身份和进程路线 |
| 状态文件原子替换误报失败 | 仅对明确的 STORAGE_CHANGED 重新打开并完整校验，最多8次；不吞路径/权限/链接错误 | 真正不安全路径仍阻断 |
| Windows＋WSL 独立执行器实际存活未验收 | 增加并运行独立 PID/net namespace、显式临时 HOME、生产 helper＋原生 `/proc` census 的合成闭环，父进程实际退出后提交通过 | **真实 Windows 客户端关闭 WSL 窗口仍未验收**，隔离 Linux 成功不能替代该项。官方 RPC 仍只有合成证据 |

确定性回归涵盖：早重开与原写者锁互斥、原登录自动收尾、prepared 目标迟到写入核验、取消/超时/崩溃、未知凭据、PID复用、既有 peer、持久结果重载、不同窗口 restore/retry 交错、旧 helper 兼容、late helper 在 marker 清除后拒绝、真实合成子进程延迟 rename 时禁止第二写者。独立最终复审 46/46 通过，未发现剩余 P1 或已知未修复竞态。

## 非侵入本机隔离验证

提供 `scripts/isolated-offline-native.cjs`。它只使用随机临时 HOME 内的合成 token，加载生产执行器/锁/存储，不加载官方插件或 VS Code、不操作真实账号。需要 Node 22、Linux/WSL `unshare` 可创建 user/PID/network namespaces。不要通过关闭系统安全配置取得能力；不支持就报告原始错误。

将候选 VSIX 解压；把该脚本放到其 `extension/scripts/` 下，在 `extension/` 执行以下 Python 启动器（脚本依赖同目录的 `out/`）。命令不安装任何扩展，不使用用户 HOME：

```python
import os, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix="workbench-synthetic-") as fixture_home:
    env = dict(os.environ, HOME=fixture_home,
               AG_TEST_OUTER_PID=os.readlink("/proc/self/ns/pid"),
               AG_TEST_OUTER_NET=os.readlink("/proc/self/ns/net"))
    subprocess.run(["unshare", "--user", "--map-root-user", "--pid", "--fork",
                    "--mount-proc", "--net", "node",
                    "scripts/isolated-offline-native.cjs"], env=env,
                   timeout=45, check=True)
```

预期输出 `PASS: native isolated census, parent exit, detached production helper, synthetic commit, preserved backup and key. No Windows/official RPC claim.`

这可以验证 WSL 内核下原生发现与脱离普通父进程的能力，不能验证 VS Code Server 退出是否额外回收整个进程组。后者仍需要单独授权、独立测试窗口与受支持的隔离 Server 环境；目前没有冒充已完成的实机证据。若真实关闭把 helper 一起结束，重开路径必须依据已持久化数据自动核验原账号或目标，而不是继续等一个死亡执行器；本轮对应崩溃回归已覆盖。
