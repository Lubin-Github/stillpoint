import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { addItem, authenticateVault, createVault, listItems, removeItem, validatePassword, validateVault } from './vault.js';
import { deliverMail, openSmtp, sameSmtpAccount, sealSmtp, smtpEnvelopeSchema, smtpSchema } from './mail.js';

export const DEFAULT_SCHEDULE = { enabled: false, cron: '0 18 * * 1-5', timezone: 'Asia/Shanghai' };
const scheduleSchema = z.object({ enabled: z.boolean(), cron: z.string().trim().min(1).max(100), timezone: z.string().trim().min(1).max(80) }).strict();
const timestamp = z.number().int().nonnegative();
const snapshotSchema = z.object({
  smtp: smtpSchema,
  envelope: smtpEnvelopeSchema,
  verified: z.boolean(),
  pendingSmtp: z.object({ smtp: smtpSchema, envelope: smtpEnvelopeSchema }).strict().optional(),
  schedule: scheduleSchema,
  lastTick: timestamp,
  mailTimes: z.array(timestamp).max(5),
  failureCount: z.number().int().min(0).max(4),
  retryAt: timestamp,
  vault: z.unknown(),
}).strict();

function parseSchedule(input) {
  const schedule = scheduleSchema.parse(input);
  if (schedule.cron.split(/\s+/).length !== 5) throw new Error('five-field cron required');
  new Intl.DateTimeFormat('en', { timeZone: schedule.timezone });
  precedingOccurrence(schedule, Date.now());
  return schedule;
}

export function precedingOccurrence(schedule, now) {
  return CronExpressionParser.parse(schedule.cron, {
    tz: schedule.timezone,
    currentDate: new Date(now + 1),
  }).prev().toDate().getTime();
}

export function parseSnapshot(input) {
  if (input === null) return null;
  const result = snapshotSchema.parse(input);
  return { ...result, schedule: parseSchedule(result.schedule), vault: validateVault(result.vault) };
}

export class GateError extends Error {
  constructor(message, status = 400, retryAt) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
  }
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const codeHash = (secret, value) => createHmac('sha256', secret).update(value).digest();

