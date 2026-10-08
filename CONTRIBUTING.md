# 参与开发

项目自有部分采用 [Sustainable Use License 1.0](LICENSE)，属于 source-available（源码可见）项目，不是 OSI 标准开源项目。贡献前请阅读许可正文及 [第三方声明](THIRD_PARTY_NOTICES.txt)。

普通问题或较大改动先在 [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues) 描述需求、复现方式或设计；疑似漏洞按 [安全报告流程](SECURITY.md) 处理。未来插件市场交付的要求见 [Marketplace 发布准备](docs/MARKETPLACE_PREPARATION.md)。

## 开始

使用 Node.js 20+；CI 固定 Node.js 22。按锁文件安装依赖：

```sh
npm ci --ignore-scripts
npm run check
python test/release-safety.test.py
npm run test:host
npm run package
python scripts/verify-release.py artifacts/antigravity-workbench-0.1.0.vsix
```

无显示器 Linux 的宿主测试使用 `xvfb-run -a npm run test:host`。所有默认检查使用合成数据或隔离宿主，不要求真实 Google 登录、账号切换或生图。实际账号验收需单独说明操作范围。

## 代码边界

| 范围 | 主要模块 |
| --- | --- |
| 账号与恢复 | `live-ui`、`live-switch`、`live-storage`、`recovery-store`、`recovery-verification`、`official-restart` |
| 服务端配额 | `account-quota-client`、`account-quota-transport`、`account-quota` |
| 图片请求与解析 | `direct-image-vscode` 连接宿主；`direct-image-core` 编排；`direct-image-transport` / `direct-image-project-transport` 处理传输；`direct-image-response` / `direct-image-raster` 验证响应与图片 |
| 界面 | `workbench-view`、`live-ui`、`direct-image-ui`、`debug-ui` |
| 诊断 | `debug-events`、`debug-log-store`、`image-operation-record`、`recent-image-failure` |
| 旧实现回归 | `src/legacy`，参与类型检查与原有测试，不进入安装包 |

传输层不决定账号切换；解析器不发网络请求；界面不绕过确认、互斥或恢复核验。错误码沿用各模块的固定分类，未知异常正文不直接进入界面与日志。

## 维护约束

- `src/legacy` 提供独立回归夹具，不由产品入口引用，不进入 VSIX。保留其测试覆盖。
- 账号恢复、授权更新、并发锁、迟到读回及共享图片守卫需要针对性验证；文案和品牌调整不得改变这些保护。
- 源码、测试、开发脚本和品牌原图进入源码交付；VSIX 只包含运行模块、图标与使用文档。
- CLI 快照命令是独立功能；快照不是已登录账号，也不代替服务端额度查询。

## 提交与验证

从最新 `main` 创建独立分支，保持修改范围明确，通过 Pull Request 提交。没有仓库写权限时，可在仓库访问权限允许的范围内使用 fork。PR 说明触发条件、结果变化和验证边界；尚未完成的工作标记为 Draft。文档入口从 [docs/README.md](docs/README.md) 开始；设置和命令名以 `package.json` 为准，截图必须标明真实环境或合成夹具。

只提交你有权贡献的内容。引入第三方代码、素材或改编时记录固定来源、版本、许可及修改范围，保留原有版权与声明；项目 SUL 不替代第三方许可。新增随包材料需同步 `THIRD_PARTY_NOTICES.txt`、`LICENSES/` 与打包校验，无法确认分发权限的材料不要纳入提交。

提交前检查相对链接、版本、固定错误码与打包内容。CI 对精确 PR 提交运行 Linux、Windows、macOS 检查；检查通过后由维护者审阅并决定是否合并。版本发布在 main 通过同一矩阵后执行；发布脚本遇到已有版本会跳过，拒绝覆盖已发布 Release、标签或附件。草稿更新必须符合发布脚本的固定身份和资产校验。正式发布前必须下载核对资产。

问题反馈见 [故障排查](docs/TROUBLESHOOTING.md)。不要提交登录文件、账号包、私人提示词、图片、本机原始日志或内部取证文件；示例与测试使用合成账号、路径和数据。
