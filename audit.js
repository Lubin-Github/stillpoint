import { z } from 'zod';

const DAY = 86_400_000;
export const RETENTION_MS = 15 * DAY;
export const MAX_ENTRIES = 500;
const RETRY_MS = 60_000;
const entryKind = z.enum([
  'locked_startup', 'locked_manual', 'screen_locked_schedule', 'locked_schedule', 'unlocked_otp',
  'smtp_failed', 'smtp_secret_error', 'otp_expired', 'auth_failed', 'auth_cooldown',
  'mail_rate_limited', 'storage_error', 'managed_start_failed', 'managed_stop_failed',
  'schedule_error', 'operation_failed',
]);
const timestamp = z.number().int().min(0).max(8.64e15);
const entrySchema = z.object({ at: timestamp, kind: entryKind, scheduledAt: timestamp.optional() }).strict();
export const auditDomainSpec = {
  name: 'dsh_lock_audit',
  version: 1,
  tables: {},
  global: { schema: z.object({ entries: z.array(entrySchema).max(MAX_ENTRIES) }).strict(), initial: { entries: [] } },
};

export class LockAudit {
  constructor({ domain, clock = Date.now, warn = () => {} } = {}) {
    this.domain = domain;
    this.clock = clock;
    this.warn = warn;
    this.entries = domain?.global.get().entries ?? [];
    this.durable = !!domain;
    this.dirty = false;
    this.retryAt = 0;
    this.pending = null;
  }

  prune() {
    const cutoff = this.clock() - RETENTION_MS;
    const kept = this.entries.filter(entry => entry.at > cutoff);
    if (kept.length === this.entries.length) return;
    this.entries = kept;
    this.dirty = true;
  }

  record(kind, scheduledAt) {
    const at = this.clock();
    const timedLock = kind === 'screen_locked_schedule' || kind === 'locked_schedule';
    const parsed = entrySchema.safeParse({ at, kind, ...(timedLock && { scheduledAt }) });
    if (!parsed.success) return;
    this.prune();
    this.entries = [parsed.data, ...this.entries].slice(0, MAX_ENTRIES);
    this.dirty = true;
    void this.flush();
  }

  view() {
    this.prune();
    void this.flush();
    return { entries: [...this.entries].sort((a, b) => b.at - a.at), durable: this.durable };
  }

  refresh() {
    this.prune();
    return this.flush();
  }

  flush(force = false) {
    if (!this.domain || !this.dirty || this.pending || (!force && this.clock() < this.retryAt)) return this.pending;
    const entries = this.entries;
    this.pending = Promise.resolve().then(() => this.domain.global.set({ entries })).then(() => {
      this.durable = true;
      this.retryAt = 0;
      this.dirty = this.entries !== entries;
    }, () => {
      if (this.durable) this.warn('Stillpoint 日志暂时无法写入，仅保留内存中的记录。');
      this.durable = false;
      this.retryAt = this.clock() + RETRY_MS;
    }).finally(() => {
      this.pending = null;
      if (this.durable && this.dirty) void this.flush();
    });
    return this.pending;
  }

  async close() {
    this.prune();
    while (this.pending) await this.pending;
    await this.flush(true);
    await this.domain?.close();
  }
}