const UI_LEASE_MS = 25_000;
const MAX_UI_LEASES = 64;
const activitySchema = z.object({
  action: z.literal('activity'),
  active: z.boolean(),
  clientId: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

export class LockGate {
  constructor({ load, persist, managed, mail = deliverMail, clock = Date.now, record = () => {}, isHostBusy = () => false }) {
    Object.assign(this, { persist, managed, mail, clock, record, isHostBusy });
    this.activityLeases = new Map();
    this.deferredLock = false;
    this.drainingSinceSchedule = null;
    this.mode = 'error';
    this.snapshot = null;
    try {
      this.snapshot = parseSnapshot(load());
      this.mode = this.snapshot?.verified ? 'locked' : 'setup';
    } catch {
      this.issue = 'storage';
    }
    if (this.mode === 'locked') this.audit('locked_startup');
    if (this.issue === 'storage') this.audit('storage_error');
  }

  audit(kind, scheduledAt) {
    try { this.record(kind, scheduledAt); } catch {
      // A logging failure must never change the result of a lock operation.
    }
  }

  state() {
    const mode = this.mode;
    const canConfigure = mode === 'setup' || mode === 'unlocked';
    return {
      mode,
      ...(mode === 'error' && { issue: this.issue ?? 'cleanup' }),
      ...(mode === 'unlocked' && this.snapshot?.schedule.enabled && this.deferredLock && { deferredLock: true }),
      ...(mode === 'locked' && this.drainingSinceSchedule !== null && { draining: true }),
      smtp: canConfigure ? this.snapshot?.pendingSmtp?.smtp ?? this.snapshot?.smtp ?? null : null,
      smtpConfigured: !!this.snapshot,
      smtpVerified: !!this.snapshot?.verified && !this.snapshot.pendingSmtp,
      schedule: canConfigure ? this.snapshot?.schedule ?? DEFAULT_SCHEDULE : DEFAULT_SCHEDULE,
      managedCount: this.snapshot?.vault.items.length ?? 0,
      managed: mode === 'unlocked' ? this.managed.list() : [],
    };
  }

  run(task) {
    if (this.stopping) throw new GateError('Stillpoint 正在停止。', 503);
    if (this.pending) throw new GateError('有操作正在处理，请稍后重试。', 409);
    const pending = Promise.resolve().then(task);
    this.pending = pending;
    return pending.finally(() => { if (this.pending === pending) this.pending = null; });
  }

  async commit(next, { logFailure = true } = {}) {
    try { await this.persist(next); } catch {
      if (logFailure) this.audit('storage_error');
      throw new GateError('无法保存Stillpoint 数据，请检查 DSH 存储后重试。', 503);
    }
    this.snapshot = next;
  }

  pruneActivity(now) {
    for (const [clientId, expiresAt] of this.activityLeases) {
      if (expiresAt <= now) this.activityLeases.delete(clientId);
    }
  }

  reportActivity(body) {
    const result = activitySchema.safeParse(body);
    if (!result.success) throw new GateError('界面活动状态无效。');
    const { active, clientId } = result.data;
    const now = this.clock();
    this.pruneActivity(now);
    this.activityLeases.delete(clientId);
    if (!active || this.stopping) return;
    if (this.activityLeases.size >= MAX_UI_LEASES) {
      this.activityLeases.delete(this.activityLeases.keys().next().value);
    }
    this.activityLeases.set(clientId, now + UI_LEASE_MS);
  }

  async action(body) {
    if (body?.action === 'activity') {
      this.reportActivity(body);
      return this.state();
    }
    return this.run(async () => {
      if (this.mode === 'error') throw new GateError('Stillpoint 数据或插件状态异常，请保留原数据并检查 DSH。', 503);
      try {
        switch (body?.action) {
          case 'save': await this.save(body); break;
          case 'test': await this.test(body); break;
          case 'lock': await this.lock('locked_manual'); break;
          case 'send': await this.send(body); break;
          case 'unlock': await this.unlock(body); break;
          case 'import': await this.importItem(body); break;
          case 'remove': await this.removeItem(body); break;
          default: throw new GateError('未知操作。');
        }
        return this.state();
      } catch (error) {
        if (!(error instanceof GateError)) this.audit('operation_failed');
        throw error;
      }
    });
  }

  assertMode(...modes) {
    if (!modes.includes(this.mode)) throw new GateError('当前状态下不能执行此操作。', 409);
  }

  assertCooldown() {
    if (this.snapshot.retryAt > this.clock()) {
      throw new GateError('尝试次数过多，请稍后再试。', 429, this.snapshot.retryAt);
    }
  }

  async denyAttempt() {
    this.audit('auth_failed');
    const failures = this.snapshot.failureCount + 1;
    const retryAt = failures >= 5 ? this.clock() + 5 * MINUTE : 0;
    await this.commit({ ...this.snapshot, failureCount: retryAt ? 0 : failures, retryAt });
    if (retryAt) {
      this.audit('auth_cooldown');
      this.clearCode();
      throw new GateError('尝试次数过多，请 5 分钟后重试。', 429, retryAt);
    }
    throw new GateError('主密码或验证码有误。', 403);
  }

  async authenticate(password) {
    this.assertCooldown();
    try { return await authenticateVault(this.snapshot.vault, password); } catch { return this.denyAttempt(); }
  }

  async reauthenticate(password) {
    const candidate = await this.authenticate(password);
    candidate.fill(0);
  }

  async save(body) {
    this.assertMode('setup', 'unlocked');
    let smtp;
    let password;
    let schedule;
    try {
      const { password: supplied, ...details } = body.smtp;
      smtp = smtpSchema.parse(details);
      password = z.string().parse(supplied ?? '');
      if (Buffer.byteLength(password) > 1024 || /[\u0000\r\n]/u.test(password)) throw new Error('invalid credential');
      schedule = parseSchedule(body.schedule);
    } catch { throw new GateError('请检查 SMTP 字段、五段 Cron 表达式和 IANA 时区。'); }
    const old = this.snapshot;
    const previous = old?.pendingSmtp ?? old;
    const changed = JSON.stringify(smtp) !== JSON.stringify(previous?.smtp);
    const accountChanged = !sameSmtpAccount(previous?.smtp, smtp);
    if (!password && accountChanged) throw new GateError('请填写该 SMTP 账户的授权码。');
    let key;
    let committed = false;
    try {
      let vault;
      if (old) {
        key = await this.authenticate(body.masterPassword);
        vault = old.vault;
      } else {
        try { validatePassword(body.masterPassword); } catch {
          throw new GateError('主密码至少 12 个字符且不超过 512 字节。');
        }
        ({ vault, key } = await createVault(body.masterPassword));
      }
      const scheduleChanged = JSON.stringify(schedule) !== JSON.stringify(old?.schedule);
      let envelope = previous?.envelope;
      if (password) envelope = sealSmtp(key, smtp, password);
      else if (changed) {
        try { envelope = sealSmtp(key, smtp, openSmtp(key, previous.smtp, previous.envelope)); } catch {
          this.audit('smtp_secret_error');
          throw new GateError('SMTP 授权码密文无法读取，请重新填写授权码。', 409);
        }
      }
      const mailSettings = old?.verified ? {
        smtp: old.smtp,
        envelope: old.envelope,
        verified: true,
        ...((changed || password || old.pendingSmtp) && { pendingSmtp: { smtp, envelope } }),
      } : { smtp, envelope, verified: false };
      await this.commit({
        ...mailSettings, schedule, vault,
        lastTick: scheduleChanged ? this.clock() : old.lastTick,
        mailTimes: old?.mailTimes ?? [], failureCount: 0, retryAt: 0,
      });
      committed = true;
      if (scheduleChanged) this.deferredLock = false;
      this.key?.fill(0);
      this.key = key;
    } finally {
      if (!committed) key?.fill(0);
    }
  }

  async reserveMail() {
    const now = this.clock();
    const mailTimes = this.snapshot.mailTimes.filter(time => now - time < HOUR);
    const interval = (mailTimes.at(-1) ?? 0) + MINUTE;
    const quota = mailTimes.length === 5 ? mailTimes[0] + HOUR : 0;
    const retryAt = Math.max(interval, quota);
    if (retryAt > now) {
      this.audit('mail_rate_limited');
      throw new GateError('发信频率已达上限，请稍后再试。', 429, retryAt);
    }
    await this.commit({ ...this.snapshot, mailTimes: [...mailTimes, now] });
  }

  async sendMail(key, code, { smtp, envelope } = this.snapshot) {
    let password;
    try {
      password = openSmtp(key, smtp, envelope);
    } catch {
      this.audit('smtp_secret_error');
      throw new GateError('SMTP 授权码密文无法读取。', 409);
    }
    try { await this.mail(smtp, password, code); } catch {
      this.audit('smtp_failed');
      throw new GateError('SMTP 发信失败，请检查服务器、TLS、账户授权码和收件地址。', 502);
    } finally { password = undefined; }
  }

  async test(body) {
    this.assertMode('setup', 'unlocked');
    if (!this.snapshot) throw new GateError('请先保存 SMTP 设置。');
    if (!this.key && !body.masterPassword) throw new GateError('请输入主密码后再发测试邮件。');
    const retainedKey = this.key;
    const key = retainedKey ?? await this.authenticate(body.masterPassword);
    try {
      await this.reserveMail();
      const tested = this.snapshot.pendingSmtp ?? { smtp: this.snapshot.smtp, envelope: this.snapshot.envelope };
      await this.sendMail(key, undefined, tested);
      const firstMount = this.mode === 'setup';
      if (firstMount) await this.mount(key);
      try {
        const { pendingSmtp: discarded, ...current } = this.snapshot;
        await this.commit({ ...current, ...tested, verified: true, failureCount: 0, retryAt: 0 });
      } catch (error) {
        if (firstMount) await this.disposeManaged();
        throw error;
      }
      this.key = key;
      this.mode = 'unlocked';
    } finally {
      if (this.key !== key && key !== retainedKey) key.fill(0);
    }
  }

  async lock(kind, scheduledAt, keepRunning = false) {
    if (!this.snapshot?.verified) throw new GateError('请先配置 SMTP 并通过测试，再锁定托管插件。', 409);
    this.assertMode('unlocked');
    this.mode = 'locked';
    this.key?.fill(0);
    this.key = undefined;
    this.clearCode();
    if (kind === 'locked_schedule') this.audit('screen_locked_schedule', scheduledAt);
    if (keepRunning) {
      this.drainingSinceSchedule = scheduledAt;
      return;
    }
    await this.disposeManaged();
    this.audit(kind, scheduledAt);
  }

  async disposeManaged() {
    try { await this.managed.unmountAll(); } catch {
      this.audit('managed_stop_failed');
      this.mode = 'error';
      throw new GateError('托管插件清理失败，请重启 DSH。', 503);
    }
  }

  async send(body) {
    this.assertMode('locked');
    const key = await this.authenticate(body.masterPassword);
    try {
      await this.reserveMail();
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await this.sendMail(key, code);
      this.clearCode();
      const secret = randomBytes(32);
      this.otp = { secret, digest: codeHash(secret, code), expiresAt: this.clock() + 10 * MINUTE };
    } finally { key.fill(0); }
  }

  async unlock(body) {
    this.assertMode('locked');
    this.assertCooldown();
    if (!this.otp || this.otp.expiresAt <= this.clock()) {
      this.audit('otp_expired');
      this.clearCode();
      throw new GateError('验证码尚未发出或已过期，请重新发送。', 409);
    }
    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) return this.denyAttempt();
    if (!timingSafeEqual(this.otp.digest, codeHash(this.otp.secret, body.code))) return this.denyAttempt();
    const key = await this.authenticate(body.masterPassword);
    try {
      if (this.otp.expiresAt <= this.clock()) {
        this.audit('otp_expired');
        this.clearCode();
        throw new GateError('验证码已过期，请重新发送。', 409);
      }
      const draining = this.drainingSinceSchedule !== null;
      const { schedule, lastTick } = this.snapshot;
      const consumed = schedule.enabled ? Math.max(lastTick, precedingOccurrence(schedule, this.clock())) : lastTick;
      this.clearCode();
      if (!draining) await this.mount(key);
      try {
        await this.commit({ ...this.snapshot, lastTick: consumed, failureCount: 0, retryAt: 0 });
      } catch (error) {
        if (!draining) await this.disposeManaged();
        throw error;
      }
      this.drainingSinceSchedule = null;
      this.key = key;
      this.mode = 'unlocked';
      this.audit('unlocked_otp');
    } finally { if (this.key !== key) key.fill(0); }
  }

  clearCode() {
    this.otp?.secret.fill(0);
    this.otp?.digest.fill(0);
    this.otp = undefined;
  }

  async mount(key) {
    try { await this.managed.mountAll(listItems(this.snapshot.vault, key)); } catch {
      this.audit('managed_start_failed');
      await this.disposeManaged();
      throw new GateError('托管插件启动失败，仍保留加密数据。', 409);
    }
  }

  async importItem(body) {
    this.assertMode('unlocked');
    if (!this.snapshot?.verified) throw new GateError('请先通过 SMTP 测试。');
    if (typeof body.name !== 'string' || !/^[^/\\\u0000-\u001f]+\.cjs$/i.test(body.name) ||
        typeof body.source !== 'string' || Buffer.byteLength(body.source) > 128 * 1024) {
      throw new GateError('请选择不超过 128 KiB 的独立 .cjs 插件。');
    }
    await this.reauthenticate(body.masterPassword);
    const item = { id: randomUUID(), name: body.name, source: body.source };
    let vault;
    try { vault = addItem(this.snapshot.vault, this.key, item); } catch {
      throw new GateError('插件文件无效，或已达到托管存储容量。');
    }
    try { await this.managed.mount(item); } catch {
      this.audit('managed_start_failed');
      throw new GateError('插件启动失败，请检查入口和依赖。');
    }
    try { await this.commit({ ...this.snapshot, vault }); } catch (error) {
      try { await this.managed.unmount(item.id); } catch {
        this.audit('managed_stop_failed');
        this.mode = 'error';
        this.key.fill(0);
        this.key = undefined;
      }
      throw error;
    }
  }

  async removeItem(body) {
    this.assertMode('unlocked');
    const item = listItems(this.snapshot.vault, this.key).find(item => item.id === body.id);
    if (!item) throw new GateError('找不到该托管插件。', 404);
    await this.reauthenticate(body.masterPassword);
    const vault = removeItem(this.snapshot.vault, this.key, item.id);
    try { await this.managed.unmount(item.id); } catch {
      this.audit('managed_stop_failed');
      this.mode = 'error';
      this.key.fill(0);
      this.key = undefined;
      throw new GateError('卸载插件失败，请重启 DSH。', 503);
    }
    try { await this.commit({ ...this.snapshot, vault }); } catch (error) {
      try { await this.managed.mount(item); } catch {
        this.audit('managed_start_failed');
        this.mode = 'error';
        this.key.fill(0);
        this.key = undefined;
      }
      throw error;
    }
  }

  async tick() {
    if (this.pending || this.stopping || !this.snapshot?.schedule.enabled || !this.snapshot.verified || this.mode === 'error') return;
    return this.run(async () => {
      const { schedule, lastTick } = this.snapshot;
      const now = this.clock();
      const latest = precedingOccurrence(schedule, now);
      this.deferredLock = false;

      if (this.drainingSinceSchedule !== null && !this.isHostBusy()) {
        const scheduledAt = this.drainingSinceSchedule;
        await this.disposeManaged();
        this.drainingSinceSchedule = null;
        this.audit('locked_schedule', scheduledAt);
      }

      if (latest <= lastTick) return;
      if (this.mode === 'unlocked') {
        this.pruneActivity(now);
        if (this.activityLeases.size) {
          this.deferredLock = true;
          return;
        }
        await this.lock('locked_schedule', latest, this.isHostBusy());
      }
      await this.commit({ ...this.snapshot, lastTick: latest }, { logFailure: false });
    });
  }

  async stop() {
    this.stopping = true;
    await this.pending?.catch(() => {});
    this.clearCode();
    this.key?.fill(0);
    this.key = undefined;
    await this.disposeManaged();
  }
}
