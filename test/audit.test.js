import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LockAudit, MAX_ENTRIES, RETENTION_MS } from '../audit.js';

test('audit persists only recent allowlisted events and prunes at the 15-day boundary', async () => {
  let now = 2 * RETENTION_MS;
  let stored = { entries: [
    { kind: 'locked_startup', at: now - RETENTION_MS },
    { kind: 'locked_manual', at: now - RETENTION_MS + 1 },
  ] };
  const domain = { global: { get: () => stored, set: async value => { stored = value; } }, close: async () => {} };
  const audit = new LockAudit({ domain, clock: () => now });
  await audit.refresh();
  assert.deepEqual(stored.entries.map(entry => entry.kind), ['locked_manual']);
  audit.record('smtp_failed', 'must not be stored');
  audit.record('unexpected raw error');
  await audit.close();
  assert.deepEqual(stored.entries, [
    { kind: 'smtp_failed', at: now },
    { kind: 'locked_manual', at: now - RETENTION_MS + 1 },
  ]);
  now += RETENTION_MS;
  const restarted = new LockAudit({ domain, clock: () => now });
  await restarted.refresh();
  assert.deepEqual(stored.entries, []);
  await restarted.close();
});

test('audit keeps at most 500 events and retries failed writes independently', async () => {
  let now = RETENTION_MS;
  let stored = { entries: [] };
  let shouldFail = true;
  let attempts = 0;
  const domain = { global: { get: () => stored, set: async value => {
    attempts++;
    if (shouldFail) throw new Error('private storage diagnostic');
    stored = value;
  } }, close: async () => {} };
  const audit = new LockAudit({ domain, clock: () => now });
  for (let i = 0; i <= MAX_ENTRIES; i++) {
    now++;
    audit.record('locked_schedule', now - 10);
  }
  await audit.refresh();
  assert.equal(audit.view().durable, false);
  assert.equal(audit.view().entries.length, MAX_ENTRIES);
  assert.equal(attempts, 1);
  shouldFail = false;
  now += 60_000;
  await audit.refresh();
  assert.equal(audit.view().durable, true);
  assert.equal(stored.entries.length, MAX_ENTRIES);
  assert.deepEqual(stored.entries[0], { kind: 'locked_schedule', at: now - 60_000, scheduledAt: now - 60_010 });
  await audit.close();
});
