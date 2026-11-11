import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, getTableColumns, inArray, lt, sql } from 'drizzle-orm';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Account, Cursor, DraftInput, DraftSummary, FlagUpdate, Folder, FolderRole, ListInput, MailFlags, MailMetadata, Message, MessagePage, MoveReceipt, UnreadCounts, Upload } from '@mail/shared';
import * as schema from './schema';
import { previewText, searchExpression, tokenize } from './search';

const { bodyText: _bodyText, ...messageColumns } = getTableColumns(schema.messages);

export class MailStore {
  readonly sqlite: Database.Database;
  readonly db;

  constructor(filename: string, migrationsDir: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.sqlite = new Database(filename);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');
    for (const name of readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort()) {
      if (this.sqlite.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) continue;
      this.sqlite.transaction(() => {
        this.sqlite.exec(readFileSync(join(migrationsDir, name), 'utf8'));
        this.sqlite.prepare('INSERT INTO migrations VALUES (?)').run(name);
      })();
    }
    this.db = drizzle(this.sqlite, { schema });
  }

  close() { this.sqlite.close(); }
  getSetting(key: string) { return this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value; }
  setSetting(key: string, value: string) {
    this.db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
  }
  webSession(tokenHash: string) { return this.db.select().from(schema.webSessions).where(eq(schema.webSessions.tokenHash, tokenHash)).get(); }
  addWebSession(tokenHash: string, expiresAt: number) {
    this.db.delete(schema.webSessions).where(lt(schema.webSessions.expiresAt, Date.now())).run();
    this.db.insert(schema.webSessions).values({ tokenHash, expiresAt }).run();
  }
  deleteWebSession(tokenHash: string) { this.db.delete(schema.webSessions).where(eq(schema.webSessions.tokenHash, tokenHash)).run(); }
  accounts(): Account[] {
    return this.db.select({ id: schema.accounts.id, name: schema.accounts.name, email: schema.accounts.email,
      lastSync: schema.accounts.lastSync, error: schema.accounts.error }).from(schema.accounts).all();
  }
  account(id: string) { return this.db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get(); }
  addAccount(name: string, email: string, encryptedConfig: string) {
    const id = randomUUID();
    this.db.insert(schema.accounts).values({ id, name, email, encryptedConfig }).run();
    return id;
  }
  deleteAccount(id: string) { this.db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run(); }
  updateAccountCredentials(id: string, encryptedConfig: string) {
    this.db.update(schema.accounts).set({ encryptedConfig }).where(eq(schema.accounts.id, id)).run();
  }
  updateAccount(id: string, name: string, email: string, encryptedConfig: string, resetMailbox: boolean) {
    this.sqlite.transaction(() => {
      if (resetMailbox) {
        this.db.delete(schema.folders).where(eq(schema.folders.accountId, id)).run();
        this.db.delete(schema.messages).where(eq(schema.messages.accountId, id)).run();
        this.db.delete(schema.threadKeys).where(eq(schema.threadKeys.accountId, id)).run();
      }
      this.db.update(schema.accounts).set({ name, email, encryptedConfig, error: null, ...(resetMailbox ? { lastSync: null } : {}) }).where(eq(schema.accounts.id, id)).run();
    })();
  }
  upload(id: string) { return this.db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get(); }
  addUpload(upload: Upload) { this.db.insert(schema.uploads).values(upload).run(); }
  removeUpload(id: string) { this.db.delete(schema.uploads).where(eq(schema.uploads.id, id)).run(); }
  uploadInUse(id: string) { return !!this.sqlite.prepare('SELECT 1 FROM drafts d, json_each(d.attachment_ids) a WHERE a.value = ? LIMIT 1').get(id); }
  unusedUploads(before: number) {
    return this.db.select().from(schema.uploads).where(sql`created_at < ${before} AND NOT EXISTS (SELECT 1 FROM drafts d, json_each(d.attachment_ids) a WHERE a.value = uploads.id)`).all();
  }
  draft(id: string) { return this.db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get(); }
  drafts(accountId?: string): DraftSummary[] {
    return this.db.select({ id: schema.drafts.id, accountId: schema.drafts.accountId, to: schema.drafts.to, subject: schema.drafts.subject,
      updatedAt: schema.drafts.updatedAt, attachmentCount: sql<number>`json_array_length(attachment_ids)` }).from(schema.drafts)
      .where(accountId ? eq(schema.drafts.accountId, accountId) : undefined).orderBy(sql`updated_at DESC`).all();
  }
  saveDraft(id: string, input: DraftInput) {
    const values = { ...input, html: input.html ?? null, inReplyTo: input.inReplyTo ?? null, updatedAt: Date.now() };
    this.db.insert(schema.drafts).values({ id, ...values }).onConflictDoUpdate({ target: schema.drafts.id, set: values }).run();
  }
  deleteDraft(id: string) { this.db.delete(schema.drafts).where(eq(schema.drafts.id, id)).run(); }
  unreadCounts(): UnreadCounts {
    const rows = this.sqlite.prepare(`WITH unread AS MATERIALIZED (
      SELECT id, account_id FROM messages m WHERE NOT EXISTS (
        SELECT 1 FROM locations l, json_each(l.flags) flag WHERE l.message_id = m.id AND flag.value = ?
      )
    ), inbox AS (
      SELECT DISTINCT u.id, u.account_id FROM unread u JOIN locations l ON l.message_id = u.id JOIN folders f ON f.id = l.folder_id WHERE f.role = 'inbox'
    )
    SELECT 'folder' kind,l.folder_id key,count(DISTINCT u.id) n FROM unread u JOIN locations l ON l.message_id=u.id GROUP BY l.folder_id
    UNION ALL SELECT 'account',account_id,count(*) FROM inbox GROUP BY account_id
    UNION ALL SELECT 'view','inbox',count(*) FROM inbox
    UNION ALL SELECT 'view','all',count(*) FROM unread
    UNION ALL SELECT 'view','starred',count(*) FROM unread u WHERE EXISTS (
      SELECT 1 FROM locations l,json_each(l.flags) flag WHERE l.message_id=u.id AND flag.value=?
    )
    UNION ALL SELECT 'view','drafts',count(*) FROM drafts`).all('\\Seen', '\\Flagged') as { kind: string; key: string; n: number }[];
    const counts: UnreadCounts = { inbox: 0, all: 0, starred: 0, drafts: 0, accounts: {}, folders: {} };
    for (const row of rows) {
      if (row.kind === 'folder') counts.folders[row.key] = row.n;
      else if (row.kind === 'account') counts.accounts[row.key] = row.n;
      else counts[row.key as 'inbox' | 'all' | 'starred' | 'drafts'] = row.n;
    }
    return counts;
  }
  syncStatus(id: string, error: string | null) {
    this.db.update(schema.accounts).set(error ? { error } : { error: null, lastSync: Date.now() }).where(eq(schema.accounts.id, id)).run();
  }
  folders(accountId?: string): Folder[] {
    return this.db.select().from(schema.folders).where(accountId ? eq(schema.folders.accountId, accountId) : undefined).all();
  }
  folder(id: string) { return this.db.select().from(schema.folders).where(eq(schema.folders.id, id)).get(); }
  folderUids(id: string): number[] {
    return this.db.select({ uid: schema.locations.uid }).from(schema.locations).where(eq(schema.locations.folderId, id)).all().map(row => row.uid);
  }
  saveFolders(accountId: string, folders: { path: string; name: string; role: FolderRole }[]) {
    this.sqlite.transaction(() => {
      for (const folder of folders) {
        this.db.insert(schema.folders).values({ ...folder, id: randomUUID(), accountId }).onConflictDoUpdate({
          target: [schema.folders.accountId, schema.folders.path], set: { name: folder.name, role: folder.role },
        }).run();
      }
      const paths = new Set(folders.map(folder => folder.path));
      for (const folder of this.folders(accountId)) {
        if (!paths.has(folder.path)) this.db.delete(schema.folders).where(eq(schema.folders.id, folder.id)).run();
      }
      this.removeOrphans();
    })();
    return this.folders(accountId);
  }
  beginFolder(folderId: string, uidValidity: string) {
    if (this.folder(folderId)?.uidValidity === uidValidity) return;
    this.sqlite.transaction(() => {
      this.db.delete(schema.locations).where(eq(schema.locations.folderId, folderId)).run();
      this.db.update(schema.folders).set({ uidValidity, uidNext: 1, modseq: null }).where(eq(schema.folders.id, folderId)).run();
    })();
  }
  applyBatch(folder: Folder, records: MailMetadata[]) {
    this.sqlite.transaction(() => {
      for (const record of records) {
        const remoteKey = record.remoteId ? `provider:${record.remoteId}` : `${folder.id}:${folder.uidValidity}:${record.uid}`;
        const existing = this.db.select().from(schema.messages).where(and(eq(schema.messages.accountId, folder.accountId), eq(schema.messages.remoteKey, remoteKey))).get();
        const id = existing?.id ?? randomUUID();
        const threadId = this.resolveThread(folder.accountId, record, existing?.threadId);
        const values = { id, accountId: folder.accountId, remoteKey, threadId, messageId: record.messageId,
          references: record.references, subject: record.subject, from: record.from, to: record.to, replyTo: record.replyTo, date: record.date };
        this.db.insert(schema.messages).values(values).onConflictDoUpdate({ target: schema.messages.id, set: values }).run();
        const flags = [...record.flags].sort();
        this.db.insert(schema.locations).values({ folderId: folder.id, uid: record.uid, messageId: id, flags })
          .onConflictDoUpdate({ target: [schema.locations.folderId, schema.locations.uid], set: { messageId: id, flags } }).run();
        this.indexMessage(id);
      }
    })();
  }
  applyFlags(folderId: string, records: MailFlags[]) {
    const update = this.sqlite.prepare('UPDATE locations SET flags = ? WHERE folder_id = ? AND uid = ? AND flags <> ?');
    return this.sqlite.transaction(() => {
      let changed = 0;
      for (const record of records) {
        const flags = JSON.stringify([...record.flags].sort());
        changed += update.run(flags, folderId, record.uid, flags).changes;
      }
      return changed;
    })();
  }
  patchFlags(folderId: string, uid: number, update: FlagUpdate) {
    const location = this.db.select().from(schema.locations).where(and(eq(schema.locations.folderId, folderId), eq(schema.locations.uid, uid))).get();
    if (!location) return;
    const flags = new Set(location.flags);
    for (const [key, flag] of [['seen', '\\Seen'], ['starred', '\\Flagged']] as const) {
      if (update[key] === true) flags.add(flag);
      if (update[key] === false) flags.delete(flag);
    }
    this.applyFlags(folderId, [{ uid, flags: [...flags] }]);
  }
  moveLocation(folderId: string, uid: number, target: Folder, receipt: MoveReceipt): boolean {
    return this.sqlite.transaction(() => {
      const location = this.db.select().from(schema.locations).where(and(eq(schema.locations.folderId, folderId), eq(schema.locations.uid, uid))).get();
      if (!location) return false;
      const mapped = receipt.uid !== undefined && receipt.uidValidity !== undefined;
      if (mapped) {
        this.beginFolder(target.id, receipt.uidValidity!);
        this.db.insert(schema.locations).values({ folderId: target.id, uid: receipt.uid!, messageId: location.messageId, flags: location.flags })
          .onConflictDoUpdate({ target: [schema.locations.folderId, schema.locations.uid], set: { messageId: location.messageId, flags: location.flags } }).run();
        const message = this.db.select().from(schema.messages).where(eq(schema.messages.id, location.messageId)).get()!;
        if (!message.remoteKey.startsWith('provider:')) {
          this.db.update(schema.messages).set({ remoteKey: `${target.id}:${receipt.uidValidity}:${receipt.uid}` }).where(eq(schema.messages.id, message.id)).run();
        }
      }
      this.db.delete(schema.locations).where(and(eq(schema.locations.folderId, folderId), eq(schema.locations.uid, uid))).run();
      if (!mapped) this.sqlite.prepare('DELETE FROM messages WHERE id = ? AND NOT EXISTS (SELECT 1 FROM locations WHERE message_id = ?)').run(location.messageId, location.messageId);
      return mapped;
    })();
  }
  finishFolder(folderId: string, cursor: Cursor, uids: number[]) {
    this.sqlite.transaction(() => {
      const present = new Set(uids);
      // A move can add a destination UID between scan batches; the older snapshot cannot delete it.
      const local = this.db.select({ uid: schema.locations.uid }).from(schema.locations).where(and(eq(schema.locations.folderId, folderId), lt(schema.locations.uid, cursor.uidNext))).all();
      for (const item of local) if (!present.has(item.uid)) {
        this.db.delete(schema.locations).where(and(eq(schema.locations.folderId, folderId), eq(schema.locations.uid, item.uid))).run();
      }
      this.db.update(schema.folders).set(cursor).where(eq(schema.folders.id, folderId)).run();
      this.removeOrphans();
    })();
  }
  list(input: ListInput): MessagePage {
    const conditions = [];
    if (input.accountId) conditions.push(eq(schema.messages.accountId, input.accountId));
    if (input.folderId) {
      conditions.push(sql`EXISTS (SELECT 1 FROM locations l WHERE l.message_id = messages.id AND l.folder_id = ${input.folderId})`);
    } else if (input.view === 'inbox' && !input.q) {
      conditions.push(sql`EXISTS (SELECT 1 FROM locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = messages.id AND f.role = 'inbox')`);
    }
    if (input.view === 'starred') conditions.push(sql`EXISTS (SELECT 1 FROM locations l, json_each(l.flags) flag WHERE l.message_id = messages.id AND flag.value = ${'\\Flagged'})`);
    if (input.q) {
      const expression = searchExpression(input.q);
      conditions.push(expression
        ? sql`messages.id IN (SELECT id FROM message_search WHERE message_search MATCH ${expression})`
        : sql`instr(lower(subject || ' ' || from_json || ' ' || to_json || ' ' || body_text), lower(${input.q})) > 0`);
    }
    const where = and(...conditions);
    const total = this.db.select({ count: sql<number>`count(*)` }).from(schema.messages).where(where).get()!.count;
    const rows = this.db.select(messageColumns).from(schema.messages).where(where).orderBy(sql`date DESC, id DESC`).limit(input.limit).offset(input.offset).all();
    return { messages: rows.map(row => this.toMessage(row)), total, nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null };
  }
  hasMessage(id: string) { return !!this.sqlite.prepare('SELECT 1 FROM messages WHERE id = ?').get(id); }
  messageIds(accountId: string) { return this.db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.accountId, accountId)).all().map(row => row.id); }
  message(id: string): Message | undefined {
    const row = this.db.select(messageColumns).from(schema.messages).where(eq(schema.messages.id, id)).get();
    return row && this.toMessage(row);
  }
  thread(id: string): Message[] {
    return this.db.select(messageColumns).from(schema.messages).where(eq(schema.messages.threadId, id)).orderBy(schema.messages.date).all().map(row => this.toMessage(row));
  }
  messageLocations(id: string) {
    return this.db.select({ folder: schema.folders, uid: schema.locations.uid, flags: schema.locations.flags }).from(schema.locations)
      .innerJoin(schema.folders, eq(schema.folders.id, schema.locations.folderId)).where(eq(schema.locations.messageId, id)).all();
  }
  cacheBody(id: string, text: string) {
    return this.writeBodyText(id, text, true);
  }
  indexBody(id: string, text: string) {
    return this.writeBodyText(id, text, false);
  }
  pendingBodies(accountId: string, limit = 20, before?: { date: number; id: string }) {
    return this.db.select({ id: schema.messages.id, date: schema.messages.date }).from(schema.messages).where(and(
      eq(schema.messages.accountId, accountId), eq(schema.messages.bodyIndexed, false),
      before ? sql`(date, id) < (${before.date}, ${before.id})` : undefined,
    )).orderBy(sql`date DESC, id DESC`).limit(limit).all();
  }
  private writeBodyText(id: string, text: string, complete: boolean) {
    return this.sqlite.transaction(() => {
      const result = this.db.update(schema.messages).set({ bodyText: text, preview: previewText(text), bodyIndexed: true,
        ...(complete ? { cached: true } : {}) }).where(and(eq(schema.messages.id, id),
        complete ? undefined : eq(schema.messages.bodyIndexed, false))).run();
      if (result.changes) this.indexMessage(id);
      return result.changes > 0;
    })();
  }
  private indexMessage(id: string) {
    const message = this.db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()!;
    const content = tokenize([message.subject, ...message.from.map(a => `${a.name} ${a.address}`), ...message.to.map(a => `${a.name} ${a.address}`), message.bodyText].join(' '));
    const row = this.db.select().from(schema.messageSearchRows).where(eq(schema.messageSearchRows.messageId, id)).get();
    const rowId = row?.id ?? Number(this.db.insert(schema.messageSearchRows).values({ messageId: id }).run().lastInsertRowid);
    this.sqlite.prepare('INSERT OR REPLACE INTO message_search(rowid, id, content) VALUES (?, ?, ?)').run(rowId, id, content);
  }
  private resolveThread(accountId: string, message: MailMetadata, current?: string): string {
    if (message.providerThreadId) return `${accountId}:provider:${message.providerThreadId}`;
    // One statement binds every reference, so a crafted header with tens of thousands of them must stay under SQLite's variable limit.
    const refs = [...new Set([message.messageId, ...message.references.slice(-200)].filter(Boolean))];
    if (!refs.length) return current ?? randomUUID();
    const related = this.db.select({ threadId: schema.threadKeys.threadId }).from(schema.threadKeys).where(and(
      eq(schema.threadKeys.accountId, accountId), inArray(schema.threadKeys.reference, refs),
    )).all();
    const threads = [...new Set([...related.map(row => row.threadId), ...(current ? [current] : [])])];
    const threadId = threads[0] ?? randomUUID();
    if (threads.length > 1) {
      const merged = threads.filter(id => id !== threadId);
      this.db.update(schema.messages).set({ threadId }).where(inArray(schema.messages.threadId, merged)).run();
      this.db.update(schema.threadKeys).set({ threadId }).where(inArray(schema.threadKeys.threadId, merged)).run();
    }
    for (const reference of refs) this.db.insert(schema.threadKeys).values({ accountId, reference, threadId }).onConflictDoNothing().run();
    return threadId;
  }
  private toMessage(row: Omit<typeof schema.messages.$inferSelect, 'bodyText'>): Message {
    const flags = this.messageLocations(row.id).flatMap(location => location.flags);
    return { id: row.id, accountId: row.accountId, messageId: row.messageId, references: row.references,
      threadId: row.threadId, subject: row.subject, from: row.from, to: row.to, replyTo: row.replyTo, date: row.date,
      preview: previewText(row.preview), cached: row.cached, seen: flags.includes('\\Seen'), starred: flags.includes('\\Flagged') };
  }
  private removeOrphans() {
    this.sqlite.exec('DELETE FROM messages WHERE NOT EXISTS (SELECT 1 FROM locations WHERE locations.message_id = messages.id)');
  }
}
