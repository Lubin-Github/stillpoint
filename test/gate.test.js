import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { API_PATH, AUDIT_PATH, apply, createRoute, hasActiveWork } from '../index.js';
import { DEFAULT_SCHEDULE, LockGate, precedingOccurrence } from '../gate.js';
import { ManagedPlugins } from '../managed.js';

const PASSWORD = 'fixture master password';
const SMTP_PASSWORD = 'fixture smtp authorization code';
const smtp = { host: 'smtp.example.com', port: 465, security: 'tls', user: 'mail@example.com', from: 'mail@example.com', to: 'inbox@example.com' };
const schedule = { ...DEFAULT_SCHEDULE, enabled: true };
const source = 'module.exports = (ctx) => { ctx.transitions.push("mount"); return () => ctx.transitions.push("unmount"); };';

function fakeCordis(transitions) {
  return {
    plugin(spec) {
      const start = spec.apply({ transitions });
      return { then: (...args) => start.then(...args), async dispose() { await (await start.catch(() => null))?.(); } };
    },
  };
}

function fixture({ isHostBusy } = {}) {
  let stored = null;
  let now = Date.parse('2026-11-25T09:56:00Z');
  const deliveries = [];
  const transitions = [];
  const events = [];
  let failNextWrite = false;
  const acquire = () => new LockGate({
    load: () => structuredClone(stored),
    persist: async snapshot => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('fixture storage write failed');
      }
      stored = structuredClone(snapshot);
    },
    managed: new ManagedPlugins(fakeCordis(transitions)),
    mail: async (details, password, code) => deliveries.push({ details, password, code }),
    clock: () => now,
    isHostBusy,
    record: (kind, scheduledAt) => events.push({ kind, scheduledAt }),
  });
  return {
    acquire, deliveries, transitions, events,
    advance: ms => { now += ms; },
    failNextWrite: () => { failNextWrite = true; },
    snapshot: () => stored,
  };
}

const act = (gate, action, fields) => gate.action({ action, masterPassword: PASSWORD, ...fields });

test('before SMTP verification, manual lock and scheduled lock cannot block setup', async () => {
  const f = fixture();
  const gate = f.acquire();
  await assert.rejects(act(gate, 'lock'), /请先配置 SMTP 并通过测试/);
  assert.equal(gate.state().smtpConfigured, false);
  await act(gate, 'save', { smtp: { ...smtp, password: SMTP_PASSWORD }, schedule });
  await gate.stop();

  const restarted = f.acquire();
  f.advance(4 * 60_000);
  await restarted.tick();
  await assert.rejects(act(restarted, 'lock'), /请先配置 SMTP 并通过测试/);
  assert.equal(restarted.state().mode, 'setup');
  assert.equal(restarted.state().smtpVerified, false);
  await restarted.stop();
});

test('Host boot injects setup, real lock and storage recovery as distinct states', async () => {
  const f = fixture();
  const configured = f.acquire();
  await act(configured, 'save', { smtp: { ...smtp, password: SMTP_PASSWORD }, schedule: DEFAULT_SCHEDULE });
  await act(configured, 'test');
  await configured.stop();

  const browserPeer = { id: 'browser' };
  const cases = [
    { stored: null, mode: 'setup' },
    { stored: f.snapshot(), mode: 'locked' },
    { stored: { corrupted: true }, mode: 'error', issue: 'storage' },
    { openFails: true, mode: 'error', issue: 'storage' },
  ];
  for (const { stored, mode, issue, openFails } of cases) {
    let injectIndex;
    let closed = false;
    let auditClosed = false;
    let auditStored = { entries: [] };
    const dispose = await apply({
      connection: { browserPeer },
      webServer: { register: () => () => {} },
      storageDomain: { open: async spec => {
        if (spec.name === 'dsh_lock_audit') return {
          global: { get: () => auditStored, set: async state => { auditStored = state; } },
          close: async () => { auditClosed = true; },
        };
        if (openFails) throw Object.assign(new Error('storage unavailable'), { code: 'EACCES' });
        return {
          global: { get: () => stored === null ? spec.global.initial : { snapshot: stored }, set: async () => assert.fail('startup should not write') },
          close: async () => { closed = true; },
        };
      } },
      logger: { warn() {} },
      on(event, listener) {
        assert.equal(event, 'webserver/index-inject');
        injectIndex = listener;
      },
    });
    try {
      const table = [];
      injectIndex(table, { id: 'different-peer' });
      assert.deepEqual(table, []);
      injectIndex(table, browserPeer);
      assert.deepEqual(table, [
        { kind: 'global', name: '__DSH_LOCK_GATE_BOOT__', value: {
          mode, ...(issue && { issue }), smtpConfigured: mode === 'locked', smtpVerified: mode === 'locked',
        } },
        { kind: 'global', name: '__DSH_LOCK_GATE_INITIAL__', value: mode === 'locked' },
      ]);
    } finally { await dispose(); }
    assert.equal(closed, !openFails);
    assert.equal(auditClosed, true);
    assert.deepEqual(auditStored.entries.map(entry => entry.kind),
      mode === 'locked' ? ['locked_startup'] : issue === 'storage' ? ['storage_error'] : []);
  }
});

