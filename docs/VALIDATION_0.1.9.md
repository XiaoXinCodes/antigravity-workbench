# 0.1.9 验证范围 / Validation scope

用户可见变化见 [发布说明](RELEASE_0.1.9.md)；完整候选与三平台检查见 [PR #6](https://github.com/XiaoXinCodes/antigravity-workbench/pull/6/checks)。main 合并后的发行工作流再次运行同一矩阵，并回读正式 VSIX、源码包与校验清单后才公开资产。

本地回归与隔离实际 VS Code 使用合成账号和模拟传输，覆盖账号额度增量刷新、焦点与滚动、取消／重复操作／迟到结果隔离、重载后的对比和排序、跨页面语言切换，以及原生 QuickPick 搜索、一次回车仅置顶一次、指针和键盘收藏。旧的重复接受循环已有复现和对照；隔离 Linux 1.141 中已捕获旧置顶快照回传覆盖收藏、随后页面状态保存将旧值再次落盘的链。额度偏好与页面状态共用受限协调器及辅助修订标记，原有两个键和格式保留；失败不提交逻辑快照，其他窗口的新修订仍可读入。回归覆盖大量写入后的旧回传、失败恢复及真正重载后的额度／图片收藏。其他环境中收藏偶发回落是否同因尚未证实。

保留扩展 ID、SUL、账号和图片历史存储以及既有官方身份／进程处理。真实 Google 目录、模型权限、真实请求与用户工作窗口重载未作为本版验收；Nano Banana 2.1 仍按账号返回的图片目录决定可选性。Marketplace 由用户手动上传。

Tests use synthetic accounts and transports in isolated VS Code. Real Google access, model permissions, requests and the user's work-window reload remain outside this acceptance scope. CI checks and asset verification are available from PR6 and the main release workflow.
