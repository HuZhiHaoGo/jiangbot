# 匠宝 Windows 内网版的 SQL Server 用量上报

上报功能由匠宝 Windows 正式包自带。Host 在正常 Profile 激活后订阅已锁定 Harness 的 `llm/stream`，采集实时返回的用量并通过 Host IPC 将有限字段交给 Electron 主进程。它不扫描历史日志，不保存或上传会话正文和提示词，不依赖 Token 用量市场插件。启动入口、Profile 包解析和客户端图均不变。Safe Mode、没有配置或数据库故障时，应用仍可运行。

后台按本机 Windows 用户名记工号，完整 Windows 身份记入 `WindowsLogin`。用统一的 SQL 登录向 `hbcshdb.dbo.ModelTokenUsage` 插入记录。普通、压缩、标题等辅助请求只要有真实 Token 数就计入员工总量。没有归属的请求保留空 `SessionId`。没有获得有效用量的请求不上报。

## 正式包构建

打包机的连接信息保存在本地模块 `.build/token-usage-sql.private.cjs` 中，包含 `server`、`user` 和 `password` 三个字段。`.build` 已排除在 Git 之外。更换打包机时，由管理员把这份私有模块放到新打包机的同一位置。服务器地址应匹配 SQL Server 的证书，默认端口为 1433。

在打包机的 PowerShell 中直接运行：

```powershell
npm run package:win
```

正式包会自动读取本地模块，生成连接配置和 SQL 写入脚本。交付整个 `dist/win-unpacked` 目录，员工解压并启动 `JiangBot.exe` 即可。安装程序也包含同一份资源。缺少本地模块时，生成的正式包不启用 SQL 上报。其他打包命令不会读取这份模块。

生产包对持有它的人可读，直接连接所需的共享密码也可从包中提取。只向内网目标员工分发，不把这一产物送入公开发布、更新源或公开构建缓存。使用专用低权限账号，只授予目标表的 `INSERT` 权限。读报表使用单独账号。不要使用数据库管理账号，不把配置文件提交 Git。目标 SQL Server 需提供客户端信任的 TLS 证书。

## 写入和验收

主进程最多保留 200 条待发送记录，每批最多 20 条。过期队列、进程退出和失败批次按约定允许漏报。单次尝试总计最多 8 秒，其中 SQL 连接 3 秒，单条命令 5 秒。临时错误最多重试一次，沿用原 `EventId`。表的 `UQ_ModelTokenUsage_EventId` 用于重复确认。写入使用参数化 SQL，不记录凭据或数据库错误全文。

在员工 Windows 账号下从解压目录启动，核对一次普通请求和一次标题或其它辅助请求的数据库记录，再验证断开数据库时聊天继续运行。部署时停用此前额外安装的 `0.4.15-intranet.2` SQL 上报插件，避免旧插件和内置功能同时向同一表写入。只做本地统计的插件可以继续使用。常规开发版和无配置的 Windows 包应保持不上报。
