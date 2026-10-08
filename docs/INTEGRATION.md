# CLI 快照采集

## 适用范围

这一步只把官方 Antigravity CLI 向 statusline 脚本提供的数据保存成最小本地快照。它不会登录、登出、切换账户，也不会使 VS Code 与 CLI 的账户自动一致。

先在官方 CLI 自己完成登录。不要把密码、API key、验证码或 OAuth token 填入本项目。密钥模式的账户/额度字段没有足够公开约定；若没有有效身份或额度，本项目拒绝/显示未知，不猜测账户。

## 手动设置

1. 在扩展命令面板运行“Antigravity Workbench: 查看 CLI 快照采集配置”，得到 `out/bridge.js` 与专用 `snapshots` 目录的绝对路径
2. 确认终端里的 `node --version` 为 20+。扩展不会自动安装 Node 或 CLI
3. 备份 `~/.gemini/antigravity-cli/settings.json`；保留其他设置。如果已有 `statusLine` 脚本，先决定如何保留/组合它，本扩展不会替换它
4. 手动合并以下示意配置，把路径换成上一步的实际路径。POSIX 示例假设路径没有单引号；路径含 shell 特殊字符时使用对应 shell 的转义，不要原样粘贴占位符

```json
{
  "statusLine": {
    "type": "command",
    "command": "node '/absolute/path/out/bridge.js' --dir '/absolute/private/path/snapshots'",
    "stack_with_default": true,
    "enabled": true
  }
}
```

Windows 的示意 command（需核对实际 shell；路径不要使用 cmd 展开字符 `%` / `!`）：

```json
"command": "node \"C:\\Users\\you\\extension\\out\\bridge.js\" --dir \"C:\\Users\\you\\private\\snapshots\""
```

官方也支持 `/statusline <script-path>` 设置脚本。该命令会立即改变官方 CLI 设置并开始运行脚本，因此应由您确认脚本内容与路径后手动操作。不要把 `/logout` 用作测试或切换快捷方式；官方文档说明它会清除保存的认证配置。

5. CLI 状态变化时会通过 stdin 推送 JSON，采集器输出简短状态文字。使用官方 `/usage`（别名 `/quota`）明确刷新 quota，然后在 VS Code 点击“重新读取本地快照”
6. 停用时，在 CLI 手动关闭自定义 statusline 或恢复备份。扩展不会修改官方设置。扩展更新后安装路径可能变化，需要重新核对路径

若不在同一台机器运行，先用自己信任的文件传输方式取回**脱敏后的单份快照**，在扩展中手动导入。不要导入原始 CLI payload、密钥文件或转录日志。不要给本项目添加 SSH 凭据或广泛文件访问权限。

## 数据格式

采集器接受官方 statusline 的 `product: antigravity`、`email`、`quota` 映射；只保留桶名、`remaining_fraction` 和 `reset_time`。`reset_in_seconds` 没有用于推算新的绝对截止时间。其他字段一律丢弃。

生成的本项目格式：

```json
{
  "schemaVersion": 1,
  "source": "official-cli-statusline",
  "identity": "your-own-account@example.com",
  "capturedAt": "2026-09-30T07:00:00.000Z",
  "quotaState": "available",
  "buckets": [
    {
      "id": "provider-bucket-id",
      "remainingFraction": 0.5,
      "resetAt": null,
      "invalid": false
    }
  ]
}
```

上述仅为格式示意，不是任何账户的真实额度。本项目不附带用于展示的假账户或假实时数据。

身份按小写精确匹配，不对 Gmail 点号、加号别名做推断。文件名为身份 SHA-256；文件内容仍有明文身份，哈希文件名不构成匿名化。

## 故障排查

- `WRONG_PRODUCT`：输入不是预期的官方 Antigravity statusline JSON，不会保存
- `INVALID_IDENTITY`：身份缺失、过长、包含空白/控制字符；不会归到当前选中的账户
- `INPUT_TOO_LARGE` / `TOO_MANY_BUCKETS`：超过安全上限，不会截断后冒充完整数据
- `DIRECTORY_NOT_PRIVATE`：POSIX 目标目录对组/其他用户开放。选一个新的、只属于您的专用目录；不要把主目录或现有共享目录传给采集器
- `STORAGE_BUSY`：另一个采集/扩展进程正写入。稍后重试。如果所有相关 VS Code 窗口和 CLI 都已退出且该错误一直存在，检查专用目录中的 `.write.lock`；确认没有写入进程后可手动删除残留锁。程序故意不自动打破无法确认归属的锁
- 目录或文件读取失败：旧记录可能仍存在，界面会给出警告；不要据此断言新的额度可用
- 看到“近期采集”但数值没变：本项目只知道采集时刻。用 `/usage` 刷新官方数据；没有服务端更新时间证明
- 手动删除账户后又出现：运行中的 CLI 采集器再次写入了该账户，请先停用采集

## 官方依据

- [Statusline JSON 与配置](https://www.antigravity.google/docs/cli/statusline/)
- [/statusline](https://www.antigravity.google/docs/cli/commands/statusline)
- [/usage](https://www.antigravity.google/docs/cli/commands/usage/)
- [CLI 认证与 logout 行为](https://www.antigravity.google/docs/cli/install/)
