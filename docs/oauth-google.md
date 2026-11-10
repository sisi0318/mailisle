# 注册自己的 Google OAuth 客户端

本文教你注册一个自己的 Google OAuth 客户端,用来代替本应用内置的默认值连接 Gmail。全程免费,大约 10 分钟。

> 控制台界面会改版,下面的菜单名称以 2026 年 11 月为准。
> 本应用的设置界面还在开发中,第 6 步的入口名称以实际界面为准。

## 什么时候需要

| 情况 | 说明 |
|---|---|
| 内置默认值不能用了 | 默认值借用 Thunderbird 的客户端,可能失效,也可能被你所在的组织拦截 |
| 不想在授权页看到别人的应用名 | 用默认值时,授权页显示的是 Mozilla Thunderbird |
| 要用 Gmail API 方式接入 | 这种方式只支持自己的客户端 |

如果只是个人 Gmail,又不想注册,还有一条更简单的路:开启两步验证后生成"应用专用密码",在本应用里按普通 IMAP 账号添加,不需要 OAuth。

## 步骤

### 1. 新建项目

1. 打开 [Google Cloud Console](https://console.cloud.google.com/),用任意 Google 账号登录。不必是要接入的那个邮箱。
2. 点顶部的项目选择器,选 **New Project**,名称随意,点 **Create**。
3. 确认顶部已经切换到新项目。

### 2. 配置授权页

1. 打开左上角菜单,进入 **Google Auth platform** > **Branding**,点 **Get Started**。
2. **App Information**:**App name** 随意填,它会显示在授权页上;**User support email** 选自己的邮箱。点 **Next**。
3. **Audience**:选 **External**。点 **Next**。
4. **Contact Information**:填一个邮箱。点 **Next**。
5. **Finish**:勾选同意用户数据政策,点 **Continue**,再点 **Create**。

### 3. 声明要用的权限

1. 点 **Data Access** > **Add or Remove Scopes**。
2. 在对话框底部的手动输入框里填入 `https://mail.google.com/`,加入列表后确认。
3. 点 **Save**。

打算用 Gmail API 方式接入的话,还要到 **APIs & Services** > **Library** 里搜索 Gmail API 并点 **Enable**。只用 IMAP 不需要这一步。

### 4. 发布应用

1. 点 **Audience**。
2. 在 **Publishing status** 下点 **Publish app** 并确认,状态变为 **In production**。

不要跳过这一步。停在 Testing 状态时,授权 7 天就过期,每周都要重新登录。

发布不等于提交审核,不需要填任何审核材料。代价有两个,自己用都不成问题:

- 授权时多一个"未验证"的提示页。
- 这个项目累计最多允许 100 个账号授权。额度是终身累计的,不能重置。

### 5. 创建客户端

1. 点 **Clients** > **Create Client**。
2. **Application type** 选 **Desktop app**,**Name** 随意,点 **Create**。
3. 在弹出的窗口里复制 **Client ID** 和 **Client secret**,或者下载 JSON 文件。secret 之后可能无法再次查看,当场存好。

类型必须是 Desktop app。选成 Web application 的话回调地址对不上,授权会失败。

### 6. 填入本应用

1. 打开本应用的设置,找到 OAuth 客户端里的 Google 一项。
2. 填入 Client ID 和 Client secret,保存。
3. 添加 Gmail 账号。之前用默认值添加过的账号要重新授权一次。

### 7. 首次授权

浏览器会显示"Google hasn't verified this app"。出现它是因为应用没有提交审核。应用是你自己的,可以继续:

1. 点 **Advanced**。
2. 点 **Go to <应用名> (unsafe)**。
3. 勾选邮件访问权限,点 **Continue**。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 每隔 7 天要重新登录 | 项目还在 Testing 状态 | 做第 4 步 |
| `Error 403: access_denied`,提示应用未完成验证 | 项目在 Testing 状态,登录的账号又不在测试用户名单里 | 做第 4 步;或在 **Audience** 的 **Test users** 里加上这个账号 |
| `Error 400: redirect_uri_mismatch` | 客户端类型不是 Desktop app | 按第 5 步重新创建 |
| `Error 400: admin_policy_enforced` | 这是 Workspace 账号,管理员限制了第三方应用 | 请管理员把你的 Client ID 加入信任名单 |
| 提示已达到用户上限 | 100 个账号的额度用完了 | 新建一个项目重做 |
