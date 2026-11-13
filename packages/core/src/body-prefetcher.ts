import { setImmediate } from 'node:timers/promises';
import type { MailStore } from '@mail/db';
import type { MailAdapter } from './adapter';
import type { BodyCache } from './cache';
import type { MessageBody } from '@mail/shared';

type Job = { adapter: MailAdapter; cancelled: boolean; rescan: boolean; done: Promise<void> };

export class BodyPrefetcher {
  private enabled = false;
  private jobs = new Map<string, Job>();
  // Mail whose body cannot be read is left alone after a few attempts, until the next start.
  private failures = new Map<string, number>();

  constructor(private store: MailStore, private cache: BodyCache, private createAdapter: (id: string) => MailAdapter,
    private events: { change(id: string): void; error(id: string, error: unknown): void }) {}

  start() { this.enabled = true; }
  schedule(id: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const existing = this.jobs.get(id);
    if (existing) { existing.rescan = true; return existing.done; }
    if (!this.store.pendingBodies(id, 1).length) return Promise.resolve();
    const job: Job = { adapter: this.createAdapter(id), cancelled: false, rescan: false, done: Promise.resolve() };
    this.jobs.set(id, job);
    job.done = this.run(id, job).finally(() => { if (this.jobs.get(id) === job) this.jobs.delete(id); });
    return job.done;
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    this.jobs.delete(id);
    await Promise.allSettled([job.adapter.close(), job.done]);
  }
  async stop() {
    this.enabled = false;
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)));
  }
  private async run(id: string, job: Job) {
    let before: { date: number; id: string } | undefined;
    try {
      while (!job.cancelled) {
        if (job.rescan) { before = undefined; job.rescan = false; }
        const batch = this.store.pendingBodies(id, 20, before);
        if (!batch.length) return;
        let changed = false;
        try {
          for (const message of batch) {
            if (job.cancelled) return;
            if ((this.failures.get(message.id) ?? 0) >= 3) continue;
            await job.adapter.connect();
            let cached: MessageBody | null;
            let text: string;
            try {
              cached = await this.cache.stored(message.id);
              const location = this.store.messageLocations(message.id)[0];
              if (!location) continue;
              text = cached?.text ?? await job.adapter.bodyText(location.folder, location.uid);
            } catch (error) {
              if (job.cancelled) return;
              // A network error says nothing about the message; only failures of the message itself count.
              if (typeof (error as { code?: unknown }).code !== 'string') this.failures.set(message.id, (this.failures.get(message.id) ?? 0) + 1);
              this.events.error(id, error);
              continue;
            }
            if (job.cancelled) return;
            changed = (cached ? this.store.cacheBody(message.id, text) : this.store.indexBody(message.id, text)) || changed;
          }
        } finally { if (changed && !job.cancelled) this.events.change(id); }
        before = batch.at(-1);
        await setImmediate();
      }
    } catch (error) {
      if (!job.cancelled) this.events.error(id, error);
    } finally { await job.adapter.close(); }
  }
}