test('SMTP setup, encrypted storage, scheduled lock, restart and OTP restore', async () => {
  const f = fixture();
  const gate = f.acquire();
  assert.equal(gate.state().mode, 'setup');
  assert.equal((await act(gate, 'save', { smtp: { ...smtp, password: SMTP_PASSWORD }, schedule })).smtpVerified, false);
  assert.equal((await act(gate, 'test')).mode, 'unlocked');
  assert.equal(f.deliveries[0].password, SMTP_PASSWORD);
  await act(gate, 'import', { name: 'fixture.cjs', source });
  assert.deepEqual(f.transitions, ['mount']);
  assert.equal(gate.state().managed[0].name, 'fixture.cjs');
  assert.equal(gate.state().managedCount, 1);
  const serialized = JSON.stringify(f.snapshot());
  for (const secret of [PASSWORD, SMTP_PASSWORD, source, 'fixture.cjs']) assert.ok(!serialized.includes(secret));

  const staged = { ...smtp, to: 'new-inbox@example.com' };
  const edited = await act(gate, 'save', { smtp: staged, schedule });
  assert.equal(edited.smtp.to, staged.to);
  assert.equal(edited.smtpVerified, false);
  assert.equal(f.snapshot().smtp.to, smtp.to);
  f.advance(4 * 60_000);
  await gate.tick();
  assert.equal(gate.state().mode, 'locked');
  assert.equal(gate.state().smtp, null);
  assert.equal(gate.state().managedCount, 0);
  assert.deepEqual(f.transitions, ['mount', 'unmount']);
  await gate.stop();

  const restarted = f.acquire();
  assert.equal(restarted.state().mode, 'locked');
  await assert.rejects(act(restarted, 'test'), { status: 409 });
  await assert.rejects(act(restarted, 'send', { masterPassword: 'not the fixture password' }), { status: 403 });
  await act(restarted, 'send');
  assert.equal(f.deliveries.at(-1).details.to, smtp.to);
  const { code } = f.deliveries.at(-1);
  assert.match(code, /^\d{6}$/);
  await assert.rejects(act(restarted, 'send'), { status: 429 });
  await assert.rejects(act(restarted, 'unlock', { code: code === '123456' ? '654321' : '123456' }), { status: 403 });
  const restored = await act(restarted, 'unlock', { code });
  assert.equal(restored.mode, 'unlocked');
  assert.deepEqual(f.transitions, ['mount', 'unmount', 'mount']);
  await assert.rejects(act(restarted, 'unlock', { code }), { status: 409 });
  f.advance(60_000);
  const verified = await act(restarted, 'test');
  assert.equal(verified.smtpVerified, true);
  assert.equal(f.snapshot().smtp.to, staged.to);
  assert.deepEqual(f.events, [
    { kind: 'screen_locked_schedule', scheduledAt: Date.parse('2026-11-25T10:00:00Z') },
    { kind: 'locked_schedule', scheduledAt: Date.parse('2026-11-25T10:00:00Z') },
    { kind: 'locked_startup', scheduledAt: undefined },
    { kind: 'auth_failed', scheduledAt: undefined },
    { kind: 'mail_rate_limited', scheduledAt: undefined },
    { kind: 'auth_failed', scheduledAt: undefined },
    { kind: 'unlocked_otp', scheduledAt: undefined },
  ]);
  await act(restarted, 'remove', { id: restored.managed[0].id });
  assert.equal(restarted.state().managedCount, 0);
  await restarted.stop();
});

