import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import PostalMime from 'postal-mime';
import { convert } from 'html-to-text';
import type { MessageBody } from '@mail/shared';
import { UserError } from './errors';

type CachedBody = MessageBody & { cacheVersion?: number };
const rasterImage = /^image\/(png|jpeg|gif|webp)$/i;
// IDs become directory and file names, so nothing that could leave the cache directory is accepted.
const safeSegment = /^[\w-]+$/;
const messageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BodyCache {
  constructor(private directory: string) {}
  async read(id: string): Promise<CachedBody | null> {
    const body = await this.stored(id);
    if (!body) return null;
    try { return await this.withInlineImages(id, body); }
    // A cache entry that lost one of its files is fetched again instead of failing every time it is opened.
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  /** The cached text and attachment list without inline image data, for callers that do not show the mail. */
  async stored(id: string): Promise<CachedBody | null> {
    try { return JSON.parse(await readFile(join(this.folder(id), 'body.json'), 'utf8')) as CachedBody; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  async save(id: string, source: Buffer): Promise<CachedBody> {
    const email = await PostalMime.parse(source);
    const directory = this.folder(id);
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
  async attachment(messageId: string, attachmentId: string) {
    if (!safeSegment.test(attachmentId)) throw new UserError('附件不存在', 404);
    return readFile(join(this.folder(messageId), `${attachmentId}.bin`));
  }
  async remove(ids: Iterable<string>) {
    for (const id of ids) if (safeSegment.test(id)) await rm(join(this.directory, id), { recursive: true, force: true });
  }
  /**
   * Deletes cached mail whose message no longer exists and returns how many entries went. `exists` is asked
   * after the directory was listed, so mail cached in the meantime is never touched. Only directories named
   * like a message ID are considered; anything else in the directory is left alone.
   */
  async sweep(exists: (id: string) => boolean) {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !messageId.test(entry.name) || exists(entry.name)) continue;
      await rm(join(this.directory, entry.name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
  private folder(id: string) {
    if (!safeSegment.test(id)) throw new UserError('邮件不存在', 404);
    return join(this.directory, id);
  }
  private async withInlineImages(id: string, body: CachedBody): Promise<CachedBody> {
    const inlineImages = await Promise.all(body.attachments.filter(attachment => attachment.contentId && rasterImage.test(attachment.mimeType))
      .map(async attachment => ({ attachmentId: attachment.id, contentId: attachment.contentId!,
        dataUrl: `data:${attachment.mimeType.toLowerCase()};base64,${(await this.attachment(id, attachment.id)).toString('base64')}` })));
    return { ...body, inlineImages };
  }
}
