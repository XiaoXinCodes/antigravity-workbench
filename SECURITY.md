# 报告安全问题

疑似账号凭据泄露、未经确认的账号操作、任意文件读写或其他安全漏洞，请私下报告。普通功能问题使用 [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues)。

## 报告渠道

打开仓库的 [Security 页面](https://github.com/XiaoXinCodes/antigravity-workbench/security)，若显示 **Report a vulnerability**，使用该入口提交私密报告。

若该入口不可用，只在 [Issues](https://github.com/XiaoXinCodes/antigravity-workbench/issues/new) 提交标题“请求安全报告渠道”，请维护者提供私密联系方法。此时不要填写漏洞细节或上传附件；收到私密渠道后再提交完整报告。仓库访问权限不等于安全报告的保密边界。

## 报告内容

- 受影响的 Workbench、VS Code 和 Google Antigravity 版本，以及本机或 WSL 宿主。
- 问题影响、必要前提、最少复现步骤与实际结果；尽量使用合成数据。
- 固定错误码和经过检查的脱敏截图或日志片段（如确有必要）。

不要发送真实令牌、登录文件、SecretStorage 数据库、账号导出包及其密码、私人提示词或原始服务响应。若发现自己的登录材料已泄露，先通过服务方的账号安全入口撤销相关授权，再使用合成材料说明复现方式。

维护者会根据报告确认影响范围、修复方式及披露安排；在完成协调前，请勿在普通 Issue 或 PR 中公开可利用细节。本项目不承诺固定响应时限。

实现中的保护与已知限制见 [安全设计与边界](docs/SECURITY.md)，账号恢复流程见 [切换与恢复](docs/ACCOUNT_SWITCHING.md)。
