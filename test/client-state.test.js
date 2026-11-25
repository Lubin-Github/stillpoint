import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { CronExpressionParser } from 'cron-parser';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const ok = state => ({ ok: true, json: async () => ({ ok: true, state }) });

function startClient(t, { boot, legacyLocked, fetch, windowOverrides, documentOverrides, Date = globalThis.Date }) {
  const window = {
    __DSH_LOCK_GATE_BOOT__: boot,
    __DSH_LOCK_GATE_INITIAL__: legacyLocked,
    __ModuleLoader__: { load(module) { plugin = module.factory(() => ({})); } },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    ...windowOverrides,
  };
  const document = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperties(document, Object.getOwnPropertyDescriptors(documentOverrides ?? {}));
  let plugin;
  runInNewContext(source, { window, document, fetch, AbortController, Date });
  let service;
  const cleanups = [];
  plugin.apply({
    effect(activate) { cleanups.push(activate()); },
    locale: { register: () => () => {}, bind: () => () => {} },
    slots: {
      inject(_name, register) { register(); },
      register(options) { ({ service } = options.inject()); },
    },
  });
  t.after(() => { for (const cleanup of cleanups) cleanup(); });
  return service;
}

function waitForStatus(service, wanted) {
  if (service.getSnapshot().status === wanted) return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = service.subscribe(() => {
      if (service.getSnapshot().status !== wanted) return;
      unsubscribe();
      resolve();
    });
  });
}

test('known setup preserves the state and refuses stale settings writes on failed read', { timeout: 3000 }, async t => {
  let shouldFail = false;
  let writes = 0;
  const service = startClient(t, {
    boot: { mode: 'setup', smtpConfigured: false }, legacyLocked: true,
    fetch: async (_url, options) => {
      if (options.method === 'POST') writes++;
      if (shouldFail) throw new Error('offline');
      return ok({ mode: 'setup', smtpConfigured: false });
    },
  });
  assert.equal(service.getSnapshot().mode, 'setup');
  await waitForStatus(service, 'ready');
  await new Promise(setImmediate); // Let the successful read release its in-flight slot.
  const knownState = service.getSnapshot().state;
  shouldFail = true;
  await service.refresh();
  assert.equal(service.getSnapshot().status, 'unavailable');
  assert.equal(service.getSnapshot().mode, 'setup');
  assert.equal(service.getSnapshot().state, knownState);
  assert.equal(await service.post('save', {}), null);
  assert.equal(writes, 0);
});

test('known lock admits authenticated OTP POST after status-read failure', { timeout: 3000 }, async t => {
  const writes = [];
  const service = startClient(t, {
    boot: { mode: 'locked' },
    fetch: async (route, options) => {
      if (options.method === 'GET') throw new Error('status unavailable');
      writes.push(JSON.parse(options.body));
      assert.equal(route, '/dsh-lock-gate/api');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.headers['X-DSH-Lock-Gate'], '1');
      return ok({ mode: 'unlocked' });
    },
  });
  await waitForStatus(service, 'unavailable');
  assert.equal(service.getSnapshot().mode, 'locked');
  await service.post('unlock', { masterPassword: 'fixture master password', code: '123456' });
  assert.equal(writes[0]?.action, 'unlock');
  assert.equal(service.getSnapshot().mode, 'unlocked');
  assert.equal(service.getSnapshot().status, 'ready');
});

test('scheduled lock keeps OTP operations available as the drain phase completes', { timeout: 3000 }, async t => {
  const writes = [];
  let hostState = { mode: 'locked', draining: true };
  const service = startClient(t, {
    boot: hostState,
    fetch: async (_route, options) => {
      if (options.method === 'GET') return ok(hostState);
      const request = JSON.parse(options.body);
      writes.push(request.action);
      if (request.action === 'unlock') hostState = { mode: 'unlocked' };
      return ok(hostState);
    },
  });
  assert.equal(service.getSnapshot().draining, true);
  await waitForStatus(service, 'ready');
  assert.equal(service.getSnapshot().draining, true);
  assert.equal((await service.post('send', { masterPassword: 'fixture master password' })).ok, true);
  assert.equal(service.getSnapshot().mode, 'locked');
  hostState = { mode: 'locked' };
  await service.refresh();
  assert.equal(service.getSnapshot().mode, 'locked');
  assert.equal(service.getSnapshot().draining, false);
  assert.equal((await service.post('unlock', { masterPassword: 'fixture master password', code: '123456' })).ok, true);
  assert.deepEqual(writes, ['send', 'unlock']);
  assert.equal(service.getSnapshot().mode, 'unlocked');
  assert.equal(service.getSnapshot().draining, false);
});

test('host-provided storage and cleanup errors retain distinct issue identifiers', { timeout: 3000 }, async t => {
  const service = startClient(t, {
    boot: { mode: 'error', issue: 'storage' },
    fetch: async () => ok({ mode: 'error', issue: 'cleanup' }),
  });
  assert.equal(service.getSnapshot().issue, 'storage');
  await waitForStatus(service, 'ready');
  assert.equal(service.getSnapshot().issue, 'cleanup');
  assert.equal(await service.post('send', {}), null);
});

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    fire(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
  };
}

