# Dot 网页工作台

通过浏览器把消息和附件交给 Dot，由 Dot 转交本机 Codex，再回到网页看回复和下载文件。工作台只保存从这个网页发出的请求及对应回复，客户端继续保存完整对话。

**当前版本是 Windows 本机工作台。** 介绍视频中的 Tailscale 私网访问、访客免网页登录和访客数据隔离属于方案示意，仓库目前没有访客入口、权限管理或多用户隔离。网页没有独立的登录验证，默认只监听回环地址。请在受信任的本机环境使用。

## 能做什么

- 新建无项目对话，或选用一个自行配置的 Codex 项目中的对话。无项目列表只显示本工作台创建的会话。
- 选模型和推理强度，发送文本和附件。每个附件最多 50 MB，每条消息最多 12 个附件。
- 在网页查看 Markdown、公式、表格和图片，下载任务明确交付的文件，也能导出工作台记录。
- 在支持的网页澄清流程中回答问题，原任务收到回答后继续。Codex 客户端的原生提问和执行审批仍由客户端处理。
- 按轮次选择是否发送完成邮件，可选配置自有 SMTP 账户。

## 本机启动

需要 Windows、已登录的 Codex 桌面客户端、Node.js 24、pnpm 11 以上和 Python 3。安装依赖、构建前端并复制公开示例配置。

~~~powershell
git clone https://github.com/zxshm/dot-web-workbench.git
cd dot-web-workbench
pnpm install --frozen-lockfile
pnpm build
Copy-Item config.example.json config.json
pnpm start
~~~

打开 [本机网页](http://127.0.0.1:4190)。空白示例配置可启动网页。待连接 Codex 和 Dot 后，队列里的请求才能实际执行。

| 配置 | 填写内容 |
| --- | --- |
| callerThreadId | 本机 Codex 调用来源对话 ID。可从一条自己的本机对话链接取得对话编号。 |
| pipePrefix | 桌面工具命名管道的前缀。默认查找唯一以 codex-app-tools- 开头的管道。配置了 CODEX_APP_TOOLS_PIPE_PATH 时优先使用。 |
| projectId、projectName | 可选。从 Codex 项目列表取得项目 ID，并设置网页显示名称。两项留空使用无项目模式。 |
| port、mcpPort | 网页和 MCP 的本机端口。默认分别为 4190 和 4191。 |
| tunnel.id、tunnel.organizationId、tunnel.clientPath | 自建 Secure MCP Tunnel 的隧道 ID、组织 ID 和官方客户端绝对路径。 |
| tunnel.proxy | 可选。留空使用直连。已有本机 HTTP 代理时可填回环代理地址。 |

项目通过 Windows 桌面工具的命名管道连接 Codex，依赖客户端提供相应工具。这个接口可能随客户端版本变更。客户端或账户暂时没有桌面工具、Dot 或 Secure MCP Tunnel 能力时，网页和本地记录仍可使用。

## 连接自己的 Dot

1. 在你的账户创建私有插件和独立的 Secure MCP Tunnel，使用官方客户端。工作台的本机 MCP 地址默认为 http://127.0.0.1:4191/mcp。
2. 在 config.json 填写隧道信息，重启工作台，在「设置 → 连接说明」填入该隧道的运行密钥。程序在当前 Windows 用户下加密保存运行密钥和本机 MCP 凭据。
3. 隧道启动后完成插件的工具发现及安装。把 [Dot 接入指令](docs/Dot接入.md) 发给自己的 Dot，建立事件订阅。
4. 在工作台检查「Dot 已连接」，再新建一个只包含样例数据的对话，核对发送、转交和回复。

MCP 工具支持列队、读取、派发和检查连接。工作台先验证回调挑战，再保存订阅。续订时沿用原订阅，派发按请求 ID 幂等。

[MCP Events 文档](https://developers.openai.com/plugins/build/mcp-events)

## 通知与数据

可选配置 config.json 中的 smtp.host、smtp.port 和 smtp.username。程序使用 SMTP over TLS。在交互式 PowerShell 执行 python mail.py --setup，按隐藏输入提示填写 SMTP 授权码。完成后在网页编辑收件地址并勾选通知。取消勾选的请求不会发完成邮件。邮件正文可能包含任务回复，由你决定是否启用。

SQLite 记录和附件位于 data/。运行密钥和 MCP 凭据在当前 Windows 用户的 LocalAppData/DotWebWorkbench 下按安装位置隔离。SMTP 授权码以 DPAPI 密文保存于 data/。请勿把真实 config.json、数据目录或凭据上传到公共仓库。

网页和 MCP 都只监听回环地址。Secure MCP Tunnel 的用途是连接自己私有插件的 MCP 接口。管理员网页包含会话、文件和通知设置，当前版本适合单用户使用。

## 开发和许可证

修改富文本前端后重新运行 pnpm build。运行 pnpm test 执行附件、请求状态、回调、提问、邮件和渲染相关测试。测试用模拟客户端及样例数据，避免派发实际 Codex 任务或发送邮件。

仓库源码按 MIT 许可发布。依赖按各自许可证发布，前端构建生成的 KaTeX 字体和其他依赖资产来自锁定的 npm 包。
