# 信屿 · MailIsle 技术方案

> 状态:开发中,2026-11-11。第 1 阶段主要功能和第 2 阶段 OAuth 已实现,当前验证情况与待办见 [README.md](README.md)。
> 各邮箱服务商的政策查证于 2026-11-10,来源见文末附录。这类信息变化快,实现到对应部分时请再确认一次。

## 1. 概要

**要做的东西**:一个自部署的邮件客户端,把多个邮箱聚合到一个界面里。

- 统一收件箱、跨账号搜索、统一的读写体验。
- 在本机作为常驻程序运行,通过浏览器访问界面。
- 同一个界面可以映射出去,供手机或其他设备远程访问。

**不做的东西**:

- 公开的多用户服务(SaaS)。
- 自建收信服务器(不接管 MX,只作为各家邮箱的客户端)。

### 已定决策

| 决策点 | 结论 | 详见 |
|---|---|---|
| 形态 | 本地常驻进程 + 浏览器界面,可映射到远程 | 第 2 节 |
| 数据方式 | 邮件同步到本地库,不做 IMAP 直通 | 第 2 节 |
| 语言 | TypeScript 全栈,运行在 Node.js 上 | 第 3 节 |
| 接入顺序 | 先通用 IMAP/SMTP,再加 OAuth,原生 API 按需 | 第 9 节 |
| OAuth client ID | 预置 Thunderbird 的,用户可改,附自己注册的教程 | 第 5 节 |
| 新邮件通知 | IMAP IDLE 加轮询,不用需要公网回调的推送 | 第 7 节 |
| 私有协议和逆向 | 默认不做 | 第 8 节 |

## 2. 架构

```
核心进程(同步引擎 + HTTP API + 内嵌前端)
   │
   ├─ 本机访问:浏览器 / PWA / 桌面壳   → 127.0.0.1:端口
   ├─ 远程访问:手机等 → Tailscale / 隧道 → 同一端口
   │
   ├─ 本地存储:SQLite(元数据 + 全文索引) + 磁盘(正文、附件)
   │
   └─ 邮箱适配器
        ├─ IMAP / SMTP(通用,覆盖大多数邮箱)
        ├─ Gmail API
        ├─ Microsoft Graph
        └─ JMAP
```

四条设计原则:

1. **同步引擎 + 本地存储,不做 IMAP 直通。** 统一收件箱和跨账号搜索都要求邮件元数据在自己的库里。直通式 webmail(Roundcube 一类)在多账号下又慢又难聚合。
2. **daemon-first。** 一个常驻进程同时负责同步、API 和托管前端。"本地客户端"和"远程 webui"是同一个端口的两种访问方式,不维护两套代码。
3. **适配器接口统一。** 每种邮箱后端实现同一组操作,核心逻辑不感知具体服务商。
4. **桌面壳只是壳。** 壳只负责窗口、托盘、通知、开机自启。业务数据一律走 HTTP API,否则远程 webui 会缺功能。

### 适配器要实现的操作

| 操作 | 说明 |
|---|---|
| 列出文件夹 / 标签 | 并映射到统一的角色(收件箱、已发送、草稿、垃圾、归档) |
| 增量同步 | 传入上次的游标,返回新增、变更、删除 |
| 取正文和附件 | 按需拉取,落盘缓存 |
| 修改标记 | 已读、星标、标签 |
| 移动 / 删除 | |
| 发信 | 并保证"已发送"里有且只有一份副本 |
| 监听变更 | 推送或轮询,通知核心有新变化 |

### 各后端的增量同步游标

| 后端 | 游标 |
|---|---|
| IMAP | `UIDVALIDITY` + `UIDNEXT` + `MODSEQ`(CONDSTORE / QRESYNC) |
| Gmail API | `historyId` |
| Microsoft Graph | delta token |
| JMAP | `state` |

## 3. 技术栈

前后端都用 TypeScript,共享类型定义。

