# 注册自己的 Microsoft OAuth 客户端

本文教你在 Microsoft Entra 注册一个自己的应用,用来代替本应用内置的默认值连接 Outlook.com、Hotmail 和 Microsoft 365 邮箱。注册本身免费,大约 10 分钟。

> 管理中心界面会改版,下面的菜单名称以 2026 年 11 月为准。
> 授权页和控制台步骤尚未用真实 Microsoft 账号逐项验收;本机流程已通过本地授权服务器测试。

## 什么时候需要

| 情况 | 说明 |
|---|---|
| 内置默认值不能用了 | 默认值借用 Thunderbird 的客户端,可能失效,也可能被你所在的组织拦截 |
| 不想在授权页看到别人的应用名 | 用默认值时,授权页显示的是 Mozilla Thunderbird |
| 工作或学校账号提示需要管理员批准 | 可以在自己组织的目录里注册应用,再由管理员批准 |
| 要用 Microsoft Graph 方式接入 | 这种方式只支持自己的客户端 |

微软邮箱没有免 OAuth 的退路。个人账号和 Microsoft 365 都已经不能用密码登录 IMAP。

## 准备

- 一个 Microsoft 账号。
- 一个 Azure 账号。个人 Microsoft 账号默认没有可以注册应用的目录,需要先开通 [Azure 免费账号](https://azure.microsoft.com/free/),开通后会自动得到一个 Default Directory。开通时通常要验证手机号和银行卡,注册应用本身不产生费用。

工作或学校账号已经在组织的目录里,但组织可能不允许普通成员注册应用。

## 步骤

### 1. 新建应用注册

1. 登录 [Microsoft Entra 管理中心](https://entra.microsoft.com)。有多个目录时,用顶部的设置图标切换到要用的那个。
2. 进入 **Entra ID** > **App registrations**,点 **New registration**。
3. **Name** 随意填,它会显示在授权页上。
4. **Supported account types** 选 **Any Entra ID Tenant + Personal Microsoft accounts**。这样个人账号和工作、学校账号都能用。
5. 点 **Register**。
6. 在 **Overview** 页复制 **Application (client) ID**。

### 2. 登记回调地址

1. 进入 **Manage** > **Authentication**。
2. 添加平台,选 **Mobile and desktop applications**。按钮在旧版界面叫 **Add a platform**,在新版界面叫 **Add Redirect URI**。
3. 在自定义回调地址里填 `http://localhost`,保存。

只填 `http://localhost`,不带端口,不带路径。微软对 localhost 会忽略端口,所以本应用每次用随机端口也能匹配。不要填 `http://127.0.0.1`,门户的输入框不接受它。

### 3. 添加权限

1. 进入 **Manage** > **API permissions**,点 **Add a permission**。
2. 选 **Microsoft Graph** > **Delegated permissions**。
3. 搜索并勾选下面三项,然后点 **Add permissions**:
   - `IMAP.AccessAsUser.All`
   - `SMTP.Send`
   - `offline_access`

不需要创建 client secret。桌面类应用是公共客户端,只用 Application (client) ID。

### 4. 填入本应用

1. 打开侧栏底部的 **设置**,找到 **Microsoft**。
2. 在 **Client ID** 中填入 Application (client) ID,点 **保存**。这是公共桌面客户端,不需要 secret。
3. 点 **连接邮箱**,选择 **Outlook.com / Hotmail** 或 **Microsoft 365（工作或学校）**。**OAuth 客户端** 保持 **服务商默认** 会使用刚保存的配置。
4. 如只想给这一个邮箱使用不同客户端,选 **仅此邮箱使用自己的客户端**,填写 ID。自定义 Microsoft 客户端自动使用 PKCE 和 `http://localhost:<随机端口>/` 回调;服务在 IPv4、IPv6 回环上同时监听,无需手动设置主机。
5. 选择开启收信、发信或两者,点 **开始 OAuth 授权**,再点 **打开服务商授权页**。授权后应用自动检查连接并保存。检查失败可点 **重试完成连接**。
6. 之前已连接的 OAuth 邮箱,进入该账号的 **邮箱设置**,将客户端切到 **服务商默认**,点 **重新授权**。更改默认值不会自动替换已有账号的客户端。

浏览器和服务不在同一台设备时,授权后可能显示回环地址无法访问。复制地址栏中的完整回调网址,回应用展开 **浏览器在另一台设备，或无法自动回调**,粘贴后点 **提交回调网址**。不要把回调网址分享给他人。使用 Thunderbird 预置值时回调主机为 `127.0.0.1`,自定义客户端为 `localhost`。

令牌请求与邮件连接共用账号代理设置，浏览器授权页走浏览器自身代理；远程部署见[部署说明](deployment.md)。

## 工作或学校账号的额外限制

**需要管理员批准。** 你注册的应用没有"已验证发布者"标记,其他组织的普通成员无法自行同意,会看到 Need admin approval。有两个办法:

- 请该组织的管理员批准这个应用。
- 由该组织的人在他们自己的目录里注册应用,再由管理员在 **API permissions** 页点 **Grant admin consent**。

**协议被关闭。** 组织可以在租户或邮箱级别关闭 IMAP 和 SMTP AUTH。这时授权能成功,连接邮箱会失败,需要管理员开启。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `AADSTS50011`,提示回调地址不匹配 | 回调地址没登记,或登记的不是 `http://localhost` | 检查第 2 步,平台必须是 Mobile and desktop applications |
| Need admin approval | 工作或学校账号不能自行同意未验证发布者的应用 | 见上一节 |
| `unauthorized_client`,提示应用未对个人账号启用 | 注册时账号类型没选包含个人账号的那一项 | 重新注册,第 1 步选对账号类型 |
| 授权成功,但连接邮箱时认证失败 | 邮箱没有开启 IMAP,或组织关闭了相关协议 | 个人账号到 Outlook.com 的邮件设置里检查 IMAP 是否开启;组织账号找管理员 |
