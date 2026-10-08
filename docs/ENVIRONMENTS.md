# 运行环境与文件位置

Workbench 使用扩展**实际运行所在的宿主**访问账号存储、文件和 CLI。项目显示在 Windows 桌面，并不代表扩展也运行在 Windows。

## 宿主选择

| VS Code 窗口 / 宿主 | 使用的环境 | 安装与路径要点 |
| --- | --- | --- |
| Windows 本机 | Windows 用户环境、密钥库与程序 | Workbench 与 Google Antigravity 均安装在本机侧，选择 Windows 路径 |
| macOS 本机 | macOS 用户环境与 Keychain | 使用本机扩展、目录和 CLI；系统可能要求密钥库访问 |
| Linux 本机 | Linux 用户环境与可用的 Secret Service | 登录变更需要受支持且已解锁的存储能力 |
| WSL Linux 工作区 | 当前发行版的 Linux 环境 | 两个扩展均运行在同一 WSL 宿主；使用该发行版的 HOME、CLI 与路径 |
| SSH / 容器扩展宿主 | 远程环境 | 尚未核验，不承诺账号写入与 CLI 路径兼容 |

本机 UI 宿主仍可能打开远程工作区。此时不能因为工作区远程就猜测扩展位置；以高级排障中的运行位置检查结果为准。

## 查看实际位置

从命令面板打开“Antigravity Workbench: 高级排障…”，检查扩展运行位置，并按需复制 Workbench、官方登录文件或图片输出路径。普通主界面不显示技术路径；只有与当前本机宿主兼容时才提供文件管理器入口。

工作台不自动把 Linux 路径变成 Windows 路径，也不把另一 WSL 发行版当成当前宿主。文件选择必须来自当前宿主。

## 账号和项目数据

- 已保存账号由当前宿主的 VS Code SecretStorage 保管；跨设备或跨 Windows / WSL 使用 [加密迁移](ACCOUNT_MIGRATION.md)。
- 官方凭据由官方组件管理，具体位置可通过高级排障查看，不应靠猜测路径手动编辑。
- 图片按所选目录保存；已有图恢复不删除源图。

账号操作按实际存储路由、后台进程、身份和组件能力检查。某项能力不可用时只阻止依赖它的操作；版本号较新不等于自动拒绝，也不等于已保证兼容。

[兼容性](COMPATIBILITY.md) · [快速开始](GETTING_STARTED.md) · [故障排查](TROUBLESHOOTING.md)