| 层 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node.js(当前 LTS) | 常驻进程,不能用 serverless。不用 Bun:IMAP 长连接依赖 Node 的 `net` / `tls` 行为,不值得冒兼容性风险 |
| 仓库结构 | pnpm workspace | 见下方目录结构 |
| HTTP 框架 | Hono + `@hono/node-server` | 自带 SSE 辅助;路由类型可以直接导出给前端用 |
| 入参校验 | Zod | 前后端共用 schema |
| IMAP | ImapFlow | 已覆盖的需求见第 7 节 |
| SMTP | Nodemailer | 代理要单独配置,不继承 ImapFlow 的设置 |
| MIME 解析 | postal-mime | |
| Gmail API / Graph / JMAP | 直接用 `fetch` | 不引入各家官方 SDK |
| OAuth | 自己实现授权码流程 | 不用各家的认证 SDK |
| 存储 | SQLite(WAL 模式)+ better-sqlite3 + Drizzle | FTS5 虚拟表 Drizzle 不建模,用手写 SQL 迁移 |
| 全文搜索 | SQLite FTS5 + 应用层中文切分 | 见第 7 节 |
| 正文与附件 | 磁盘文件 | 离线可读;可设缓存上限 |
| 前后端通信 | REST + SSE | SSE 用来把同步进度和新邮件推给所有打开的界面 |
| 前端 | React + Vite SPA | 不需要 SSR |
| 前端数据与列表 | TanStack Query + TanStack Virtual | 邮件列表必须虚拟滚动 |
| 组件与编辑器 | shadcn/ui + Tailwind + Tiptap | Tiptap 用于写信 |
| 邮件 HTML 清洗 | DOMPurify(浏览器端) | 配合 sandbox iframe,见第 6 节 |
| 测试 | Vitest | 集成测试用 Docker 起 Dovecot 或 GreenMail 作 IMAP 服务器 |
| 桌面形态 | 先用托盘图标 + 浏览器或 PWA | 需要独立窗口时再套 Electron,Node 核心可以直接跑在它的主进程里 |
| 分发 | Docker 单容器,或 Node 直接运行构建产物 | |

### 目录结构

```
mail/
├─ apps/
│  ├─ server/    核心进程入口:HTTP API、SSE、托管前端静态文件
│  └─ web/       React SPA
├─ packages/
│  ├─ core/      同步引擎、适配器接口与各适配器、会话聚合、发信
│  ├─ db/        Drizzle schema、迁移、全文索引
│  └─ shared/    前后端共用的类型和 Zod schema
├─ docs/         面向使用者的教程
└─ DESIGN.md
```

### 选 TypeScript 接受的代价

- 分发要带 Node 运行时,体积和常驻内存比 Go 单二进制大。自用和 Docker 部署下可以接受。
- better-sqlite3 是原生模块。主流平台有预编译包,但套 Electron 时要按 Electron 版本重新编译。
- Proton 只能走 sidecar,不能原生接入(官方库是 Go)。

## 4. 邮箱支持

