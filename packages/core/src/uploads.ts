import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailStore } from '@mail/db';
import { MAX_ATTACHMENT_BYTES, uploadMetadataSchema, type Upload } from '@mail/shared';

export type OutgoingAttachment = { filename: string; mimeType: string; content: Buffer };

export class UploadStore {
  constructor(private store: MailStore, private directory: string) {}
  async save(filename: string, mimeType: string, content: Buffer): Promise<Upload> {
    const parsed = uploadMetadataSchema.safeParse({ filename, mimeType: mimeType || 'application/octet-stream', size: content.length });
    if (!parsed.success) throw new Error('附件名称、类型或大小不正确，单封附件总大小上限为 20 MiB');
    const upload = { ...parsed.data, id: randomUUID(), createdAt: Date.now() };
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${upload.id}.bin`), content);
    this.store.addUpload(upload);
    return upload;
  }
  metadata(ids: string[]): Upload[] {
    const uploads = ids.map(id => {
      const upload = this.store.upload(id);
      if (!upload) throw new Error('附件已不存在，请重新添加');
      return upload;
    });
    if (uploads.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 20 MiB');
    return uploads;
  }
  async attachments(ids: string[]): Promise<OutgoingAttachment[]> {
    return Promise.all(this.metadata(ids).map(async file => {
      try { return { filename: file.filename, mimeType: file.mimeType, content: await readFile(join(this.directory, `${file.id}.bin`)) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('附件文件已丢失，请重新添加'); throw error; }
    }));
  }
  async removeUnused(ids: string[]) {
    for (const id of new Set(ids)) {
      if (!this.store.upload(id) || this.store.uploadInUse(id)) continue;
      this.store.removeUpload(id);
      try { await unlink(join(this.directory, `${id}.bin`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  async cleanup() { await this.removeUnused(this.store.unusedUploads(Date.now() - 86_400_000).map(file => file.id)); }
}
