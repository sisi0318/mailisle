import { z } from 'zod';
export { providerPresets, detectProvider } from './providers';
export type { ProviderPreset } from './providers';

export const accountOrderSchema = z.object({
  accountIds: z.array(z.uuid()).min(1).max(1000).refine(ids => new Set(ids).size === ids.length, '邮箱顺序中不能出现重复账号'),
});

export const serverSchema = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[^\s\x00-\x1f\x7f]+$/, '服务器地址不能包含空格或控制字符'),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'plain']).default('tls'),
  user: z.string().trim().min(1).max(320).regex(/^[^\x00-\x1f\x7f]+$/, '登录名不能包含控制字符'),
  password: z.string().min(1).max(4096),
});
const configurableServerSchema = serverSchema.extend({
  host: serverSchema.shape.host.or(z.literal('')), user: serverSchema.shape.user.or(z.literal('')),
  password: serverSchema.shape.password.or(z.literal('')),
});
const emptyImap = { host: '', port: 993, security: 'tls' as const, user: '', password: '' };
const emptySmtp = { ...emptyImap, port: 465 };
export const proxyAddressSchema = z.url().refine(value => ['http:', 'https:', 'socks5:'].includes(new URL(value).protocol), '仅支持 HTTP 或 SOCKS5 代理');
export const globalProxySchema = z.object({ proxy: proxyAddressSchema.nullable() });
export type ProxyMode = 'global' | 'custom' | 'direct';
export type GlobalProxySettings = { configured: boolean; display?: string };

const accountFields = {
  name: z.string().trim().min(1).max(100),
  email: z.email(),
  receiveEnabled: z.boolean().default(true), sendEnabled: z.boolean().default(true),
  imap: configurableServerSchema.default(emptyImap),
  smtp: configurableServerSchema.default(emptySmtp),
  proxy: proxyAddressSchema.optional(),
  proxyMode: z.enum(['global', 'custom', 'direct']).optional(),
  sentCopy: z.enum(['append', 'server']).default('append'),
};
function validateTransportSecurity(account: { receiveEnabled: boolean; sendEnabled: boolean; imap: { host: string; security: string; user: string }; smtp: { host: string; security: string; user: string } }, ctx: z.RefinementCtx) {
  if (!account.receiveEnabled && !account.sendEnabled) ctx.addIssue({ code: 'custom', path: ['receiveEnabled'], message: '请至少开启收信或发信' });
  for (const protocol of ['imap', 'smtp'] as const) {
    if (!(protocol === 'imap' ? account.receiveEnabled : account.sendEnabled)) continue;
    const server = account[protocol];
    if (!server.host) ctx.addIssue({ code: 'custom', path: [protocol, 'host'], message: '请填写服务器地址' });
    if (!server.user) ctx.addIssue({ code: 'custom', path: [protocol, 'user'], message: '请填写登录名' });
    if (server.security === 'plain' && !['localhost', '127.0.0.1', '::1'].includes(server.host)) {
      ctx.addIssue({ code: 'custom', path: [protocol, 'security'], message: '明文连接仅允许本机邮件桥接或测试服务器' });
    }
  }
}
export const accountSchema = z.object(accountFields).superRefine(validateTransportSecurity).superRefine((account, ctx) => {
  for (const protocol of ['imap', 'smtp'] as const) {
    if ((protocol === 'imap' ? account.receiveEnabled : account.sendEnabled) && !account[protocol].password)
      ctx.addIssue({ code: 'custom', path: [protocol, 'password'], message: '请填写密码或授权码' });
  }
});
export const accountUpdateSchema = z.object({ ...accountFields,
  imap: configurableServerSchema.extend({ password: serverSchema.shape.password.optional() }).default({ ...emptyImap, password: undefined }),
  smtp: configurableServerSchema.extend({ password: serverSchema.shape.password.optional() }).default({ ...emptySmtp, password: undefined }),
  proxy: z.union([accountFields.proxy.unwrap(), z.literal('')]).optional(),
}).superRefine(validateTransportSecurity);