| 邮箱 | 接入方式 | 认证 | 注意 |
|---|---|---|---|
| Gmail / Google Workspace | IMAP + XOAUTH2;以后可加 Gmail API | OAuth2;个人号也可用应用专用密码 | 走 IMAP 时同一封邮件会出现在多个文件夹,见第 7 节 |
| Outlook.com / Microsoft 365 | IMAP + XOAUTH2;以后可加 Microsoft Graph | 只能 OAuth2 | 企业租户可能需要管理员同意。不要做 EWS:2026-10 起分阶段停用,2027-04-01 彻底关闭 |
| iCloud | IMAP / SMTP | App 专用密码 | 无 OAuth,无 API |
| Yahoo / AOL | IMAP / SMTP | 应用密码 | 自己申请 OAuth 需要审批 |
| Fastmail | JMAP,或 IMAP / SMTP | API token 或应用密码 | 体验最好的 API,数据模型值得借鉴 |
| QQ 邮箱 / Foxmail | IMAP / SMTP | 授权码 | 要先在网页端开启 IMAP;默认可能只同步最近 30 天 |
| 163 / 126 | IMAP / SMTP | 授权码 | 必须发 IMAP `ID` 命令,否则打开文件夹时报 Unsafe Login。ImapFlow 设置 `clientInfo` 即可 |
| 腾讯企业邮、阿里企业邮、飞书邮箱 | IMAP / SMTP | 密码或客户端专用密码 | 管理员可能禁用 IMAP |
| Proton Mail | 用 Proton Bridge 或 hydroxide 作 sidecar,暴露本地 IMAP | Bridge 需要付费账号 | 端到端加密,没有标准协议 |
| Tuta | 基本不可行 | — | 无 IMAP,无公开 API |
| 自建及其他 | IMAP / SMTP | 密码 | 用自动配置探测服务器参数 |

配套能力:

- **自动配置**:用 Thunderbird 的 ISPDB(按邮箱域名查 IMAP/SMTP 参数),查不到再回退到手动填写。
- **账号级代理**:每个账号可单独配置 SOCKS5 或 HTTP 代理。在国内网络下,没有这个 Gmail 和 Outlook 连不上。

## 5. 认证与 OAuth

### 5.1 认证方式

| 方式 | 适用邮箱 | 本地保存的凭据 |
|---|---|---|
| 密码、授权码、应用专用密码 | QQ、163、iCloud、Yahoo、企业邮、自建;个人 Gmail 可选 | 密码 |
| OAuth2(XOAUTH2) | Gmail、Outlook.com、Microsoft 365 | refresh token |
| API token | Fastmail 的 JMAP | token |

所有凭据都加密后落盘,见第 6 节。

### 5.2 OAuth client ID

Gmail 和 Outlook 要求客户端带一个已注册的 OAuth client ID。本项目的做法:

- **默认值**:预置 Thunderbird 的公开 client ID,开箱即用。取值来自 Thunderbird 源码的 `OAuth2Providers.sys.mjs`。
- **可修改**:每个服务商的 client ID 和 client secret 都能在设置里改成自己的,也能按账号单独指定。
- **教程**:[注册自己的 Google OAuth 客户端](docs/oauth-google.md)、[注册自己的 Microsoft OAuth 客户端](docs/oauth-microsoft.md)。

预置值和自带值的请求参数不同:

| | 预置(Google) | 预置(Microsoft) | 自带(Google) | 自带(Microsoft) |
|---|---|---|---|---|
| client secret | 有 | 无 | 有 | 无 |
| PKCE | 用 | 不用,与 Thunderbird 一致 | 用 | 用 |
| 回调地址 | `http://127.0.0.1:端口` | `http://127.0.0.1:端口` | `http://127.0.0.1:端口` | `http://localhost:端口` |

自带的 Microsoft 客户端用 `localhost`,是因为 Entra 门户的输入框只接受 `http://localhost`,登记 `http://127.0.0.1` 要手改 manifest。

申请的权限,预置和自带相同:

| 服务商 | 权限 |
|---|---|
| Google | `https://mail.google.com/` |
| Microsoft | `https://outlook.office.com/IMAP.AccessAsUser.All`、`https://outlook.office.com/SMTP.Send`、`offline_access` |

使用预置值的约束和处理:

| 约束 | 处理 |
|---|---|
| 同意页显示的应用名是 Mozilla Thunderbird | 跳转前在界面上提示,避免用户以为被钓鱼 |
| Mozilla 或平台可以随时更换、吊销 | 预置值集中放在一个文件里,便于更新;授权失败时提示改用自己的 client ID,并链接到教程 |
| 企业或学校的管理员可能按 client ID 拦截 | 同上 |
| 只申请了 IMAP、SMTP 相关权限 | 预置值只用于 IMAP + XOAUTH2。Gmail API、Graph 这类原生适配器要求用户自带 client ID,不占用 Thunderbird 的接口配额 |
| 项目公开发布后,这个默认值最可能引起异议 | 届时重新评估;代码上保证删掉预置文件后其余功能不受影响 |

