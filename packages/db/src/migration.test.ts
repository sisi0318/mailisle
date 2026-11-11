import { expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MailStore } from './index';
import { listSchema } from '@mail/shared';
import { migrations, seedAccount } from '../../../tests/fixtures';
import * as schema from './schema';

it('migrates existing mail and cached search text without changing message identity', () => {
  mkdirSync('.test-artifacts', { recursive: true });
  const directory = mkdtempSync(resolve('.test-artifacts/migration-'));
  const legacyMigrations = join(directory, 'legacy');
  mkdirSync(legacyMigrations);
  for (const name of ['0001_initial.sql', '0002_reply_to.sql']) copyFileSync(join(migrations, name), join(legacyMigrations, name));
  const filename = join(directory, 'mail.sqlite');
  const old = new MailStore(filename, legacyMigrations);
  const { accountId, inbox } = seedAccount(old);
  old.sqlite.prepare(`INSERT INTO messages(id,account_id,remote_key,message_id,thread_id,refs,subject,from_json,to_json,date,body_text,preview,cached)
    VALUES ('legacy-mail',?,?,'<legacy>','legacy-thread','["<missing-parent>"]','合同','[]','[]',1,'缓存正文','缓存正文',1)`)
    .run(accountId, `${inbox.id}:1:1`);
  old.db.insert(schema.locations).values({ folderId: inbox.id, uid: 1, messageId: 'legacy-mail', flags: ['\\Seen'] }).run();
  old.sqlite.prepare('INSERT INTO message_search(rowid,id,content) VALUES (42,?,?)').run('legacy-mail', '合同 缓存 存正 正文');
  old.close();
  const upgraded = new MailStore(filename, migrations);
  try {
    expect(upgraded.list(listSchema.parse({ q: '合同' })).messages[0]).toMatchObject({ id: 'legacy-mail', threadId: 'legacy-thread', cached: true, seen: true });
    expect(upgraded.pendingBodies(accountId)).toEqual([]);
    expect(upgraded.sqlite.prepare('SELECT * FROM message_search_rows').get()).toEqual({ id: 42, message_id: 'legacy-mail' });
    expect(upgraded.sqlite.prepare('SELECT thread_id FROM thread_keys WHERE account_id = ? AND reference = ?').get(accountId, '<missing-parent>')).toEqual({ thread_id: 'legacy-thread' });
    upgraded.cacheBody('legacy-mail', '新的缓存正文');
    expect(upgraded.sqlite.prepare('SELECT rowid FROM message_search').all()).toEqual([{ rowid: 42 }]);
    upgraded.sqlite.prepare("INSERT INTO message_search(message_search) VALUES ('integrity-check')").run();
    upgraded.deleteAccount(accountId);
    expect(upgraded.sqlite.prepare('SELECT count(*) AS n FROM message_search').get()).toEqual({ n: 0 });
  } finally { upgraded.close(); rmSync(directory, { recursive: true, force: true }); }
});
