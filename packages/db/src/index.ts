import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Account, Cursor, Folder, FolderRole, ListInput, MailMetadata, Message, MessagePage } from '@mail/shared';
import * as schema from './schema';
import { searchExpression, tokenize } from './search';

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
  syncStatus(id: string, error: string | null) {
    this.db.update(schema.accounts).set(error ? { error } : { error: null, lastSync: Date.now() }).where(eq(schema.accounts.id, id)).run();
  }
  folders(accountId?: string): Folder[] {
    return this.db.select().from(schema.folders).where(accountId ? eq(schema.folders.accountId, accountId) : undefined).all();
  }
  folder(id: string) { return this.db.select().from(schema.folders).where(eq(schema.folders.id, id)).get(); }
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
        this.db.insert(schema.locations).values({ folderId: folder.id, uid: record.uid, messageId: id, flags: record.flags })
          .onConflictDoUpdate({ target: [schema.locations.folderId, schema.locations.uid], set: { messageId: id, flags: record.flags } }).run();
        this.indexMessage(id);
      }
    })();
  }
  finishFolder(folderId: string, cursor: Cursor, uids: number[]) {
    this.sqlite.transaction(() => {
      const present = new Set(uids);
      const local = this.db.select().from(schema.locations).where(eq(schema.locations.folderId, folderId)).all();
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
    const rows = this.db.select().from(schema.messages).where(where).orderBy(sql`date DESC, id DESC`).limit(input.limit).offset(input.offset).all();
    return { messages: rows.map(row => this.toMessage(row)), total, nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null };
  }
  message(id: string): Message | undefined {
    const row = this.db.select().from(schema.messages).where(eq(schema.messages.id, id)).get();
    return row && this.toMessage(row);
  }
  thread(id: string): Message[] {
    return this.db.select().from(schema.messages).where(eq(schema.messages.threadId, id)).orderBy(schema.messages.date).all().map(row => this.toMessage(row));
  }
  messageLocations(id: string) {
    return this.db.select({ folder: schema.folders, uid: schema.locations.uid, flags: schema.locations.flags }).from(schema.locations)
      .innerJoin(schema.folders, eq(schema.folders.id, schema.locations.folderId)).where(eq(schema.locations.messageId, id)).all();
  }
  cacheBody(id: string, text: string) {
    this.sqlite.transaction(() => {
      this.db.update(schema.messages).set({ bodyText: text, preview: text.replace(/\s+/g, ' ').slice(0, 180), cached: true }).where(eq(schema.messages.id, id)).run();
      this.indexMessage(id);
    })();
  }
  private indexMessage(id: string) {
    const message = this.db.select().from(schema.messages).where(eq(schema.messages.id, id)).get()!;
    const content = tokenize([message.subject, ...message.from.map(a => `${a.name} ${a.address}`), ...message.to.map(a => `${a.name} ${a.address}`), message.bodyText].join(' '));
    this.sqlite.prepare('DELETE FROM message_search WHERE id = ?').run(id);
    this.sqlite.prepare('INSERT INTO message_search(id, content) VALUES (?, ?)').run(id, content);
  }
  private resolveThread(accountId: string, message: MailMetadata, current?: string): string {
    if (message.providerThreadId) return `${accountId}:provider:${message.providerThreadId}`;
    const refs = [...new Set([message.messageId, ...message.references].filter(Boolean))];
    if (!refs.length) return current ?? randomUUID();
    const related = this.db.select({ threadId: schema.messages.threadId }).from(schema.messages).where(and(
      eq(schema.messages.accountId, accountId),
      sql`(messages.message_id IN (${sql.join(refs.map(ref => sql`${ref}`), sql`,`)}) OR EXISTS (SELECT 1 FROM json_each(messages.refs) ref WHERE ref.value IN (${sql.join(refs.map(ref => sql`${ref}`), sql`,`)})))`,
    )).all();
    const threads = [...new Set([...related.map(row => row.threadId), ...(current ? [current] : [])])];
    const threadId = threads[0] ?? randomUUID();
    if (threads.length > 1) this.db.update(schema.messages).set({ threadId }).where(inArray(schema.messages.threadId, threads)).run();
    return threadId;
  }
  private toMessage(row: typeof schema.messages.$inferSelect): Message {
    const flags = this.messageLocations(row.id).flatMap(location => location.flags);
    return { id: row.id, accountId: row.accountId, messageId: row.messageId, references: row.references,
      threadId: row.threadId, subject: row.subject, from: row.from, to: row.to, replyTo: row.replyTo, date: row.date,
      preview: row.preview, cached: row.cached, seen: flags.includes('\\Seen'), starred: flags.includes('\\Flagged') };
  }
  private removeOrphans() {
    this.sqlite.exec('DELETE FROM messages WHERE NOT EXISTS (SELECT 1 FROM locations WHERE locations.message_id = messages.id)');
  }
}