Thunderbird 源码里还有 Yahoo、AOL、Fastmail 等服务商的预置值,需要时可以按同样方式加入。

### 5.3 授权流程

- **本机**:核心进程临时监听一个随机端口的 loopback 地址,浏览器授权后跳回这个地址。回调地址是 `localhost` 时,要同时监听 IPv4 和 IPv6 的 loopback。
- **远程或无头部署**:浏览器和核心进程不在同一台机器(远程 webui、NAS、Docker),回调到不了核心进程。这时让用户把浏览器地址栏里的回调 URL 粘贴回界面。这条路径必须实现。
- **公网回调**:用自己的 client ID 时,可以另外登记一个公网 HTTPS 回调地址,远程添加账号就不用粘贴。放到后期再做。

## 6. 安全

暴露的端口背后是所有邮箱的凭据,所以安全要求比普通本地工具高。

| 项 | 要求 |
|---|---|
| 监听地址 | 按 2026-11-11 的部署要求,默认监听 `0.0.0.0`,启动前必须设置有效主密码;可显式限制为 `127.0.0.1` |
| 本机鉴权 | 只监听本机也要登录,并校验 `Host` 和 `Origin` 头,防 DNS rebinding 和跨站请求 |
| 登录会话 | `HttpOnly` + `SameSite=Strict` 的 cookie,HTTPS 入口加 Secure;登录密码用 scrypt 哈希;会话摘要持久保存,7 天到期 |
| 远程访问 | 优先 Tailscale 或 WireGuard 这类私有网络 |
| HTTPS | 可选:反向代理终止 TLS,或应用读取 PEM 证书;HTTP 不保护密码和会话的传输,公网建议 HTTPS,不强制 TOTP 或 passkey |
| 邮件 HTML | 先用 DOMPurify 清洗,再放进不带 `allow-scripts` 和 `allow-same-origin` 的 sandbox iframe |
| 远程图片 | 默认不加载,或走核心进程的图片代理,防追踪 |
| 凭据存储 | refresh token、授权码、密码一律用 AES-256-GCM 加密后落盘 |
| 主密钥 | 无壳模式由启动口令或环境变量派生;套了 Electron 后改用它的 `safeStorage`(底层是系统钥匙串) |

## 7. 实现要点

### 同步与通知

- **新邮件通知**:IMAP IDLE 只盯收件箱,其余文件夹和原生 API 后端用定时轮询。Gmail 的 Pub/Sub 推送和 Graph 的 webhook 都需要公网回调,不用。
- **断点续传**:电脑会休眠和关机,同步的每一步都要能中断后继续,唤醒后自动追赶。
- **多端一致**:本机窗口和远程 webui 都是同一个 API 的客户端,状态变化通过 SSE 广播。
- **全天可访问**:需要时把同一个程序部署到 NAS 或 VPS,不需要改代码。

### ImapFlow 已覆盖的需求

以下几项已对照 ImapFlow 文档确认,不需要自己实现:

| 需求 | ImapFlow 选项 |
|---|---|
| OAuth2 登录(Gmail、Outlook) | `auth.accessToken` |
| 账号级代理 | `proxy`,支持 SOCKS 和 HTTP CONNECT |
| IMAP `ID` 命令(163 需要) | `clientInfo`;只在服务器声明支持 ID 扩展时发送 |
| 新邮件监听 | 连接空闲时自动进入 IDLE |
| 服务器掐断长时间 IDLE | `maxIdleTime`,定期重启 IDLE |
| 增量同步 | 默认 CONDSTORE,`qresync` 选项可切到 QRESYNC |

### 中文搜索