export const oauthProviderSchema = z.enum(['google', 'microsoft']);
export const oauthClientSchema = z.object({ clientId: z.string().trim().min(1).max(512), clientSecret: z.string().min(1).max(4096).optional() });
export const oauthClientUpdateSchema = oauthClientSchema.nullable();
export const oauthAccountSchema = z.object({ ...accountFields,
  imap: configurableServerSchema.omit({ password: true }).default(emptyImap), smtp: configurableServerSchema.omit({ password: true }).default(emptySmtp),
  proxy: accountUpdateSchema.shape.proxy,
}).superRefine(validateTransportSecurity);
export const oauthStartSchema = z.object({
  provider: oauthProviderSchema, accountId: z.uuid().optional(), account: oauthAccountSchema,
  client: z.discriminatedUnion('source', [
    z.object({ source: z.literal('preset') }), z.object({ source: z.literal('global') }),
    z.object({ source: z.literal('saved') }), oauthClientSchema.extend({ source: z.literal('custom') }),
  ]),
}).superRefine((input, ctx) => {
  const hosts = input.provider === 'google' ? { imap: ['imap.gmail.com'], smtp: ['smtp.gmail.com'] }
    : { imap: ['outlook.office365.com'], smtp: ['smtp.office365.com', 'smtp-mail.outlook.com'] };
  for (const protocol of ['imap', 'smtp'] as const) {
    if (!(protocol === 'imap' ? input.account.receiveEnabled : input.account.sendEnabled)) continue;
    if (!hosts[protocol].includes(input.account[protocol].host.toLowerCase()) || input.account[protocol].security === 'plain')
      ctx.addIssue({ code: 'custom', path: ['account', protocol], message: 'OAuth 请使用该服务商的加密邮件服务器' });
    if (/[\x00-\x1f\x7f]/.test(input.account[protocol].user))
      ctx.addIssue({ code: 'custom', path: ['account', protocol, 'user'], message: '登录名不能包含控制字符' });
  }
  if (input.client.source === 'custom' && input.provider === 'google' && !input.client.clientSecret)
    ctx.addIssue({ code: 'custom', path: ['client', 'clientSecret'], message: 'Google 桌面客户端需要 Client secret' });
});
export const oauthCallbackSchema = z.object({ url: z.url().max(16_384) });
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;
export type OAuthClientInput = z.infer<typeof oauthClientSchema>;
export type OAuthStart = z.infer<typeof oauthStartSchema>;
export type OAuthClientInfo = { source: 'preset' | 'global' | 'custom'; clientId: string; hasSecret: boolean };
export type OAuthClientSettings = Record<OAuthProvider, { presetAvailable: boolean; custom: Omit<OAuthClientInfo, 'source'> | null }>;
export type OAuthProgress = { id: string; status: 'waiting' | 'exchanging' | 'ready' | 'saving' | 'complete' | 'error'; expiresAt: number; error?: string; accountId?: string };
export type OAuthStarted = OAuthProgress & { authorizationUrl: string; redirectUri: string };

export const loginSchema = z.object({ password: z.string().min(12, '密码至少 12 个字符').max(1024) });
export const flagsSchema = z.object({ seen: z.boolean().optional(), starred: z.boolean().optional() });
export const moveSchema = z.object({ folderId: z.string().min(1) });
export const createFolderSchema = z.object({
  name: z.string().trim().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/, '文件夹名称不能包含控制字符'),
  parentId: z.uuid().optional(),
});
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export const uploadMetadataSchema = z.object({
  filename: z.string().min(1).max(255).refine(value => !/[\r\n\0]/.test(value), '文件名不能包含控制字符'),
  mimeType: z.string().max(255).regex(/^[\w.+-]+\/[\w.+-]+$/),
  size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES, '附件不能超过 20 MiB'),
});
export const sendSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.email()).min(1).max(100),
  cc: z.array(z.email()).max(100).default([]),
  bcc: z.array(z.email()).max(100).default([]),
  subject: z.string().max(998).refine(value => !/[\r\n]/.test(value)),
  text: z.string().max(5_000_000),
  html: z.string().max(5_000_000).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).max(100).default([]),
  attachmentIds: z.array(z.uuid()).max(MAX_ATTACHMENTS).default([]),
  draftId: z.uuid().optional(),
});
export const draftSchema = sendSchema.omit({ to: true, cc: true, bcc: true, draftId: true }).extend({
  to: z.string().max(32_000).default(''), cc: z.string().max(32_000).default(''), bcc: z.string().max(32_000).default(''),
});
export const composeSchema = z.object({ mode: z.enum(['reply', 'reply-all', 'forward']), includeAttachments: z.boolean().default(true),
  timeZone: z.string().max(100).default('UTC').refine(value => { try { new Intl.DateTimeFormat('zh-CN', { timeZone: value }); return true; } catch { return false; } }, '时区不正确') });