test('OTP expiry and durable cooldown after five failures', async () => {
  const f = fixture();
  const gate = f.acquire();
  await act(gate, 'save', { smtp: { ...smtp, password: SMTP_PASSWORD }, schedule });
  await act(gate, 'test');
  await gate.action({ action: 'activity', active: true, clientId: 'c'.repeat(32) });
  await act(gate, 'lock');
  assert.equal(gate.state().mode, 'locked');
  f.advance(60_000);
  await act(gate, 'send');
  f.advance(600_000);
  await assert.rejects(act(gate, 'unlock', { code: f.deliveries.at(-1).code }), { status: 409 });
  await act(gate, 'send');
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(act(gate, 'unlock', { code: 'invalid' }), { status: attempt < 4 ? 403 : 429 });
  }
  await gate.stop();
  const restarted = f.acquire();
  await assert.rejects(act(restarted, 'send'), { status: 429 });
  f.advance(300_000);
  await act(restarted, 'send');
  await restarted.stop();
});

test('scheduled lock waits for all foreground clients, then lets detected work finish before unloading', async () => {
  let hostBusy = true;
  const f = fixture({ isHostBusy: () => hostBusy });
  const gate = f.acquire();
  try {
    await act(gate, 'save', { smtp: { ...smtp, password: SMTP_PASSWORD }, schedule });
    await act(gate, 'test');
    await act(gate, 'import', { name: 'fixture.cjs', source });
    const lastTick = f.snapshot().lastTick;
    const scheduledAt = Date.parse('2026-11-25T10:00:00Z');
    const first = 'a'.repeat(32);
    const second = 'b'.repeat(32);
    const activity = (clientId, active) => gate.action({ action: 'activity', clientId, active });
    f.advance(4 * 60_000);
    await assert.rejects(activity('bad-id', true), { status: 400 });
    await activity(first, true);
    await activity(second, true);
    await activity(first, false);
    f.advance(24_999);
    await gate.tick();
    assert.equal(gate.state().mode, 'unlocked');
    assert.equal(gate.state().deferredLock, true);
    assert.equal(f.snapshot().lastTick, lastTick);

    f.advance(1);
    await gate.tick();
    await gate.tick();
    assert.equal(gate.state().mode, 'locked');
    assert.equal(gate.state().draining, true);
    assert.equal(gate.state().deferredLock, undefined);
    assert.equal(gate.key, undefined);
    assert.equal(f.snapshot().lastTick, scheduledAt);
    assert.deepEqual(f.transitions, ['mount']);
    assert.deepEqual(f.events, [{ kind: 'screen_locked_schedule', scheduledAt }]);
    await assert.rejects(act(gate, 'test'), { status: 409 });

    // Input on the lock screen does not postpone unloading once work ends.
    await activity(first, true);
    hostBusy = false;
    await gate.tick();
    await gate.tick();
    assert.equal(gate.state().mode, 'locked');
    assert.equal(gate.state().draining, undefined);
    assert.deepEqual(f.transitions, ['mount', 'unmount']);
    assert.deepEqual(f.events, [
      { kind: 'screen_locked_schedule', scheduledAt },
      { kind: 'locked_schedule', scheduledAt },
    ]);
    await act(gate, 'send');
    await act(gate, 'unlock', { code: f.deliveries.at(-1).code });
    assert.deepEqual(f.transitions, ['mount', 'unmount', 'mount']);
  } finally { await gate.stop(); }
});

test('OTP unlock during task drain keeps existing plugins mounted and consumes that schedule', async () => {
  let hostBusy = true;
  const f = fixture({ isHostBusy: () => hostBusy });
  const gate = f.acquire();
  try {
    await act(gate, 'save', { smtp: { ...smtp, password: SMTP_PASSWORD }, schedule });
    await act(gate, 'test');
    await act(gate, 'import', { name: 'fixture.cjs', source });
    f.advance(4 * 60_000);
    await gate.tick();
    assert.equal(gate.state().draining, true);
    await act(gate, 'send');
    f.failNextWrite();
    await assert.rejects(act(gate, 'unlock', { code: f.deliveries.at(-1).code }), { status: 503 });
    assert.equal(gate.state().draining, true);
    assert.deepEqual(f.transitions, ['mount']);
    f.advance(60_000);
    await act(gate, 'send');
    await act(gate, 'unlock', { code: f.deliveries.at(-1).code });
    hostBusy = false;
    await gate.tick();
    assert.equal(gate.state().mode, 'unlocked');
    assert.deepEqual(f.transitions, ['mount']);
    assert.deepEqual(f.events.map(event => event.kind), ['screen_locked_schedule', 'storage_error', 'unlocked_otp']);
  } finally { await gate.stop(); }
});

