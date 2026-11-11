import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import PostalMime from 'postal-mime';
import { convert } from 'html-to-text';
import type { MessageBody } from '@mail/shared';

type CachedBody = MessageBody & { cacheVersion?: number };
const rasterImage = /^image\/(png|jpeg|gif|webp)$/i;

export class BodyCache {
  constructor(private directory: string) {}
  async read(id: string): Promise<CachedBody | null> {
    try { return await this.withInlineImages(id, JSON.parse(await readFile(join(this.directory, id, 'body.json'), 'utf8')) as CachedBody); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async save(id: string, source: Buffer): Promise<CachedBody> {
    const email = await PostalMime.parse(source);
    const directory = join(this.directory, id);
    await mkdir(directory, { recursive: true });
    const attachments = await Promise.all(email.attachments.map(async (attachment, i) => {
      const content = typeof attachment.content === 'string' ? Buffer.from(attachment.content, 'base64') : Buffer.from(new Uint8Array(attachment.content));
      await writeFile(join(directory, `${i}.bin.tmp`), content);
      await rename(join(directory, `${i}.bin.tmp`), join(directory, `${i}.bin`));
      return { id: String(i), filename: attachment.filename ?? `附件-${i + 1}`, mimeType: attachment.mimeType, size: content.length,
        ...(attachment.contentId ? { contentId: attachment.contentId.replace(/^<|>$/g, '').trim() } : {}) };
    }));
    const cc = (email.cc ?? []).flatMap(address => address.group ?? [address]).map(address => ({ name: address.name ?? '', address: address.address ?? '' }));
    const body = { cacheVersion: 2, text: email.text ?? convert(email.html ?? '', { wordwrap: false }), html: email.html ?? null, attachments, cc };
    await writeFile(join(directory, 'body.json.tmp'), JSON.stringify(body));
    await rename(join(directory, 'body.json.tmp'), join(directory, 'body.json'));
    return this.withInlineImages(id, body);
  }
  async attachment(messageId: string, attachmentId: string) { return readFile(join(this.directory, messageId, `${attachmentId}.bin`)); }
  private async withInlineImages(id: string, body: CachedBody): Promise<CachedBody> {
    const inlineImages = await Promise.all(body.attachments.filter(attachment => attachment.contentId && rasterImage.test(attachment.mimeType))
      .map(async attachment => ({ attachmentId: attachment.id, contentId: attachment.contentId!,
        dataUrl: `data:${attachment.mimeType.toLowerCase()};base64,${(await this.attachment(id, attachment.id)).toString('base64')}` })));
    return { ...body, inlineImages };
  }
}
