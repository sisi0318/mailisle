# 部署与远程访问

信屿作为一个服务运行在小主机上，手机和电脑连接同一地址，共享邮箱、已读状态、星标、文件夹和已保存草稿。无需在每台设备单独添加邮箱。一个实例只有一个主人；登录后拥有该实例全部邮箱的访问权。

## 直接运行：先让局域网可用

1. 按 README 安装依赖并执行 `pnpm build`。
2. 将 `.env.example` 复制为 `.env`，设置自己的主密码。至少 12 个字符，示例密码不能用于对外监听。
3. 执行 `pnpm start`，保持进程运行。
4. 本机访问 `http://127.0.0.1:3000`；其他设备访问 `http://小主机IP:3000`。

默认 `MAIL_HOST=0.0.0.0` 监听所有 IPv4 网卡。需要 IPv6 时可设为 `::`；只通过本机反向代理访问时可设为 `127.0.0.1`。系统防火墙需要允许对应端口。应用不会自动修改防火墙或路由器；外网还需已有的 VPN、隧道或端口转发。远程添加 OAuth 邮箱使用粘贴回调网址，无需开放临时回调端口。

IP 地址直连不需要额外白名单，Docker 端口映射后的 IP 地址也可使用。通过域名或局域网主机名访问时设置：

```dotenv
MAIL_PUBLIC_URL=http://mail.example.com:3000
```

填写浏览器实际访问的源，包括协议和非默认端口，不包含子路径或账号密码。应用保留来源校验，拒绝未配置的 DNS 主机名及跨站 API 请求。

HTTP 不加密登录密码、会话或邮件。HTTPS 可选；接口需要登录并不能替代传输加密。在不可信网络或公网使用时，建议选择下面一种 HTTPS 方式。

## 可选 HTTPS：由反向代理提供

已有 Nginx、Caddy、NAS 反向代理或 Tailscale Serve 时，可以继续让应用使用 HTTP。配置：

```dotenv
MAIL_HOST=127.0.0.1
MAIL_PORT=3000
MAIL_PUBLIC_URL=https://mail.example.com
```

反向代理应保留原始 `Host`，将请求转发到 `http://127.0.0.1:3000`，并允许 `/api/events` 持续流式传输。应用根据明确配置的访问地址为登录 cookie 设置 `Secure`，不信任请求自行声明的 `X-Forwarded-Host` 或 `X-Forwarded-Proto`。

Caddy 配置示例（域名应指向这台主机，并满足 Caddy 的证书签发条件）：

```caddyfile
mail.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

如果使用 Nginx，给事件接口关闭代理缓冲并提高读取超时，例如 `proxy_buffering off` 和 `proxy_read_timeout 1h`。Nginx 默认不保留原始 Host，需要显式写上：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

登录限速按客户端地址计数。反向代理和信屿在同一台主机时，信屿从 `X-Forwarded-For` 的最后一项读取客户端地址；代理不追加这个头的话，所有访问者会共用一个计数。Caddy 默认会追加。

应用自己不发送 HSTS 响应头：它对整个主机名的所有端口生效，会让同一主机上其他仍用 HTTP 的服务打不开。需要时在反向代理上为专用域名开启。

参考：[Caddy 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)。

## 可选 HTTPS：应用直接读取证书

准备与访问域名匹配的 PEM 证书和私钥，然后设置：

```dotenv
MAIL_HOST=0.0.0.0
MAIL_PORT=3000
MAIL_PUBLIC_URL=https://mail.example.com:3000
MAIL_TLS_CERT=certs/fullchain.pem
MAIL_TLS_KEY=certs/privkey.pem
```

两个路径必须一起设置，可以是绝对路径，也可以相对于启动目录。启动后此端口只接受 HTTPS；证书更新后重启进程。应用不负责签发或续期证书。`certs/` 已被 Git 忽略，不要提交私钥。

## Docker

仓库提供多阶段 Dockerfile 和 Compose 配置，不需要安装宿主机 Node.js。运行：

```sh
# 先复制并编辑 .env，设好自己的主密码
docker compose up -d --build
docker compose logs -f mailisle
```

默认发布 3000 端口并使用具名数据卷 `mailisle-data`。设置 `MAIL_PORT` 可以同时调整应用端口与映射端口。只希望把 Docker 端口发布到宿主机本地时，在 `.env` 增加 `MAIL_BIND_IP=127.0.0.1`；容器内的 `MAIL_HOST` 仍应保持 `0.0.0.0`。

可选证书目录 `./certs` 以只读方式挂载到容器 `/app/certs`。需要应用 HTTPS 时使用上述相对证书路径。证书由宿主机反代提供时，保持证书变量为空。

启动策略为 `unless-stopped`。小主机需要将 Docker 服务设置为开机启动。更新代码后重新执行 `docker compose up -d --build`，数据卷及有效登录会话会保留；不要用 `docker compose down -v` 做普通更新，该命令会删除数据卷。

容器内的 `127.0.0.1` 指向容器本身，邮箱代理若运行在宿主机，应使用容器可达的宿主机地址。Docker Desktop 可按其网络配置使用 `host.docker.internal`。

当前开发环境没有 Docker 引擎；构建文件仍需在目标 Docker 主机上完成镜像构建与运行验收。

## 不用 Docker 时的开机自启

Linux 可用 systemd，以下示例假设代码在 `/opt/mailisle`、Node 位于 `/usr/bin/node`，且已有专用的 `mailisle` 用户。请按实际安装路径修改：

```ini
[Unit]
Description=MailIsle
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mailisle
WorkingDirectory=/opt/mailisle
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

