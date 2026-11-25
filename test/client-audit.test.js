import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function auditReader(fetch) {
  let requestAudit;
  const edited = source.replace('    function AuditHistory(', '    expose(requestAudit);\n    function AuditHistory(');
  const window = { __ModuleLoader__: { load: module => module.factory(() => ({})) }, setTimeout, clearTimeout };
  runInNewContext(edited, { window, fetch, expose: read => { requestAudit = read; } });
  return requestAudit;
}

test('audit independently fetches safe event fields with same-origin credentials and no cache', async () => {
  const controller = new AbortController();
  const read = auditReader(async (path, options) => {
    assert.equal(path, '/dsh-lock-gate/audit');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal, controller.signal);
    return { ok: true, json: async () => ({ ok: true, durable: false, entries: [
      { at: 1700, kind: 'locked_schedule', scheduledAt: 1600, extra: 'discarded' },
      { at: 1690, kind: 'screen_locked_schedule', scheduledAt: 1600, extra: 'discarded' },
      { at: 1600, kind: 'unlocked_otp', scheduledAt: 1200 },
      { at: 1500, kind: 'smtp_failed', details: 'discarded' },
      { at: 1400, kind: 'unknown event' },
      { at: 1300, kind: 'constructor' },
      { at: '1200', kind: 'locked_manual' },
      null,
    ] }) };
  });
  assert.deepEqual(structuredClone(await read(controller)), { durable: false, entries: [
    { at: 1700, kind: 'locked_schedule', scheduledAt: 1600 },
    { at: 1690, kind: 'screen_locked_schedule', scheduledAt: 1600 },
    { at: 1600, kind: 'unlocked_otp' },
    { at: 1500, kind: 'smtp_failed' },
  ] });
});

test('audit rejects bad responses and caps the rendered feed', async () => {
  for (const response of [
    { ok: false, json: async () => assert.fail('failed response should not be parsed') },
    { ok: true, json: async () => ({ ok: true, entries: [] }) },
  ]) {
    const read = auditReader(async () => response);
    await assert.rejects(read(new AbortController()), /audit/i);
  }
  const entries = Array.from({ length: 510 }, (_, index) => ({ at: 510 - index, kind: 'locked_startup' }));
  const read = auditReader(async () => ({ ok: true, json: async () => ({ ok: true, durable: true, entries }) }));
  const result = await read(new AbortController());
  assert.equal(result.entries.length, 500);
  assert.equal(result.entries[0].at, 510);
  assert.equal(result.entries.at(-1).at, 11);
});
