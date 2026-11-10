import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import PostalMime from 'postal-mime';
import { convert } from 'html-to-text';
import type { MessageBody } from '@mail/shared';

export class BodyCache {
  constructor(private directory: string) {}
  async read(id: string): Promise<MessageBody | null> {
    try { return JSON.parse(await readFile(join(this.directory, id, 'body.json'), 'utf8')) as MessageBody; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async save(id: string, source: Buffer): Promise<MessageBody> {
    const email = await PostalMime.parse(source);
    const directory = join(this.directory, id);
    await mkdir(directory, { recursive: true });
    const attachments = await Promise.all(email.attachments.map(async (attachment, i) => {
      const content = typeof attachment.content === 'string' ? Buffer.from(attachment.content, 'base64') : Buffer.from(new Uint8Array(attachment.content));
      await writeFile(join(directory, `${i}.bin`), content);
      return { id: String(i), filename: attachment.filename ?? `附件-${i + 1}`, mimeType: attachment.mimeType, size: content.length };
    }));
    const body = { text: email.text ?? convert(email.html ?? '', { wordwrap: false }), html: email.html ?? null, attachments };
    await writeFile(join(directory, 'body.json.tmp'), JSON.stringify(body));
    await rename(join(directory, 'body.json.tmp'), join(directory, 'body.json'));
    return body;
  }
  async attachment(messageId: string, attachmentId: string) { return readFile(join(this.directory, messageId, `${attachmentId}.bin`)); }
}
