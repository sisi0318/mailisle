# Mail

在自己的电脑上运行的多邮箱客户端。一个 Node.js 进程负责同步、SQLite 本地索引、HTTP API 和浏览器界面。设计见 [DESIGN.md](DESIGN.md)。

目前是第 1 阶段的可运行初版：通用 IMAP/SMTP、本机登录、统一收件箱、中文搜索、阅读和写信。尚未接入真实服务商账号进行兼容性验收。

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

- 添加账号时可自动识别 QQ、163、126、Yeah、Gmail、iCloud、Yahoo、Outlook 的常见邮箱后缀，预填 IMAP/SMTP 服务器、端口、加密方式和已发送副本选项。也可手动选择预设用于自定义域名，所有参数仍可编辑。Outlook 预设暂仅供查看，需待 OAuth 登录实现后才能连接。
- 多账号收件箱、账号文件夹、星标列表、跨账号搜索和分页虚拟滚动。
- 同步所有可选择的文件夹，收件箱用独立连接 IDLE，所有文件夹每分钟轮询。只对本地尚无映射的 UID 拉取信封/引用头，已有邮件只取标记；支持 CONDSTORE 时再用 MODSEQ 缩小标记查询。没有 CONDSTORE 时仍需核对 UID 和标记，但不会重复解析信封、聚合会话或重建全文索引。每批最多 200 封，批次之间释放邮箱锁，文件夹完整成功后才推进游标。调整 QQ 收取范围后出现的较旧 UID 也能补回。
- 每账号复用一条业务 IMAP 连接，另有一条收件箱 IDLE 连接。业务连接连续 90 秒无网络活动时超时，长于 60 秒轮询间隔；断线后下一次操作重连，已提交的操作不会自动重放。同步期间的新通知会合并为紧接着的一轮补同步。
- SEARCH 失败，或返回空列表但服务器仍报告有邮件时，本轮同步报错并保留对应文件夹的本地邮件、位置、搜索索引和游标；只有查询成功后才处理 UIDVALIDITY 变化和删除核对。
- UIDVALIDITY 变化时重建 UID 映射。支持服务端邮件删除、文件夹移除和 Gmail `X-GM-MSGID` 去重。按 Message-ID / References / In-Reply-To 聚合会话，已有服务商线程 ID 时直接使用。
- 主题与收发件人同步后即可搜索；正文在第一次打开后缓存并加入全文索引。支持两字中文、长中文短语和单字查询。单字与纯标点使用原文子串匹配，普通查询使用 FTS5 短语搜索。
- 正文及附件落盘，已缓存内容离线可读。HTML 经 DOMPurify 清洗后放入 sandbox iframe，远程图片默认屏蔽。内嵌 CID 图片暂以附件呈现。
- 支持已读、星标、移动、归档和移到垃圾箱。服务器确认后直接更新本地状态并通过 SSE 通知，操作不等待全账号同步。移动返回 UIDPLUS 映射时保留邮件 ID、正文缓存和搜索索引；未返回映射时先移除原位置并后台补同步目标位置。不提供脱机操作队列或永久删除按钮。
- 富文本写信、回复（优先 Reply-To）、抄送、密送。一般邮箱 APPEND 已发送副本；服务商自动保存时，在添加账号时选择「由服务商保存」。SMTP 已接受但副本保存失败会单独提示，不自动重发。
- IMAP 和 SMTP 共享账号代理设置，分别建立代理连接。支持 HTTP CONNECT 和 SOCKS5。ImapFlow 启用客户端 ID 信息。
- 登录使用 scrypt、HttpOnly / SameSite=Strict 会话 cookie；检查 Host / Origin，限制重复登录尝试。邮箱配置整体使用 AES-256-GCM 加密后保存。

SQLite 邮件内容和磁盘正文、附件未做整库加密。缓存暂未实现容量上限和孤立文件回收；移除账号会删除本地索引，已缓存的磁盘文件暂时保留。

QQ 如果只能同步近期邮件，请在网页版设置的 POP3/IMAP/SMTP 相关选项中检查「收取选项」，将时间范围改为「全部」并保存，再回本应用同步。客户端只能收取 QQ 通过 IMAP 提供的邮件；UIDNEXT 不是邮件数量，不能据此判断漏信。QQ 返回的 `\\NoSelect` 分类节点会被跳过，其下可选择的子文件夹仍会同步。

## 协议集成测试

使用设计指定的 GreenMail，不连接真实邮箱。测试账号、密码仅用于隔离测试服务。

集成测试包含真实 TCP 故障代理：注入 SEARCH 的 NO/BAD/异常空结果，并模拟静默断链。静默超时测试使用实际的 90 秒配置，因此整套集成测试需要约 90 秒。

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

2026-11-10 在同一 Windows / Node.js 22 环境，以独立线程的合成邮件测量内存 SQLite 元数据入库：5,000 封从约 4.2 秒降至 1.7 秒，30,000 封约 10.3 秒；200 封一批，最大批次约 95 毫秒。这是本地入库耗时，不包含网络下载和正文解析，也不是生产环境响应时间保证。

## 接下来

- 用 QQ、163、iCloud 等实际账号验证服务商兼容性。
- 完善第 1 阶段：后台正文预取和预览清理、CID 内嵌图片、ISPDB 在线自动配置（常见服务商已有本地预设）、账号配置修改、附件上传、草稿保存、缓存管理和 Docker 应用镜像。
- 第 2 阶段：Google / Microsoft XOAUTH2、本机回调与粘贴回调流程。现有 [Google](docs/oauth-google.md) / [Microsoft](docs/oauth-microsoft.md) 教程保留为设计资料，对应授权界面尚未实现。

源代码按 `apps/server`、`apps/web`、`packages/core`、`packages/db`、`packages/shared` 分层。SQL 迁移位于 `packages/db/migrations`；表结构变更同步修改 Drizzle schema，并新增顺序编号的迁移文件。生产构建会复制迁移文件到服务端产物目录。

预设参数集中在 `packages/shared/src/providers.ts`，2026-11-10 核对来源：[Thunderbird ISPDB](https://github.com/thunderbird/autoconfig/tree/master/ispdb)、[Google](https://developers.google.com/workspace/gmail/imap/imap-smtp)、[Apple](https://support.apple.com/102525)、[Yahoo](https://help.yahoo.com/kb/SLN4075.html)、[Microsoft](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com)。
