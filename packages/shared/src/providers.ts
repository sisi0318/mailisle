import type { AccountInput } from './index';

type ServerPreset = Pick<AccountInput['imap'], 'host' | 'port' | 'security'>;
export type ProviderPreset = {
  id: string;
  name: string;
  domains: string[];
  imap: ServerPreset;
  smtp: ServerPreset;
  sentCopy: AccountInput['sentCopy'];
  passwordLabel: string;
  hint: string;
  helpUrl: string;
  requiresOAuth?: boolean;
};

// Parameters checked against provider documentation / Thunderbird ISPDB on 2026-11-10.
export const providerPresets: ProviderPreset[] = [
  {
    id: 'qq', name: 'QQ 邮箱', domains: ['qq.com', 'vip.qq.com', 'foxmail.com'],
    imap: { host: 'imap.qq.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.qq.com', port: 465, security: 'tls' },
    sentCopy: 'append', passwordLabel: '客户端授权码',
    hint: '请先在 QQ 邮箱设置中开启 IMAP/SMTP，并生成客户端授权码。如只显示近期邮件，请检查网页版的「收取选项」，需要历史邮件时选择「全部」。',
    helpUrl: 'https://service.mail.qq.com/',
  },
  {
    id: '163', name: '网易 163', domains: ['163.com'],
    imap: { host: 'imap.163.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.163.com', port: 465, security: 'tls' },
    sentCopy: 'append', passwordLabel: '客户端授权码',
    hint: '请先在网易邮箱设置中开启 IMAP/SMTP，并生成客户端授权码。',
    helpUrl: 'https://help.mail.163.com/',
  },
  {
    id: '126', name: '网易 126', domains: ['126.com'],
    imap: { host: 'imap.126.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.126.com', port: 465, security: 'tls' },
    sentCopy: 'append', passwordLabel: '客户端授权码',
    hint: '请先在网易邮箱设置中开启 IMAP/SMTP，并生成客户端授权码。',
    helpUrl: 'https://help.mail.163.com/',
  },
  {
    id: 'yeah', name: '网易 Yeah', domains: ['yeah.net'],
    imap: { host: 'imap.yeah.net', port: 993, security: 'tls' },
    smtp: { host: 'smtp.yeah.net', port: 465, security: 'tls' },
    sentCopy: 'append', passwordLabel: '客户端授权码',
    hint: '请先在网易邮箱设置中开启 IMAP/SMTP，并生成客户端授权码。',
    helpUrl: 'https://help.mail.163.com/',
  },
  {
    id: 'gmail', name: 'Gmail / Google Workspace', domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    sentCopy: 'server', passwordLabel: '应用专用密码',
    hint: '可用 Google OAuth 登录，也可在开启两步验证后使用应用专用密码。Workspace 组织账号可能需要管理员批准。',
    helpUrl: 'https://support.google.com/accounts/answer/185833',
  },
  {
    id: 'icloud', name: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    sentCopy: 'append', passwordLabel: 'App 专用密码',
    hint: '请使用 Apple 账户生成的 App 专用密码。使用别名或自定义域名时，在登录名中填写对应的 iCloud 邮箱账号。',
    helpUrl: 'https://support.apple.com/102525',
  },
  {
    id: 'yahoo', name: 'Yahoo Mail', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    sentCopy: 'append', passwordLabel: '应用密码',
    hint: '请在 Yahoo 账户安全设置中生成应用密码。登录名默认使用完整邮箱地址。',
    helpUrl: 'https://help.yahoo.com/kb/SLN4075.html',
  },
  {
    id: 'outlook', name: 'Outlook.com / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'live.cn', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    sentCopy: 'server', passwordLabel: 'OAuth 登录', requiresOAuth: true,
    hint: '请在 Outlook.com 邮件设置中开启 IMAP。',
    helpUrl: 'https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com',
  },
  {
    id: 'microsoft365', name: 'Microsoft 365（工作或学校）', domains: [],
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    sentCopy: 'server', passwordLabel: 'OAuth 登录', requiresOAuth: true,
    hint: '组织管理员需要允许 IMAP、SMTP AUTH 和相应的委托权限。',
    helpUrl: 'https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth',
  },
];

export function detectProvider(email: string): ProviderPreset | undefined {
  const domain = email.trim().toLowerCase().split('@')[1];
  return providerPresets.find(provider => provider.domains.includes(domain));
}
