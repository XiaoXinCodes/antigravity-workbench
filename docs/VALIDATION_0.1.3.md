# 0.1.3 验证范围 / Validation scope

- 云端最终 0.1.3 完整检查：1135 通过、2 跳过、0 失败；身份、实际锁文件与视图专项检查：208 通过。最终三平台 CI 结果以发布提交为准。
- 核验前的历史展示仅持久化现有同宿主账号的唯一 ID，不存储额外邮箱或令牌。回归覆盖待确认标记、不产生当前登录徽标、不冒充保存成功，以及已删除、跨宿主和匹配不唯一的历史记录。
- 身份等待最长 60 秒，受剩余 90 秒重试预算限制；回归以假时间覆盖 25 秒冷启动成功、永久挂起的有界失败、预算耗尽后重复缓存证明不续期，以及重新检查恢复。
- 官方身份先确认，再独立等待本机保存最多 20 秒。回归覆盖保存挂起时界面结束身份核验、底层安全锁仍被占用、不排入替代保存，以及取消或身份变化后迟到保存无法通过校验。本实例已证明持有的副本保存锁仅允许只读身份重新核验；外部、未知、身份字段或恢复标记不匹配的锁继续阻止。
- 回归覆盖重新检查合并与取代旧请求、面板重建接入核验、焦点和面板共享检查、窗口关闭取消，以及旧请求迟到时保留新身份。
- 身份、账户、时间及 Hub 均使用虚构值或本地 mock；未调用真实 OAuth、真实账号、用户凭据或真实图片生成。未操作用户机器，不宣称用户真实窗口已验收。
- `npm run check` 包含类型检查、lint 和完整回归。Linux、Windows、macOS 发布门禁运行回归、隔离实际 VS Code 宿主、打包及许可校验；GitHub 四个最终资产下载后检查源提交、运行模块和 SHA-256。
- 云端完整离线回归在临时断网用户命名空间执行，避免云端根目录 UID 映射影响既有私有日志检查；不修改宿主挂载、权限或认证策略。
- 正式打包仅改写 VSIX 内 Markdown 文档的链接，保持运行模块、包身份和许可字节。5 项假值测试覆盖 HTML/Markdown 链接、嵌套目录、固定提交、幂等、重复 ZIP 成员及失败不替换。离线检查执行正式 vsce 的 VSIX 读取、README/CHANGELOG 处理与发布前校验，并在凭据边界以 mock 停止，未读取市场凭据或联网发布。实际 Marketplace 后端接受未测试。

## English

The final cloud 0.1.3 check passed 1135 tests with two skips and no failures; 208 focused identity, actual lock-file and view tests passed. Native Linux, Windows and macOS CI apply to the release commit.

Tests use fictional identities, fake time and local Hub mocks. They cover host-bound historical display without current-login or saved-state claims; deleted, ambiguous and foreign-host history; slow startup; bounded identity and save waits; exhausted retry budgets; concurrent rechecks; rebuilt views; disposal; late responses; and secure locks retained during unfinished saving. Identity waits are capped at 60 seconds within the remaining 90-second retry budget. Local-save UI waiting is independently capped at 20 seconds and does not release an unfinished secure operation's lock.

No real OAuth, real accounts, user credentials or image calls were used, and the user's actual machine or window was not tested. CI's isolated actual VS Code host is not real-account acceptance. GitHub publication and the separately prepared manual Marketplace upload are independent.

The formal VSIX is also the manual Marketplace upload package. Only Markdown links are normalized; runtime, identity and license bytes stay intact. Five fictional-data tests cover link resolution, nested documents, source pinning, idempotence, duplicate members and replacement-safe failure. Offline checks use the installed released vsce's VSIX reader, README/CHANGELOG processing and pre-publication checks, stopping at the credential boundary with a mock. No Marketplace credentials, token exchange or upload is used; real backend acceptance remains untested.
