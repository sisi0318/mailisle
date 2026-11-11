# 信屿 · MailIsle

信屿是一个在自己的电脑上运行的多邮箱客户端。一个 Node.js 进程负责同步、SQLite 本地索引、HTTP API 和浏览器界面。设计见 [DESIGN.md](DESIGN.md)，项目仓库为 [sisi0318/mailisle](https://github.com/sisi0318/mailisle)。

已实现第 1 阶段主要功能与第 2 阶段 OAuth：通用 IMAP/SMTP、本机登录、统一收件箱、正文预取、中文搜索、附件发信、本地草稿、回复转发，以及 Google/Microsoft XOAUTH2。QQ 已验证同步与正文预取；Google/Microsoft 的真实账号授权和组织策略兼容性仍待验收。

## 启动

需要 Node.js 22.12 或更新的 LTS 版本，以及 pnpm 10。当前验证环境为 Windows、Node.js 22.22.2。

在仓库根目录执行：

```powershell
pnpm install
Copy-Item .env.example .env
```

编辑 `.env`，把 `MAIL_MASTER_PASSWORD` 改为自己的长密码（至少 12 个字符），然后：

```powershell
pnpm build
pnpm start
```

打开 <http://127.0.0.1:3000>，使用同一个密码登录，点击「连接邮箱」。账号保存前会验证 IMAP 和 SMTP 登录；默认使用 TLS，也支持强制 STARTTLS。本机 Bridge 和测试服务器可以显式选择明文连接。

`.env` 和本地数据已加入 `.gitignore`。首次启动后必须继续使用原来的主密码，否则无法解密已有凭据；当前没有密码修改或找回界面。浏览器登录会话保存在内存中，重启服务后需要重新登录。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MAIL_MASTER_PASSWORD` | 必填 | 主密钥派生口令，同时作为首次登录密码 |
| `MAIL_PORT` | `3000` | HTTP 监听端口 |
| `MAIL_DATA_DIR` | `.data` | SQLite、正文与附件存储目录 |

当前只允许监听 `127.0.0.1`。远程访问开关和多因素验证按设计留到第 3 阶段。

## 开发

在两个终端中分别运行：

```powershell
pnpm dev
```

```powershell
pnpm dev:web
```

打开 <http://127.0.0.1:5173>。Vite 将 `/api` 代理到本机 3000 端口；开发时保留默认 API 端口。`pnpm dev` 开启源码监听和开发 Origin 白名单。

```powershell
pnpm check
pnpm test
pnpm build
```

## 当前行为

- 添加账号时可自动识别 QQ、163、126、Yeah、Gmail、iCloud、Yahoo、Outlook 的常见邮箱后缀，预填服务器；工作或学校邮箱可手动选择 Microsoft 365。Gmail 可选 OAuth 或应用专用密码，Outlook/Microsoft 365 使用 OAuth。
- 「在线查找服务器」会向 Thunderbird ISPDB 查询邮箱域名，不发送完整邮箱地址或凭据。只选加密 IMAP/SMTP 配置，未找到或网络失败时保留手动配置入口。OAuth 支持 Google 和 Microsoft 的标准邮件端点。
- OAuth 授权提供随机端口本机回调和粘贴完整回调地址两种方式，不使用 Google OOB。自定义 Microsoft 客户端的 localhost 回调同时监听 IPv4/IPv6。授权会话有效 10 分钟，绑定当前浏览器登录会话；关闭连接窗口或退出登录会取消授权。
- 侧栏的「OAuth 客户端设置」可覆盖服务商默认值，连接邮箱时也可单独指定客户端。预置值集中在 `packages/core/src/oauth-presets.ts`，可直接移除对应条目；授权前明确提示 Mozilla Thunderbird 名称和可能失效的风险。教程：[Google](docs/oauth-google.md)、[Microsoft](docs/oauth-microsoft.md)。
- OAuth 只申请邮件协议权限和必要的离线访问。客户端 secret、访问令牌、刷新令牌加密保存；访问令牌到期前一分钟刷新，同账号并发刷新合并，轮换后的刷新令牌立即落盘。修改默认客户端后已有账号继续使用授权时的配置，需到「邮箱设置」重新授权才能更换。
- 账号展开后可进入「邮箱设置」修改参数，原密码和代理认证信息不会回传。密码留空保留；主密码框填入新值会同时更新收发信密码，发信密码可另填。先验证新配置，通过后再替换连接。更换 IMAP 服务器、端口或登录名会重建该账号的本地邮件索引，本地草稿保留。
- 多账号收件箱、账号文件夹、星标列表、跨账号搜索和分页虚拟滚动。侧栏显示未读数，跨标签同一邮件不重复计数；窄屏通过可关闭的导航抽屉切换账号和文件夹。
- 同步所有可选择的文件夹，收件箱用独立连接 IDLE，所有文件夹每分钟轮询。只对本地尚无映射的 UID 拉取信封/引用头，已有邮件只取标记；支持 CONDSTORE 时再用 MODSEQ 缩小标记查询。没有 CONDSTORE 时仍需核对 UID 和标记，但不会重复解析信封、聚合会话或重建全文索引。每批最多 200 封，批次之间释放邮箱锁，文件夹完整成功后才推进游标。调整 QQ 收取范围后出现的较旧 UID 也能补回。
- 每账号复用一条业务 IMAP 连接，另有一条收件箱 IDLE 连接。业务连接连续 90 秒无网络活动时超时，长于 60 秒轮询间隔；断线后下一次操作重连，已提交的操作不会自动重放。同步期间的新通知会合并为紧接着的一轮补同步。
- SEARCH 失败，或返回空列表但服务器仍报告有邮件时，本轮同步报错并保留对应文件夹的本地邮件、位置、搜索索引和游标；只有查询成功后才处理 UIDVALIDITY 变化和删除核对。
- UIDVALIDITY 变化时重建 UID 映射。支持服务端邮件删除、文件夹移除和 Gmail `X-GM-MSGID` 去重。按 Message-ID / References / In-Reply-To 聚合会话，已有服务商线程 ID 时直接使用。
- 主题与收发件人同步后即可搜索；后台按新到旧预取正文，逐步补全预览和正文全文索引。只取正文 MIME 部分，不预先下载普通附件，不改变未读标记。预取使用独立连接，每账号一个任务、每 20 封通知一次界面；退出后下次启动继续，单封失败会继续处理后面的邮件并在下一轮重试。预览会去掉链接噪声，原文仍保留供搜索。
- 正文预取只用于预览和搜索；完整阅读内容、附件仍在打开邮件时缓存到磁盘，完整缓存可离线阅读。支持两字中文、长中文短语和单字查询。单字与纯标点使用原文子串匹配，普通查询使用 FTS5 短语搜索。
- HTML 经 DOMPurify 清洗后放入 sandbox iframe，保留发件人的排版样式，但样式中引用外部资源的声明会被删除，远程图片默认屏蔽。`<img src="cid:…">` 可显示本地 PNG/JPEG/GIF/WebP 附件；图片以 data URL 内嵌，不放宽正文框的网络策略。已嵌入的图片不重复列在附件栏，未引用的图片及 SVG 等其他格式保留为下载附件。旧 CID 缓存先立即显示，再后台补齐图片元数据，失败时仍可读旧缓存。
- 支持已读、星标、移动、归档和移到垃圾箱。服务器确认后直接更新本地状态并通过 SSE 通知，操作不等待全账号同步。移动返回 UIDPLUS 映射时保留邮件 ID、正文缓存和搜索索引；未返回映射时先移除原位置并后台补同步目标位置。不提供脱机操作队列或永久删除按钮。
- 富文本写信、回复（优先 Reply-To）、全部回复、转发、抄送和密送。引用原文使用转义后的纯文本，日期按浏览器时区显示；全部回复会去重并排除已连接邮箱地址。转发默认携带原附件（内嵌图片作为文件），也可选择仅转发正文。
- 支持附件上传和下载，最多 20 个、总计不超过 20 MiB。附件按随机 ID 存盘，文件名不用于本地路径。未保存且不再引用的临时附件在创建 24 小时后，由启动及每小时清理任务回收。
- 写信时可保存「本地草稿」，关闭有修改的编辑器会询问是否保存；也可明确丢弃。草稿和附件保存在本机服务，可在其他已登录设备上继续编辑，**不会同步到邮箱服务商的草稿箱**。发送前先保存，SMTP 失败保留草稿，接受后删除该草稿与不再引用的上传附件。
- 一般邮箱 APPEND 已发送副本；服务商自动保存时，在账号设置中选择「服务商会自动保存」。SMTP 已接受但副本或草稿清理失败会单独提示，不自动重发。
- IMAP、SMTP 和 OAuth 令牌请求共享账号代理设置，分别建立代理连接。支持 HTTP CONNECT 和 SOCKS5。浏览器访问授权页的代理由浏览器配置。ImapFlow 启用客户端 ID 信息。
- 登录使用 scrypt、HttpOnly / SameSite=Strict 会话 cookie；检查 Host / Origin，限制重复登录尝试。邮箱配置整体使用 AES-256-GCM 加密后保存。

SQLite 邮件、草稿和磁盘正文、附件未做整库加密。完整邮件缓存暂未实现容量上限和孤立文件回收；移除账号会删除本地索引与该账号的本地草稿，已下载的邮件缓存暂时保留。

QQ 如果只能同步近期邮件，请在网页版设置的 POP3/IMAP/SMTP 相关选项中检查「收取选项」，将时间范围改为「全部」并保存，再回本应用同步。客户端只能收取 QQ 通过 IMAP 提供的邮件；UIDNEXT 不是邮件数量，不能据此判断漏信。QQ 返回的 `\\NoSelect` 分类节点会被跳过，其下可选择的子文件夹仍会同步。

## 协议集成测试

使用设计指定的 GreenMail，不连接真实邮箱。测试账号、密码仅用于隔离测试服务。

集成测试包含真实 TCP 故障代理：注入 SEARCH 的 NO/BAD/异常空结果，并模拟静默断链。测试注入 2 秒超时以缩短运行时间，单元测试另外断言生产默认值仍为 90 秒。OAuth 测试使用临时本机 HTTP 授权服务器和 SASL 邮件端点，覆盖 PKCE、state、回调、刷新轮换、撤销、会话隔离、XOAUTH2 和发信失败不重放。

```powershell
docker compose -f compose.test.yaml up -d
pnpm test:integration
docker compose -f compose.test.yaml down
```

也可以从 [GreenMail 官方发布](https://greenmail-mail-test.github.io/greenmail/#download) 获取 `greenmail-standalone-2.1.15.jar`，使用 Java 11+ 在另一个终端运行：

```powershell
java '-Dgreenmail.smtp.hostname=127.0.0.1' '-Dgreenmail.smtp.port=3025' `
  '-Dgreenmail.imap.hostname=127.0.0.1' '-Dgreenmail.imap.port=3143' `
  '-Dgreenmail.users=alice:test-password@example.com,bob:test-password@example.com' `
  '-Dgreenmail.users.login=email' -jar greenmail-standalone-2.1.15.jar
```

集成测试覆盖：收取 MIME、正文和附件缓存、正文检索、重复同步、标记、移动与删除、SMTP 投递、单份已发送副本以及 IDLE 通知。数据库测试覆盖 UIDVALIDITY 变化、跨标签去重、乱序会话聚合和 SQLite 重开恢复。

同步优化的回归检查还覆盖：无 CONDSTORE 时不重复取信封、旧 UID 补回、连接复用与断线重连、批次间让出连接处理标记操作、通知合并补同步、UIDPLUS 移动与进行中扫描交错、旧数据库迁移。会话引用使用独立的索引表，FTS5 更新/删除通过稳定的整数行号定位。

正文预取测试覆盖单段 GB18030、纯 HTML、嵌套多段 MIME、附件排除、未读状态不变、任务取消恢复、失败重试及前后台连接分离。CID 测试覆盖缓存元数据、认证后的图片数据、附件强制下载和旧缓存升级；浏览器验收检查图片解码、未引用附件保留、脚本/表单删除与外链图片/CSS 零访问。列表查询只取预览等元数据，不加载整篇正文。

账号与写信测试覆盖凭据不回传、留空保留密码、无效配置不替换旧账号、切换 IMAP 身份重建索引、草稿重启恢复、附件字节一致性、上传大小限制、失败保留草稿、接受后清理、回复去重和原文转义。浏览器验收覆盖保存/重开/发送草稿、转发附件、未读反馈和手机抽屉切换账号。

2026-11-10 在同一 Windows / Node.js 22 环境，以独立线程的合成邮件测量内存 SQLite 元数据入库：5,000 封从约 4.2 秒降至 1.7 秒，30,000 封约 10.3 秒；200 封一批，最大批次约 95 毫秒。这是本地入库耗时，不包含网络下载和正文解析，也不是生产环境响应时间保证。

## 接下来

- 继续验证 QQ 发信，以及 163、iCloud 等实际账号的兼容性。
- 完善第 1 阶段：完整邮件缓存容量管理和 Docker 应用镜像；另有 CONDSTORE 无变化跳过、用户操作更短期限等优化。
- 用真实 Google / Microsoft 账号验收首次授权、长期刷新和重新授权；组织账号还需验证管理员策略、IMAP 和 SMTP AUTH 开关。

源代码按 `apps/server`、`apps/web`、`packages/core`、`packages/db`、`packages/shared` 分层。SQL 迁移位于 `packages/db/migrations`；表结构变更同步修改 Drizzle schema，并新增顺序编号的迁移文件。生产构建会复制迁移文件到服务端产物目录。

预设参数集中在 `packages/shared/src/providers.ts`，2026-11-10 核对来源：[Thunderbird ISPDB](https://github.com/thunderbird/autoconfig/tree/master/ispdb)、[Google](https://developers.google.com/workspace/gmail/imap/imap-smtp)、[Apple](https://support.apple.com/102525)、[Yahoo](https://help.yahoo.com/kb/SLN4075.html)、[Microsoft](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com)。
