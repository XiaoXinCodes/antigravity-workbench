# 实际 UI 截图交付

`scripts/test-ui-screenshots.cjs` 启动隔离 VS Code 扩展宿主，加载本次分支的生产工作台、图片、定时设置与额度历史页面。测试账号、模型和额度全部来自本地合成适配器；界面标题和状态栏明确标记模拟数据。定时总开关与同意状态保持关闭，真实模型发送器禁用，不安装 Google 官方扩展，不操作官方账号身份或用户原有设置。

Linux CI 使用 Xvfb 运行真实 VS Code，直接通过原生页面截图接口保存七张原始 PNG：额度比较、240px 窄侧栏、定时设置、暂停任务及预览、图片账号选择／所选账号额度与历史请求、额度观察历史、目录用途未标明时的就近确认。检查未知额度单列、窄侧栏没有横向溢出，发送数保持 0；每张截图检查凭据关键词与邮箱，只允许 `@example.test`。页面样式与内容不通过截图脚本改写。

Actions artifact `workbench-actual-ui-screenshots-Linux` 包含七张 PNG 和 `capture-receipt.json`，收据记录真实 VS Code 版本、checkout 提交、宽度、文件字节数和 SHA-256。截图步骤失败会使 CI 失败；每次启动清空旧截图，避免用旧图替代失败结果。artifact 保留 14 天；测试 VSIX 使用独立 artifact。交付前还需人工目视核对截图隐私与内容。

本地复现：先 `npm run compile`，再在有显示环境下运行 `node scripts/test-ui-screenshots.cjs`；Linux 无显示环境时用 `xvfb-run -a node scripts/test-ui-screenshots.cjs`。截图仅为合成数据下的交互验收证据，不代表真实 Google、WSL、账号切换或模型调用验收。

## 本次统一设计验收

`npm run test:design-host` 使用相同隔离宿主，增加账号、图片、计划、提醒、设置、帮助、排障的浅色/深色/高对比度及 214px 实际页面窄屏截图，共 29 张。另有记录和额度历史专项截图。收据验证重复打开、取消查询、四类计划输入保留、全局语言、设置重开与草稿保留、窄屏无横向溢出，真实请求及调度发送为 0。本次 Linux 实测使用 WSLg 与 VS Code 1.141.0。

人工像素审查覆盖桌面、窄窗口和高对比度；修正了高对比度主题选中导航及 A 图标的文字颜色。文档中的图来自生产 UI 和合成适配器，不是独立 HTML 预览。

## README 简短演示

`scripts/capture-readme-demo.cjs` 复用同一隔离宿主方式，加载生产工作台与本地合成适配器，分别捕捉中英文账号搜索、同模型额度比较、单账号刷新、图片账号选择与额度、历史参数复用及本机 Token 记录。没有安装官方扩展、读取真实凭据、切换官方账号或发送模型请求；生图发送器保持禁用。示例图片复用项目自有的 `media/brand-logo.png`，不是本次线上生成结果。隔离宿主的嵌套页面无法解析该图片的原生资源 URL，因此仅在演示夹具中将这一文件作为内联图片 URI 提供；未修改生产页面或资源加载实现。

在有显示环境的仓库根目录运行（无显示器 Linux 可加 `xvfb-run -a`）：

```sh
npm run compile
AG_DEMO_LANGUAGE=zh-CN node scripts/capture-readme-demo.cjs
AG_DEMO_LANGUAGE=en node scripts/capture-readme-demo.cjs
python3 scripts/build-readme-demo.py
```

编码步骤需要 Pillow 和支持中文的字体，默认使用 Noto Sans CJK，可通过 `AG_DEMO_FONT` 指定字体路径。捕捉支持 `AG_VSCODE_TEST_VERSION` 或 `AG_VSCODE_EXECUTABLE` 选择独立测试宿主。原始帧、摘要与合成数据收据写入 `.test-results/readme-demo/<语言>/`，不会进入安装包。

GIF 裁切实际编辑器区域，保留原界面比例与样式；字幕始终说明演示数据、示例图片和无模型请求。使用共享调色板、静止停留与差异帧压缩，避免颜色闪烁。两种语言各 9 帧、16.2 秒，资源上限为每张 2 MiB。交付前需检查编码后的实际画面、字体、裁切、停留时间和双语 README 渲染；这不构成真实 Google 服务调用或原生图片资源加载验收。