function fakeActivityClock() {
  let now = 100_000;
  let nextId = 0;
  const queued = new Map();
  return {
    Date: { now: () => now },
    setTimeout(run, delay) {
      const id = ++nextId;
      queued.set(id, { run, at: now + delay });
      return id;
    },
    clearTimeout: id => queued.delete(id),
    async advance(ms) {
      now += ms;
      for (const [id, job] of [...queued]) {
        if (!queued.has(id) || job.at > now) continue;
        queued.delete(id);
        job.run();
      }
      await new Promise(setImmediate);
    },
  };
}

test('activity lease requires fresh trusted input and lifts on blur, hide or idle', async t => {
  const clock = fakeActivityClock();
  const events = eventTarget();
  const docEvents = eventTarget();
  let focused = true;
  let hidden = false;
  const activity = [];
  const service = startClient(t, {
    boot: { mode: 'unlocked' },
    Date: clock.Date,
    windowOverrides: { ...clock, ...events, crypto: { getRandomValues: bytes => bytes.fill(0xab) } },
    documentOverrides: { ...docEvents, hasFocus: () => focused, get hidden() { return hidden; } },
    fetch: async (url, options) => {
      if (options.method === 'GET') return ok({ mode: 'unlocked', deferredLock: true });
      const body = JSON.parse(options.body);
      activity.push(body);
      assert.equal(url, '/dsh-lock-gate/api');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.headers['X-DSH-Lock-Gate'], '1');
      return ok({ mode: 'locked' }); // This response is deliberately older than the poll state.
    },
  });
  await waitForStatus(service, 'ready');
  events.fire('focus');
  events.fire('pointerdown', { isTrusted: false });
  await clock.advance(10_000);
  assert.deepEqual(activity, []);

  events.fire('keydown', { isTrusted: true });
  events.fire('wheel', { isTrusted: true });
  await clock.advance(9_999);
  assert.deepEqual(activity.map(row => row.active), [true]);
  await clock.advance(1);
  assert.deepEqual(activity.map(row => row.active), [true, true]);
  assert.equal(service.getSnapshot().mode, 'unlocked');
  assert.equal(service.getSnapshot().state.deferredLock, true);

  focused = false;
  events.fire('blur');
  events.fire('pointerdown', { isTrusted: true });
  await clock.advance(100);
  focused = true;
  events.fire('focus');
  assert.deepEqual(activity.map(row => row.active), [true, true, false]);

  events.fire('pointerdown', { isTrusted: true });
  await clock.advance(90_000); // Simulate a delayed timer after waking from sleep.
  events.fire('focus');
  assert.deepEqual(activity.map(row => row.active), [true, true, false, true, false]);

  events.fire('pointerdown', { isTrusted: true });
  await clock.advance(100);
  hidden = true;
  docEvents.fire('visibilitychange');
  await clock.advance(100);
  hidden = false;
  docEvents.fire('visibilitychange');
  assert.deepEqual(activity.map(row => row.active), [true, true, false, true, false, true, false]);
  assert.ok(activity.every(row => row.action === 'activity' && row.clientId === 'ab'.repeat(16)));
});

// Expose the calculations only inside this test VM. The Client factory's API is unchanged.
function scheduleHelpers() {
  let helpers;
  const edited = source.replace('    const DEFAULT_SMTP =',
    '    exposeSchedule({ weeklyFromCron, cronFromWeekly, scheduleDraft });\n    const DEFAULT_SMTP =');
  runInNewContext(edited, {
    window: { __ModuleLoader__: { load: module => module.factory(() => ({})) } },
    exposeSchedule: value => { helpers = value; },
  });
  return helpers;
}

test('weekly editor preserves existing expressions and emits a matching schedule for new day selections', () => {
  const { weeklyFromCron, cronFromWeekly } = scheduleHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(weeklyFromCron('0 18 * * 1-5'))), { time: '18:00', days: [1, 2, 3, 4, 5] });
  assert.equal(cronFromWeekly({ time: '18:00', days: [0, 6] }, '0 18 * * 6-7'), '0 18 * * 6-7');
  assert.equal(cronFromWeekly({ time: '18:00', days: [1, 2, 3, 4, 5, 6, 0] }, '0 18 * * 1-5'), '0 18 * * *');
  const cron = cronFromWeekly({ time: '17:45', days: [5, 1] }, '0 18 * * 1-5');
  assert.equal(cron, '45 17 * * 1,5');
  const parsed = CronExpressionParser.parse(cron, { tz: 'Asia/Shanghai', currentDate: '2026-11-25T00:00:00Z' });
  assert.equal(parsed.next().toISOString(), '2026-11-27T09:45:00.000Z');
  assert.equal(parsed.next().toISOString(), '2026-11-30T09:45:00.000Z');
  assert.equal(cronFromWeekly({ time: '18:00', days: [] }, '0 18 * * 1-5'), '');
  assert.equal(cronFromWeekly({ time: '', days: [1] }, '0 18 * * 1-5'), '');
});

test('existing multi-time or calendar rules open in advanced mode with the original value', () => {
  const { scheduleDraft } = scheduleHelpers();
  for (const cron of ['0 9,18 * * 1-5', '30 18 1 * *', '*/15 18 * * 1-5', '0 18 * * 1#2']) {
    const draft = scheduleDraft({ cron, enabled: true, timezone: 'Asia/Shanghai' });
    assert.equal(draft.advanced, true);
    assert.equal(draft.cron, cron);
    assert.equal(draft.enabled, true);
  }
});