将文件保存为 `/etc/systemd/system/mailisle.service`，确认运行用户可以读取 `.env` 并写入数据目录后执行 `sudo systemctl daemon-reload` 和 `sudo systemctl enable --now mailisle`。进程会从工作目录读取 `.env`。

Windows 可在任务计划程序中创建启动任务：程序使用实际的 `node.exe` 路径，参数为 `apps/server/dist/index.js`，起始目录为仓库根目录，并配置失败后重启。需要未登录时也运行则选择对应选项，并使用有权访问数据目录的 Windows 账号。

## 运维与备份

### 版本与更新

侧栏显示项目版本，点击它或进入「设置 → 更新设置 → 查看版本与更新」可手动检查。检查使用已保存的渠道和代理选择，不会发送邮箱地址、账号凭据或邮件内容，也不会自动安装或重启。

自动检查默认关闭。开启后，定时模式由服务端后台执行（关闭网页不影响），“每次打开网页”模式在登录后触发；检查配置和最近记录保存在数据库，失败也会记录时间以避免频繁重试。

检查渠道分别对应 GitHub 正式发布、预发布（CI 版）和 main 分支源码提交，依据 [GitHub Releases API](https://docs.github.com/en/rest/releases/releases#list-releases) 区分正式版与预发布。仓库尚未发布对应版本时会明确提示，不会把源码提交当作发行版。默认渠道为源码提交。「使用全局代理」只影响更新请求，未配置全局代理时直接连接。

源码构建会记录当时的 Git 提交和构建时间。以后即使只拉取了新源码，正在运行的旧构建仍报告自己的提交，便于确认更新是否真正生效。没有提交信息时会明确显示“无法判断”，不会误报已经是最新。GitHub 限流或网络不通时可稍后重试。

更新 Node 部署时，停止旧服务后在项目目录执行：

```sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

只运行 `git pull` 不会更新 `dist` 中的前端或后端产物。构建并重启后再刷新浏览器。

Docker 构建上下文不包含 `.git`；要准确比较提交，可在构建时传入 `MAIL_BUILD_REVISION`。例如 PowerShell：

```powershell
$env:MAIL_BUILD_REVISION = git rev-parse HEAD
docker compose up -d --build
```

也可以把完整的 40 位提交号写到 Compose 使用的 `.env` 中。该值在构建时写入程序，单纯修改运行环境不会改变已有构建的版本身份。

### 全局代理

全局代理供选择“继承全局”的邮箱使用（覆盖 IMAP、SMTP 及 OAuth 令牌请求），版本检查可在「更新设置」中独立开关；浏览器打开授权页仍走浏览器自身的代理配置。

代理地址的主机是从信屿服务所在环境访问的。例如 Docker 内的 `127.0.0.1` 是容器自身，本机邮件桥接通常应选择不使用代理。修改全局代理会重新连接继承它的邮箱，但不更改独立代理或直连邮箱。

### 已有实例修改主密码

主密码也用于加密邮箱凭据，不能只编辑 `.env` 后直接重启。Node 部署可先停止信屿，再在仓库根目录执行：

```sh
pnpm password
```

命令会要求输入两遍新密码，输入不回显。也可以运行 `pnpm password --generate` 生成强随机密码并写入本机 `.env`，密码不会打印在终端。命令依赖生产构建，新下载代码时先执行 `pnpm build`。

换密会重新加密已有账号及 OAuth 客户端凭据，更新 `.env`，并撤销旧登录会话；邮件、草稿和账号 ID 保留。修改前自动把数据库及旧 `.env` 备份到数据目录的 `backups/password-时间戳`。主机目录与数据库文件必须可写，旧主密码必须能解密当前数据。确认新密码可用后，备份也需要按邮件数据同样保护。

命令会检查配置端口是否仍在监听。已有示例主密码的旧实例可暂设 `MAIL_HOST=127.0.0.1` 并移除外部 `MAIL_PUBLIC_URL` 完成本机换密后再恢复。写入 `.env` 的新密码使用单引号包裹，防止 Docker Compose 展开 `$`。Docker 部署需先停容器，在能同时访问数据目录与宿主机 `.env` 的 Node 环境中执行迁移后再启动容器。

### 备份与恢复

- 备份前先停止服务，再完整备份 `MAIL_DATA_DIR`（Docker 中对应数据卷）及 `.env` 中的主密码。不要只复制运行中的 SQLite 主文件而遗漏 WAL。
- 恢复时使用与该备份配套的主密码。数据库、正文及附件目录本身不做整盘加密，应保护备份的访问权限。