- FTS5 的默认分词不切中文。内置的 trigram 分词器要求查询至少 3 个字符,"发票""合同"这类两字词查不到,不能作为主方案。
- 做法:入库前在应用层把连续的中日韩文字切成重叠的二元组(「电子发票」切成「电子 子发 发票」),其他文字原样保留,交给默认分词器。查询时用同样的切法,拼成短语查询。
- 单字查询另行处理(例如回退到 `LIKE`)。
- 索引表只存切分后的文本,原文另存。

### 邮件处理

- **会话聚合**:IMAP 没有线程 ID,要按 `Message-ID`、`References`、`In-Reply-To` 自己聚合。Gmail 可直接用它的 thread ID。
- **Gmail 走 IMAP 时的重复邮件**:Gmail 把标签映射成文件夹,同一封邮件会出现在多个文件夹里,要用 `X-GM-MSGID` 去重。
- **已发送副本**:Gmail 和 Outlook 发信后会自动保存,其他邮箱要自己 `APPEND` 到已发送文件夹。处理错了会重复或缺失。
- **字符集**:国内邮箱的老邮件常见 GBK、GB18030 编码,解析后要抽样检查有没有乱码。

### 进程模型

- 同步和 API 先放在同一个进程。IMAP 是 I/O 密集型,单个事件循环够用。
- better-sqlite3 是同步接口,慢查询会卡住事件循环。查询要走索引,大批量写入要分批提交。
- 大邮件解析、建索引这类 CPU 重的工作,扛不住时再挪到 `worker_threads`。

## 8. 对私有协议和逆向的立场

**默认不做。** 标准协议加三家官方 API 已经覆盖绝大多数邮箱。逆向私有协议只能多拿到推送、撤回、超大附件这类特色功能,代价是签名和设备风控、协议随时变、账号可能被封,还要长期维护。

| 情况 | 处理 |
|---|---|
| Proton、Tuta 没有标准协议 | 客户端开源,读源码或用现成的库,不需要逆向 |
| QQ、网易的私有接口 | 后期可做成可选插件,与核心隔离;要做就先分析网页版接口,比 App 容易 |
| 管理员禁了 IMAP 的企业邮箱 | 不做。走网页接口属于绕过公司策略 |

如果项目公开发布,伪装官方客户端的适配器有服务条款和法律风险,应做成独立插件,不放进主仓库。

## 9. 路线图

| 阶段 | 内容 | 完成后能做什么 |
|---|---|---|
| 1 | 通用 IMAP/SMTP 适配器、本地库、统一收件箱、搜索、基本读写界面、本机登录 | 接入 QQ、163、iCloud、Yahoo、自建邮箱,以及用应用专用密码的 Gmail |
| 2 | IMAP 加 XOAUTH2;本机回调和粘贴回调两种授权流程;预置 client ID 和设置里的修改入口 | 接入 Gmail 和 Outlook,不用写新适配器 |
| 3 | 全网卡监听、可选 HTTPS、持久会话、多端重连;之后做 PWA、通知及可选两步验证 | 小主机常驻,手机和电脑使用同一个 Web 界面 |
| 4 | 原生适配器:Gmail API、Microsoft Graph、JMAP | 按需做,换取更好的标签支持和同步效率 |
| 5 | Proton sidecar、Electron 桌面壳、私有协议插件 | 按需做 |

## 10. 参考项目