test('live Agent turns and registered background jobs count as active work', () => {
  const agent = { id: 'child', status: 'idle' };
  const agents = { list: () => [agent] };
  const registry = new Map();
  const jobs = { list: owner => registry.get(owner) ?? [] };
  assert.equal(hasActiveWork(agents, jobs), false);
  agent.status = 'running';
  assert.equal(hasActiveWork(agents, jobs), true);
  agent.status = 'idle';
  registry.set(agent.id, [{ status: 'stopping' }]);
  assert.equal(hasActiveWork(agents, jobs), true);
  registry.set(agent.id, [{ status: 'completed' }]);
  registry.set(undefined, [{ status: 'running' }]);
  assert.equal(hasActiveWork(agents, jobs), true);
  registry.clear();
  assert.equal(hasActiveWork(agents, jobs), false);
});

test('Cron recognizes the exact scheduled minute in the configured time zone', () => {
  const exact = Date.parse('2026-11-25T10:00:00Z');
  assert.equal(precedingOccurrence(schedule, exact), exact);
  assert.equal(precedingOccurrence(schedule, exact - 1), exact - 86_400_000);
});

test('Host route admits only the current browser peer and same-origin JSON writes', async t => {
  const browserPeer = { id: 'browser' };
  const connection = { browserPeer, admit: req => {
    if (req.headers.cookie === 'test=browser') return { peer: browserPeer };
    if (req.headers.authorization) return { peer: { id: 'api-peer' } };
    return { rejection: 401 };
  } };
  const state = { mode: 'setup' };
  const gateRoute = createRoute(connection, { state: () => state, action: payload => ({ ...state, action: payload.action }) });
  const auditData = { entries: [{ at: 1, kind: 'locked_manual' }], durable: true };
  const auditRoute = createRoute(connection, { state: () => state }, { view: () => auditData });
  const server = createServer((req, res) => (req.url === AUDIT_PATH ? auditRoute : gateRoute)(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}${API_PATH}`;
  const cookie = 'test=browser';
  const get = await fetch(url, { headers: { cookie } });
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await get.json(), { ok: true, state });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer fake' } })).status, 403);
  const post = options => fetch(url, { method: 'POST', body: JSON.stringify({ action: 'test' }), ...options });
  assert.equal((await post({ headers: { cookie, 'content-type': 'application/json' } })).status, 403);
  assert.equal((await post({ headers: { cookie, origin: 'https://cross.example', 'content-type': 'application/json' } })).status, 403);
  assert.equal((await post({ headers: { cookie, origin, 'content-type': 'text/plain' } })).status, 415);
  assert.deepEqual(await (await post({ headers: { cookie, origin, 'content-type': 'application/json' } })).json(), { ok: true, state: { mode: 'setup', action: 'test' } });
  const desktop = { cookie, 'x-dsh-lock-gate': '1', 'content-type': 'application/json' };
  assert.equal((await post({ headers: { ...desktop, origin: 'https://cross.example' } })).status, 403);
  assert.equal((await post({ headers: { ...desktop, cookie: '' } })).status, 401);
  assert.equal((await post({ headers: { ...desktop, cookie: '', authorization: 'Bearer fake' } })).status, 403);
  assert.deepEqual(await (await post({ headers: desktop })).json(), { ok: true, state: { mode: 'setup', action: 'test' } });

  const auditUrl = `${origin}${AUDIT_PATH}`;
  assert.equal((await fetch(auditUrl)).status, 401);
  assert.equal((await fetch(auditUrl, { headers: { authorization: 'Bearer fake' } })).status, 403);
  assert.equal((await fetch(auditUrl, { headers: { cookie, origin: 'https://cross.example' } })).status, 403);
  assert.equal((await fetch(auditUrl, { method: 'POST', headers: { cookie, origin } })).status, 405);
  const history = await fetch(auditUrl, { headers: { cookie } });
  assert.equal(history.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await history.json(), { ok: true, ...auditData });
  state.mode = 'locked';
  assert.equal((await fetch(auditUrl, { headers: { cookie } })).status, 403);
});
