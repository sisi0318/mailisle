import { z } from 'zod';
export { providerPresets, detectProvider } from './providers';
export type { ProviderPreset } from './providers';

const serverSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'plain']).default('tls'),
  user: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(4096),
});

export const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email(),
  imap: serverSchema,
  smtp: serverSchema,
  proxy: z.url().refine(value => ['http:', 'https:', 'socks5:'].includes(new URL(value).protocol), '仅支持 HTTP 或 SOCKS5 代理').optional(),
  sentCopy: z.enum(['append', 'server']).default('append'),
}).superRefine((account, ctx) => {
  for (const protocol of ['imap', 'smtp'] as const) {
    const server = account[protocol];
    if (server.security === 'plain' && !['localhost', '127.0.0.1', '::1'].includes(server.host)) {
      ctx.addIssue({ code: 'custom', path: [protocol, 'security'], message: '明文连接仅允许本机邮件桥接或测试服务器' });
    }
  }
});

export const loginSchema = z.object({ password: z.string().min(12, '密码至少 12 个字符').max(1024) });
export const flagsSchema = z.object({ seen: z.boolean().optional(), starred: z.boolean().optional() });
export const moveSchema = z.object({ folderId: z.string().min(1) });
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
});
export const listSchema = z.object({
  accountId: z.string().optional(),
  folderId: z.string().optional(),
  view: z.enum(['inbox', 'all', 'starred']).default('inbox'),
  q: z.string().trim().max(500).default(''),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type AccountInput = z.infer<typeof accountSchema>;
export type SendInput = z.infer<typeof sendSchema>;
export type ListInput = z.infer<typeof listSchema>;
export type FlagUpdate = z.infer<typeof flagsSchema>;
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other';
export type Address = { name: string; address: string };
export type Account = { id: string; name: string; email: string; lastSync: number | null; error: string | null };
export type Cursor = { uidValidity: string; uidNext: number; modseq: string | null };
export type Folder = Cursor & { id: string; accountId: string; path: string; name: string; role: FolderRole };
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
export type Attachment = { id: string; filename: string; mimeType: string; size: number };
export type MessageBody = { text: string; html: string | null; attachments: Attachment[] };
export type MessagePage = { messages: Message[]; total: number; nextOffset: number | null };
export type SyncEvent = { type: 'sync' | 'change'; accountId: string; state?: 'running' | 'idle' | 'error'; error?: string };
