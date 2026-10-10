# 实际 UI 截图交付

`scripts/test-ui-screenshots.cjs` 启动隔离 VS Code 扩展宿主，加载本次分支的生产工作台、图片、定时设置与额度历史页面。测试账号、模型和额度全部来自本地合成适配器；界面标题和状态栏明确标记模拟数据。定时总开关与同意状态保持关闭，真实模型发送器禁用，不安装 Google 官方扩展，不操作官方账号身份或用户原有设置。

Linux CI 使用 Xvfb 运行真实 VS Code，直接通过原生页面截图接口保存六张原始 PNG：额度比较、240px 窄侧栏、定时设置、暂停任务及预览、图片账号比较与历史请求、额度观察历史。检查未知额度单列、窄侧栏没有横向溢出，发送数保持 0；每张截图检查凭据关键词与邮箱，只允许 `@example.test`。页面样式与内容不通过截图脚本改写。

Actions artifact `workbench-actual-ui-screenshots-Linux` 包含六张 PNG 和 `capture-receipt.json`，收据记录真实 VS Code 版本、checkout 提交、宽度、文件字节数和 SHA-256。截图步骤失败会使 CI 失败；每次启动清空旧截图，避免用旧图替代失败结果。artifact 保留 14 天；测试 VSIX 使用独立 artifact。交付前还需人工目视核对截图隐私与内容。

本地复现：先 `npm run compile`，再在有显示环境下运行 `node scripts/test-ui-screenshots.cjs`；Linux 无显示环境时用 `xvfb-run -a node scripts/test-ui-screenshots.cjs`。截图仅为合成数据下的交互验收证据，不代表真实 Google、WSL、账号切换或模型调用验收。
