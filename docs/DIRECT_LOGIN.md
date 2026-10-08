# 浏览器 OAuth 登录

通过“添加账号（OAuth 登录）”将另一个 Google 账号保存到当前宿主，不需要粘贴令牌或手工编辑登录文件。

## 操作步骤

1. 在可信工作区打开 Workbench，确认 Google Antigravity 与 Workbench 运行在同一宿主。
2. 结束正在运行的官方任务，点击“添加账号（OAuth 登录）”，阅读并确认本次操作。
3. 在系统浏览器中选择要添加的 Google 账号并完成授权。
4. 返回 VS Code，等待插件保存新账号、恢复原登录并完成核验。需要使用新账号时，再在卡片点击“切换”。

已经在官方扩展登录的账号，可直接使用“保存当前”，无需重复 OAuth。

## 取消或浏览器未返回

等待授权时可以取消。插件会停止相关回调后台并恢复原登录；若恢复未完成，按工作台的恢复提示处理。取消后关闭相应授权页面。已经在 Google 批准的授权不会因关闭页面而自动撤销。

若没有授权页面、回调未完成或组件能力不可用，先查看 [运行环境](ENVIRONMENTS.md)，再按 [故障排查](TROUBLESHOOTING.md) 记录错误码。不要为了排查删除官方登录文件。

## 保存位置

登录副本由当前扩展宿主的 VS Code SecretStorage 保存。切换 Windows / WSL、VS Code Profile 或设备时，不应直接搬运存储数据库；使用 [导出账号与导入账号](ACCOUNT_MIGRATION.md)。

[账号管理](INDEPENDENT_ACCOUNTS.md) · [切换与恢复](ACCOUNT_SWITCHING.md) · [文档目录](README.md)
