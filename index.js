import { z } from 'zod';
import { GateError, LockGate } from './gate.js';
import { ManagedPlugins } from './managed.js';
import { auditDomainSpec, LockAudit } from './audit.js';

export const name = 'dsh-lock-gate';
export const inject = ['connection', 'webServer', 'storageDomain'];
export const API_PATH = '/dsh-lock-gate/api';
export const AUDIT_PATH = '/dsh-lock-gate/audit';
const MAX_BODY_BYTES = 800 * 1024; // Allow JSON-escaped source up to the 128 KiB import limit.
const domainSpec = {
  name: 'dsh_lock_gate',
  version: 1,
  tables: {},
  global: { schema: z.object({ snapshot: z.unknown() }).strict(), initial: { snapshot: null } },
};

function reply(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function isTrustedOrigin(req) {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  const scheme = req.socket.encrypted ? 'https:' : 'http:';
  const expected = URL.parse(`${scheme}//${host}`);
  if (!expected) return false;
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname);
  const localSocket = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (scheme === 'http:' && (!localHost || !localSocket)) return false;
  if (req.headers.origin !== undefined) return req.headers.origin === expected.origin;
  if (req.method === 'GET') return true;
  // Electron's authenticated proxy removes Origin. Require loopback and a
  // non-safelisted header that HTML forms and cross-origin no-CORS fetch cannot set.
  return localHost && localSocket && req.headers['x-dsh-lock-gate'] === '1';
}

async function readAction(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new GateError('需要 JSON 请求。', 415);
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new GateError('请求过大。', 413);
  let size = 0;
  const chunks = [];
  let raw;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.resume();
        throw new GateError('请求过大。', 413);
      }
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks, size);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch (error) {
    if (error instanceof GateError) throw error;
    throw new GateError('JSON 请求无效。');
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    raw?.fill(0);
  }
}

export function createRoute(connection, gate, audit) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && (audit || req.method !== 'POST')) {
        res.setHeader('Allow', audit ? 'GET' : 'GET, POST');
        throw new GateError('不支持此请求方法。', 405);
      }
      const admission = connection.admit(req);
      if ('rejection' in admission) throw new GateError('请通过 DSH 界面登录。', admission.rejection);
      if (admission.peer.id !== connection.browserPeer.id || !isTrustedOrigin(req)) {
        throw new GateError('请从此 DSH 实例的受信界面访问。', 403);
      }
      if (audit) {
        const { mode, issue } = gate.state();
        if (mode === 'locked' || (mode === 'error' && issue !== 'storage')) {
          throw new GateError('解锁后可在设置中查看锁定日志。', 403);
        }
        reply(res, 200, { ok: true, ...audit.view() });
        return;
      }
      const state = req.method === 'GET' ? gate.state() : await gate.action(await readAction(req));
      if (!res.destroyed) reply(res, 200, { ok: true, state });
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof GateError) {
        reply(res, error.status, { ok: false, error: error.message, ...(error.retryAt ? { retryAt: error.retryAt } : {}) });
      } else {
        reply(res, 500, { ok: false, error: 'Stillpoint 暂时不可用。' });
      }
    }
  };
}

export function hasActiveWork(agents, jobs) {
  const liveAgents = agents?.list() ?? [];
  if (liveAgents.some(agent => agent.status === 'running')) return true;
  if (!jobs) return false;
  const isLive = job => job.status === 'running' || job.status === 'stopping';
  if (jobs.list().some(isLive)) return true;
  return liveAgents.some(({ id }) => jobs.list(id).some(isLive));
}

export async function apply(ctx) {
  const connection = ctx.connection;
  const webServer = ctx.webServer;
  let domain;
  const logger = ctx.logger;
  const warn = message => logger.warn(message);
  let auditDomain;
  let audit;
  try {
    auditDomain = await ctx.storageDomain.open(auditDomainSpec);
    audit = new LockAudit({ domain: auditDomain, warn });
  } catch {
    warn('Stillpoint 无法打开日志存储，仅保留内存中的记录。');
    await auditDomain?.close().catch(() => {});
    audit = new LockAudit();
  }
  try {
    domain = await ctx.storageDomain.open(domainSpec);
  } catch (error) {
    const code = ['already-open', 'backend-not-found', 'facet-unsupported', 'version-mismatch', 'malformed-medium', 'invalid-record', 'EACCES', 'EPERM'].find(candidate => candidate === error?.code);
    logger.warn(`Stillpoint 无法打开存储（${code ?? 'unknown'}）。已保留现有数据。`);
  }
  const gate = new LockGate({
    load() {
      if (!domain) throw new Error('Missing lock storage.');
      return domain.global.get().snapshot;
    },
    persist: snapshot => domain.global.set({ snapshot }),
    managed: new ManagedPlugins(ctx),
    isHostBusy: () => hasActiveWork(ctx.get?.('agents'), ctx.get?.('jobs')),
    record: (kind, scheduledAt) => audit.record(kind, scheduledAt),
  });
  if (domain && gate.state().issue === 'storage') {
    logger.warn('Stillpoint 无法读取存储内容。已保留现有数据。');
  }
  let lastScheduleWarning = -Infinity;
  const catchUp = async () => {
    void audit.refresh();
    try { await gate.tick(); } catch {
      const now = Date.now();
      if (now - lastScheduleWarning >= 60_000) {
        lastScheduleWarning = now;
        audit.record('schedule_error');
        warn('Stillpoint 定时操作失败，将在下次检查时重试。');
      }
    }
  };

  let timer;
  const unregister = [];
  const dispose = async () => {
    clearInterval(timer);
    for (const unregisterRoute of unregister) unregisterRoute();
    try { await gate.stop(); } finally {
      try { await domain?.close(); } finally { await audit.close(); }
    }
  };
  try {
    ctx.on('webserver/index-inject', (table, peer) => {
      if (peer.id !== connection.browserPeer.id) return;
      const { mode, issue, draining, smtpConfigured, smtpVerified } = gate.state();
      table.push({
        kind: 'global', name: '__DSH_LOCK_GATE_BOOT__',
        value: { mode, ...(issue && { issue }), ...(draining && { draining }), smtpConfigured, smtpVerified },
      });
      // An older Client may be open during a live upgrade.
      table.push({ kind: 'global', name: '__DSH_LOCK_GATE_INITIAL__', value: mode === 'locked' });
    });
    unregister.push(webServer.register({ kind: 'exact', path: API_PATH, handler: createRoute(connection, gate) }));
    unregister.push(webServer.register({ kind: 'exact', path: AUDIT_PATH, handler: createRoute(connection, gate, audit) }));
    await catchUp();
    timer = setInterval(() => { void catchUp(); }, 5000);
    timer.unref();
    return dispose;
  } catch {
    await dispose();
    throw new Error('Stillpoint 初始化失败。');
  }
}