| 项目 | 参考点 |
|---|---|
| `postalsys/emailengine` | 把 IMAP、Gmail API、Graph 统一成 REST 的自部署网关,同样基于 ImapFlow,后端设计最接近本方案(商业许可,源码可读) |
| `Foundry376/Mailspring` 及其同步引擎 | 本地数据模型、同步引擎与界面分离 |
| `nylas/sync-engine` | 已归档,同步引擎设计的经典参考 |
| Syncthing | 本地常驻进程 + Web 界面的鉴权、CSRF、Host 校验 |
| Mailpile | 与本方案形态几乎相同的先例(本地进程 + 浏览器界面)。原版已冻结,重写版 moggie 还不可用,只看设计和教训 |
| Proton Bridge | 本地常驻进程、钥匙串存凭据、托盘交互 |
| `Mail-0/Zero` | 现代 webmail 的界面和交互,同为 TypeScript + React |
| `cypht-org/cypht` | 定位是多账号聚合 webmail,可参考功能边界 |
| Roundcube、SnappyMail | IMAP 兼容性处理、HTML 邮件清洗 |
| Thunderbird | ISPDB 自动配置库、OAuth 预置值、各家邮箱的怪癖处理 |
| `emersion/hydroxide` | 开源的 Proton 桥接程序,可作 sidecar |

## 11. 未决事项

没有待定的设计决策。下面几项要等有了代码和账号才能确认:

| 事项 | 目前掌握的情况 |
|---|---|
| 用预置的 Thunderbird client ID 完成授权 | 已解决:2026-11-11 用 Gmail 和 Outlook 的真实账号走通,`http://127.0.0.1:端口` 回调在两家都可用。Microsoft 365 组织账号尚未测试 |
| 163 / 126 的 `ID` 命令 | 其他基于 ImapFlow 的项目已用真实账号测通,本项目接入时再测一次 |
| QQ 邮箱默认只同步最近 30 天 | 凭印象,需要实测并写进接入说明 |
| 两份 OAuth 教程的步骤 | 按官方文档写成,没有实际走一遍;权限添加一步的菜单位置尤其需要核对 |

## 附录:政策依据

查证日期均为 2026-11-10。

**Google**

- [Manage App Audience](https://support.google.com/cloud/answer/15549945?hl=en):Testing 状态授权 7 天过期;未验证应用终身累计 100 个用户上限。
- [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification):安全评估的触发条件是数据经过或存放在第三方服务器。
- [Configure OAuth consent](https://developers.google.com/workspace/guides/configure-oauth-consent)、[Create credentials](https://developers.google.com/workspace/guides/create-credentials):教程步骤的来源。

**Microsoft**

- [Authenticate an IMAP, POP or SMTP connection using OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth):权限字符串;对 Microsoft 365 和 Outlook.com 都适用。
- [Redirect URI best practices and limitations](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url):localhost 回调忽略端口;门户不能直接登记 `http://127.0.0.1`。
- [Register an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app):注册步骤和前置条件。
- [Publisher verification overview](https://github.com/MicrosoftDocs/entra-docs/blob/main/docs/identity-platform/publisher-verification-overview.md):未验证发布者的应用在工作或学校账号下需要管理员同意。
- [EWS retirement update (MC1227454)](https://mc.merill.net/message/MC1227454):EWS 2026-10-01 起分阶段停用,2027-04-01 彻底关闭。
- [Basic Auth for SMTP AUTH retirement (MC786329)](https://mc.merill.net/message/MC786329):现有租户 2026 年 12 月底默认关闭密码登录,最终日期 2027 年下半年公布。

**Thunderbird**

- [OAuth2Providers.sys.mjs](https://raw.githubusercontent.com/mozilla/releases-comm-central/master/mailnews/base/src/OAuth2Providers.sys.mjs):预置的 client ID、权限和各服务商配置。
- [OAuth2.sys.mjs](https://raw.githubusercontent.com/mozilla/releases-comm-central/master/mailnews/base/src/OAuth2.sys.mjs):默认回调地址 `http://127.0.0.1`,用本地监听接收回调。

**其他**

- [ImapFlow 文档](https://imapflow.com/docs/api/imapflow-client):`proxy`、`auth.accessToken`、`clientInfo` 等选项。
- [n8n PR #40294](https://github.com/n8n-io/n8n/pull/40294):用 ImapFlow 的 `clientInfo` 解决 163 的 Unsafe Login,有真实账号测试。
- [mailpile/moggie](https://github.com/mailpile/moggie):Mailpile 重写版的现状。
