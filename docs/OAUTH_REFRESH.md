# 授权更新契约

已保存账号的独立配额查询可以在本机授权范围内更新支持的登录授权。刷新令牌绑定其签发客户端，不能替换为任意客户端 ID 或轮试客户端池。

1. 只接受来源可识别且已核验的 consumer native-client 配置；从已安装官方可执行文件读取并核对固定指纹，仓库不携带完整客户端常量。
2. 本机授权涵盖读取所选副本、向固定 Google 令牌端点提交、核验身份和加密写回。访问材料不发送给开发者、任意 URL、代理或 webview。
3. 按账号及共享授权指纹串行处理，开始和写回前比较保存副本，避免并发刷新或覆盖外部修改。
4. 轮换令牌先写入加密待核验记录，再用返回的访问令牌核验服务端邮箱与稳定身份。失败不能把新身份写成原账号。
5. 核验成功后更新对应副本并读回验证；没有新刷新令牌时保留有效原值。中断后接续已有事务，不盲目重复失效请求。

该路径不改写当前官方登录槽，但服务端轮换可能影响共享授权的其他客户端。取消不保证 Google 没有执行；响应丢失时可能无法恢复已返回的轮换材料，界面必须明确结果未知。

协议依据为 [RFC 6749 §6](https://www.rfc-editor.org/rfc/rfc6749#section-6)、[RFC 8252 §8.5](https://www.rfc-editor.org/rfc/rfc8252#section-8.5) 与 [Google 原生应用 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)。技术可行不等于服务方授权第三方使用其客户端注册，适用规则见 [Google OAuth 政策](https://developers.google.com/identity/protocols/oauth2/policies)。

互通参考为 [Antigravity-Manager 固定提交的 OAuth 模块](https://github.com/lbjlaq/Antigravity-Manager/blob/45fc6d37db64689b50e42b38fd59a8d2dd627740/src-tauri/src/modules/oauth.rs)。本项目不采用客户端轮试、静默重试或明文账号 JSON 持久化；引用不代表复制其实现或取得官方兼容承诺。

[服务端配额](INDEPENDENT_ACCOUNT_QUOTA.md) · [安全边界](SECURITY.md) · [文档目录](README.md)
