import { integer, sqliteTable, text, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { Address, FolderRole } from '@mail/shared';

export const settings = sqliteTable('settings', { key: text('key').primaryKey(), value: text('value').notNull() });
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(),
  encryptedConfig: text('encrypted_config').notNull(), lastSync: integer('last_sync'), error: text('error'),
});
export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  path: text('path').notNull(), name: text('name').notNull(), role: text('role').$type<FolderRole>().notNull(),
  uidValidity: text('uid_validity').notNull().default(''), uidNext: integer('uid_next').notNull().default(1), modseq: text('modseq'),
}, table => [uniqueIndex('folders_account_path').on(table.accountId, table.path)]);
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  remoteKey: text('remote_key').notNull(), messageId: text('message_id').notNull(), threadId: text('thread_id').notNull(),
  references: text('refs', { mode: 'json' }).$type<string[]>().notNull(), subject: text('subject').notNull(),
  from: text('from_json', { mode: 'json' }).$type<Address[]>().notNull(), to: text('to_json', { mode: 'json' }).$type<Address[]>().notNull(),
  replyTo: text('reply_to_json', { mode: 'json' }).$type<Address[]>().notNull().default([]),
  date: integer('date').notNull(), preview: text('preview').notNull().default(''),
  bodyText: text('body_text').notNull().default(''), cached: integer('cached', { mode: 'boolean' }).notNull().default(false),
}, table => [
  uniqueIndex('messages_remote_key').on(table.accountId, table.remoteKey), index('messages_date').on(table.date),
  index('messages_message_id').on(table.messageId), index('messages_thread').on(table.threadId),
]);
export const locations = sqliteTable('locations', {
  folderId: text('folder_id').notNull().references(() => folders.id, { onDelete: 'cascade' }),
  uid: integer('uid').notNull(), messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  flags: text('flags', { mode: 'json' }).$type<string[]>().notNull(),
}, table => [primaryKey({ columns: [table.folderId, table.uid] }), index('locations_message').on(table.messageId)]);
