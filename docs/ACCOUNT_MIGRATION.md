# 导出账号与导入账号

用 `.agwenc` 文件在设备或扩展宿主之间迁移已保存账号。导入自动使用所选候选凭证查询服务器身份和额度，不改变当前官方登录。

## 导出账号

1. 回到账号原保存宿主，在 Workbench 点击“导出账号”。
2. 选择要导出的账号、保存文件夹和 `.agwenc` 文件名。
3. 确认本次导出范围；已有同名文件时，同一次确认会明确显示要替换的文件。设置至少 12 个字符的密码并再次输入。
4. 通过可信方式传送加密文件，密码另行传送。

只提供加密导出。确认后可替换已有同名文件；取消或新密文写入、校验、提交失败时保留旧文件。文件替换只改变这一个导出文件，与导入同账号时的覆盖选择无关。密码遗失无法恢复。

密码加密后的 `.agwenc` 迁移包可导出到系统允许读写的本地目录，包括 Windows 目录和 WSL 中的 Windows 挂载目录。创建时仍请求私有权限作为默认值，但不检查实际权限模式、不限定文件系统，也不更改目标目录权限或挂载设置；系统拒绝访问时仍会停止。此规则仅用于密文导出，不改变内部凭据、明文或日志的私有存储要求。

新文件仍排他创建。替换已有文件时，先完整保存并校验同目录的密文临时文件，再复核确认时的目标内容、文件和父目录身份后提交；不会先删除或截断旧文件。检测到目标变化或并发导出时停止，只清理能确认归属的临时文件和事务标记。进程中断可能留下密文临时文件或未完成的文件事务；不确定的事务不会被强行接管，可先使用新文件名导出。

## 导入到目标宿主

1. 在目标设备或 WSL 宿主打开 Workbench，点击“导入账号”。
2. 选择 `.agwenc` 文件并输入密码，检查显示的账号名称、邮箱和保存时间。
3. 选择要导入的账号。同邮箱冲突可选择覆盖或跳过。同邮箱有多条旧记录时，明确选择覆盖目标；不会再另存重复副本。
4. 确认导入，等待身份核验和额度查询。核验成功后保存新增账号或覆盖所选账号；覆盖保留账号 ID 和列表位置。取消和身份核验失败均保留原记录。

导入本身不发起 Google 登录、不改变当前官方登录、不停止官方后台。来源机器的运行路径、恢复记录、操作锁和官方会话历史不进入迁移包。

## 核验、失败与恢复

导入直接查询候选凭证的服务器邮箱和 subject，并在额度查询前后核对身份；当前官方登录即使是同邮箱，也不会用于代替候选核验。明确失效、身份不匹配、403 资格限制、429 限流和网络超时分别提示。身份有效但没有额度或查询受限时，账号可保存，并显示对应额度结果。

候选及返回的轮换凭证仅暂存在当前宿主的 SecretStorage 中，不写官方登录槽。取消会等待已经开始的授权更新安全收尾；候选不会自动生效。导入失败后可重新选择同一迁移文件重试，使用已保留的轮换结果。服务端是否轮换无法确认时会停止复用旧 refresh token，请保留记录并按错误提示处理。SecretStorage 不提供 fsync；扩展无法保证网络响应与本机持久化之间不存在断电窗口。

导出只读取已保存副本，不恢复刷新记录、不改变账号状态。存在未完成授权更新时，先通过原操作完成恢复后再导出。旧版待核验导入记录可以重新导入，通过候选核验后覆盖。

需要切换时仍使用正常的备份、存储检查和官方身份核验流程。导入核验不等于已经切换。

迁移成功不保证 Google 接受已失效或被撤销的授权。遇到明确的重新授权提示时，通过 OAuth 添加账号；不要重复导入或手工拼接凭据文件。

## 数据范围

迁移包包含所选账号的完整登录副本，因此文件与密码都应妥善保管。它不迁移图片、官方聊天会话或项目文件。不要用复制 VS Code SecretStorage 数据库代替导入流程。

[账号管理](INDEPENDENT_ACCOUNTS.md) · [切换与恢复](ACCOUNT_SWITCHING.md) · [运行环境](ENVIRONMENTS.md) · [文档目录](README.md)

## English

To export, select accounts, a destination folder and an `.agwenc` filename. One confirmation covers the export scope and, if the file exists, explicitly identifies the file to replace. Enter a password of at least 12 characters twice. File replacement is separate from replacing an account during import.

Cancellation or an encryption, staging, verification or commit failure preserves the original file. New destinations use exclusive creation. Replacement writes, syncs and reads back an encrypted temporary file in the same directory before checking the confirmed target and committing by rename; it never first deletes or truncates the original. No POSIX mode or mount policy is imposed, including Windows folders and WSL Windows mounts. Changed targets and concurrent exports stop. Interrupted processes may leave encrypted staging files or an unfinished claim; uncertain claims are not forcibly taken over, and a different filename can be used.

Import checks the selected candidate credentials for server identity and quota while keeping the current official login unchanged. Matching email and host records can be replaced or skipped. If several legacy records share the same email, choose the exact replacement target. Replacement preserves its ID and list position; capacity counts only additions.

Identity is checked before and after quota using the candidate bearer, even when the current official login has the same email. Invalid credentials, identity mismatch, eligibility restrictions (403), rate limiting (429), missing quota and network timeouts are reported separately. A valid identity with unavailable quota may still be saved with its quota error.

Candidates and returned refresh rotations remain in this host's SecretStorage. Cancellation waits for an already started refresh to finish safely. Retry using the same encrypted file to resume retained rotations. An uncertain refresh outcome blocks reuse of the old refresh token. SecretStorage has no fsync guarantee, so a process or power failure between the server response and local persistence cannot be made atomic.

Export reads saved copies without repairing refresh records or changing account state. Finish an incomplete refresh through its original operation before exporting. Legacy unverified imports can be imported again and replaced after candidate verification. Switching still follows the normal backup and official-session verification flow.
