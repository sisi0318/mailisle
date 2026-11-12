# Thunderbird OAuth 配置来源

`packages/core/src/oauth-presets.ts` 中的公开桌面应用配置摘自 Thunderbird 的 `OAuth2Providers.sys.mjs`。原文件采用 MPL-2.0；此摘录文件保留同一许可。MailIsle 的改动是只保留 Google 和 Microsoft 的公开配置值，并改成 TypeScript 导出；没有复制 Thunderbird 的授权流程实现。

- 上游项目：https://www.thunderbird.net/
- 核对来源：https://github.com/mozilla/releases-comm-central/blob/5588847261449eda10be7eca80c98ae0c353e9a1/mailnews/base/src/OAuth2Providers.sys.mjs
- 本项目摘录源码：https://github.com/sisi0318/mailisle/blob/main/packages/core/src/oauth-presets.ts
- 许可全文：本目录 `MPL-2.0.txt`，以及 https://www.mozilla.org/MPL/2.0/

本次构建使用的摘录源码也随网页产物提供为 `legal/oauth-presets.ts.txt`，可直接获取，不依赖外部网站。

上游明确建议其他应用注册自己的 OAuth 客户端，不要复制其客户端值。源码开源许可不等于服务商允许其他应用使用该客户端，也不构成 Mozilla 或 Thunderbird 的授权、合作或背书。保留预置值是兼容行为，不保证它始终可用；对外部署或分发前应自行确认服务商规则，建议在“设置 → 自定义授权应用”中配置自己注册的应用。

本说明只补充出处、许可和使用限制，不会清除或替换已保存的邮箱授权。Thunderbird、Mozilla 等名称和标识的相关权利归各自权利人所有。
