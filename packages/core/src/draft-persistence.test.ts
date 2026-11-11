import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MailStore } from '@mail/db';
import { draftSchema } from '@mail/shared';
import { migrations } from '../../../tests/fixtures';
import { UploadStore } from './uploads';

it('reopens drafts and their attachment bytes after the database and upload store restart', async () => {
  await mkdir('.test-artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('.test-artifacts/draft-persistence-'));
  const filename = join(directory, 'mail.sqlite');
  const old = new MailStore(filename, migrations);
  const accountId = old.addAccount('测试', 'alice@example.com', 'encrypted');
  const uploads = new UploadStore(old, join(directory, 'uploads'));
  const file = await uploads.save('重启.txt', 'text/plain', Buffer.from('重启之后的附件'));
  const input = draftSchema.parse({ accountId, to: 'bob@', cc: '', subject: '未完成的草稿', text: '正文', html: '<p>正文</p>', attachmentIds: [file.id] });
  old.saveDraft('persistent-draft', input); old.close();
  const reopened = new MailStore(filename, migrations);
  try {
    expect(reopened.draft('persistent-draft')).toMatchObject(input);
    const restored = new UploadStore(reopened, join(directory, 'uploads'));
    await restored.cleanup();
    expect((await restored.attachments([file.id]))[0].content.toString()).toBe('重启之后的附件');
    expect(reopened.drafts()).toMatchObject([{ id: 'persistent-draft', attachmentCount: 1 }]);
  } finally { reopened.close(); await rm(directory, { recursive: true, force: true }); }
});