export const discoverySchema = z.object({ email: z.email() });
export const listSchema = z.object({
  accountId: z.string().optional(),
  folderId: z.string().optional(),
  view: z.enum(['inbox', 'all', 'starred']).default('inbox'),
  q: z.string().trim().max(500).default(''),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type AccountInput = z.infer<typeof accountSchema>;
export type AccountUpdate = z.infer<typeof accountUpdateSchema>;
export type AccountVerification = Record<'imap' | 'smtp', { status: 'success' | 'error' | 'disabled'; error?: string }>;
export type AccountSettings = Omit<AccountInput, 'imap' | 'smtp' | 'proxy'> & {
  imap: Omit<AccountInput['imap'], 'password'>; smtp: Omit<AccountInput['smtp'], 'password'>; proxyDisplay?: string;
  globalProxyDisplay?: string;
  oauth?: { provider: OAuthProvider; client: OAuthClientInfo };
};
export type SendInput = z.infer<typeof sendSchema>;
export type DraftInput = z.infer<typeof draftSchema>;
export type ComposeMode = z.infer<typeof composeSchema>['mode'];
export type Upload = z.infer<typeof uploadMetadataSchema> & { id: string; createdAt: number };
export type Draft = DraftInput & { id: string; updatedAt: number; attachments: Upload[] };
export type DraftSummary = Pick<Draft, 'id' | 'accountId' | 'to' | 'subject' | 'updatedAt'> & { attachmentCount: number };
export type UnreadCounts = { inbox: number; all: number; starred: number; drafts: number; accounts: Record<string, number>; folders: Record<string, number> };
export type AutoConfig = { name: string; source: 'ispdb'; imap: AccountSettings['imap']; smtp: AccountSettings['smtp']; requiresOAuth: boolean; sentCopy: AccountInput['sentCopy'] };
export type ListInput = z.infer<typeof listSchema>;
export type FlagUpdate = z.infer<typeof flagsSchema>;
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other';
export type Address = { name: string; address: string };
export type Account = { id: string; name: string; email: string; lastSync: number | null; error: string | null; receiveEnabled: boolean; sendEnabled: boolean };
export type Cursor = { uidValidity: string; uidNext: number; modseq: string | null };
export type Folder = Cursor & { id: string; accountId: string; path: string; name: string; role: FolderRole; delimiter?: string | null };
export type MailMetadata = {
  uid: number;
  remoteId: string | null;
  providerThreadId: string | null;
  messageId: string;
  references: string[];
  subject: string;
  from: Address[];
  to: Address[];
  replyTo: Address[];
  date: number;
  flags: string[];
};
export type MailFlags = Pick<MailMetadata, 'uid' | 'flags'>;
export type MoveReceipt = { uid?: number; uidValidity?: string };
export type Message = Omit<MailMetadata, 'uid' | 'remoteId' | 'providerThreadId' | 'flags'> & {
  id: string;
  accountId: string;
  threadId: string;
  preview: string;
  seen: boolean;
  starred: boolean;
  cached: boolean;
};
export type Attachment = { id: string; filename: string; mimeType: string; size: number; contentId?: string };
export type InlineImage = { attachmentId: string; contentId: string; dataUrl: string };
export type MessageBody = { text: string; html: string | null; attachments: Attachment[]; inlineImages?: InlineImage[]; cc?: Address[] };
export type MessagePage = { messages: Message[]; total: number; nextOffset: number | null };
export type SyncEvent = { type: 'settings' } | { type: 'sync' | 'change' | 'draft'; accountId: string; messageId?: string; contentOnly?: boolean; state?: 'running' | 'idle' | 'error'; error?: string };
export type BuildInfo = { version: string; revision: string | null; localChanges: boolean | null; builtAt: string };
export const updateSettingsSchema = z.object({
  enabled: z.boolean(), useGlobalProxy: z.boolean(),
  frequency: z.enum(['hourly', 'daily', 'weekly', 'on-open']),
  channel: z.enum(['stable', 'ci', 'source']),
});
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type UpdateChannel = UpdateSettings['channel'];
export const defaultUpdateSettings: UpdateSettings = { enabled: false, useGlobalProxy: true, frequency: 'daily', channel: 'source' };
export type UpdateCheck = {
  status: 'available' | 'current' | 'local-ahead' | 'diverged' | 'unknown' | 'unpublished';
  channel: UpdateChannel;
  current: BuildInfo;
  latest: { revision: string; title: string; date: string; url: string; tag?: string } | null;
  checkedAt: string;
};
export type UpdateState = { checkedAt: string | null; result: UpdateCheck | null; error: string | null };
export const PROJECT_URL = 'https://github.com/sisi0318/mailisle';
