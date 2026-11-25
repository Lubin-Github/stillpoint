import assert from 'node:assert/strict'
import { createHmac, hkdfSync } from 'node:crypto'
import { after, before, test } from 'node:test'
import {
  addItem, authenticateVault, createVault, listItems, openVault, removeItem, validatePassword, validateVault,
} from '../vault.js'

const PASSWORD = '独立・vault-password-🔐'
const WRONG_PASSWORD = 'incorrect-but-long'
const SECRET_ITEM = Object.freeze({
  id: 'plugin_alpha',
  name: 'Private plugin label 你好',
  source: 'throw new Error("source must never execute in the vault")\nmodule.exports = { apply() {} }\n',
})
const OTHER_ITEM = Object.freeze({ id: 'plugin-beta', name: 'Other label', source: 'module.exports = {}\r\n' })
const UNLOCK_ERROR = { message: 'Unable to unlock vault.' }

let initial
let key
let vault
before(async () => {
  const created = await createVault(PASSWORD)
  initial = created.vault
  key = created.key
  vault = addItem(addItem(initial, key, SECRET_ITEM), key, OTHER_ITEM)
})
after(() => key?.fill(0))

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function changeBytes(value) {
  const bytes = Buffer.from(value, 'base64url')
  bytes[0] ^= 1
  return bytes.toString('base64url')
}

function signTestSnapshot(input) {
  const domain = 'dsh-lock-gate/vault/v1'
  const { name, memoryKiB, iterations, parallelism, salt } = input.kdf
  const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.from(salt, 'base64url'), `${domain}/manifest`, 32))
  try {
    const mac = createHmac('sha256', macKey)
    mac.update(JSON.stringify([domain, input.version, name, memoryKiB, iterations, parallelism, salt, input.items.length]))
    for (const item of input.items) mac.update(`\n${JSON.stringify([item.id, item.iv, item.tag, item.ciphertext])}`)
    input.mac = mac.digest('base64url')
  } finally {
    macKey.fill(0)
  }
  return input
}

test('validates password code points and UTF-8 byte bounds without normalization', async () => {
  for (const valid of ['A'.repeat(12), '🔐'.repeat(12), '🔐'.repeat(128), ' '.repeat(12)]) {
    assert.doesNotThrow(() => validatePassword(valid))
  }
  for (const invalid of [null, 12, '', '🔐'.repeat(11), 'é'.repeat(257), '🔐'.repeat(128) + 'a', `a${'\ud800'.repeat(12)}`]) {
    assert.throws(() => validatePassword(invalid), /at least 12 characters and at most 512 UTF-8 bytes/)
  }
  await assert.rejects(createVault('too short'), /at least 12 characters/)
})

test('creates immutable encrypted snapshots and reopens after JSON persistence', async () => {
  assert.ok(Buffer.isBuffer(key))
  assert.equal(key.length, 32)
  const firstSnapshot = addItem(initial, key, SECRET_ITEM)
  assert.deepEqual(listItems(initial, key), [])
  assert.deepEqual(listItems(firstSnapshot, key), [SECRET_ITEM])
  assert.notEqual(firstSnapshot.items[0].iv, vault.items[0].iv)
  assert.notEqual(firstSnapshot.items[0].ciphertext, vault.items[0].ciphertext)
  for (const frozen of [vault, vault.kdf, vault.items, ...vault.items]) assert.ok(Object.isFrozen(frozen))
  const persisted = JSON.stringify(vault)
  for (const secret of [PASSWORD, SECRET_ITEM.name, SECRET_ITEM.source, OTHER_ITEM.name, OTHER_ITEM.source]) {
    assert.ok(!persisted.includes(secret))
  }
  assert.deepEqual(vault.items.map(({ id }) => id), [SECRET_ITEM.id, OTHER_ITEM.id])

  const supplied = JSON.parse(persisted)
  const opening = openVault(supplied, PASSWORD)
  supplied.items.length = 0
  const opened = await opening
  try {
    assert.deepEqual(opened.key, key)
    assert.deepEqual(opened.items, [SECRET_ITEM, OTHER_ITEM])
    assert.ok(Object.isFrozen(opened.items))
    assert.ok(opened.items.every(Object.isFrozen))
    assert.deepEqual(listItems(vault, opened.key), opened.items)
  } finally {
    opened.key.fill(0)
  }
})

test('remove creates an independent snapshot and mutations require a valid key', () => {
  const removed = removeItem(vault, key, SECRET_ITEM.id)
  assert.deepEqual(listItems(removed, key), [OTHER_ITEM])
  assert.deepEqual(listItems(vault, key), [SECRET_ITEM, OTHER_ITEM])
  assert.throws(() => addItem(vault, key, SECRET_ITEM), /ID already exists/)
  assert.throws(() => removeItem(vault, key, 'missing'), /does not exist/)
  assert.throws(() => listItems(vault, Buffer.alloc(31)), /Invalid vault key/)
  for (const action of [
    () => listItems(vault, Buffer.alloc(32)),
    () => addItem(vault, Buffer.alloc(32), SECRET_ITEM),
    () => removeItem(vault, Buffer.alloc(32), SECRET_ITEM.id),
  ]) assert.throws(action, /Vault authentication failed/)
})

test('manifest rejects salt, MAC, record, ciphertext, order and cardinality tampering', () => {
  for (const alter of [
    (v) => { v.kdf.salt = changeBytes(v.kdf.salt) },
    (v) => { v.mac = changeBytes(v.mac) },
    (v) => { v.items[0].id = 'another-id' },
    (v) => { v.items[0].iv = changeBytes(v.items[0].iv) },
    (v) => { v.items[0].tag = changeBytes(v.items[0].tag) },
    (v) => { v.items[0].ciphertext = changeBytes(v.items[0].ciphertext) },
    (v) => { v.items.reverse() },
    (v) => { v.items.pop() },
    (v) => { v.items.push({ ...v.items[0], id: 'injected' }) },
  ]) {
    const altered = jsonClone(vault)
    alter(altered)
    assert.doesNotThrow(() => validateVault(altered))
    assert.throws(() => listItems(altered, key), /Vault authentication failed/)
  }
})

test('unlock failure is generic for a wrong password and structural or authenticated tampering', async () => {
  await assert.rejects(openVault(initial, WRONG_PASSWORD), UNLOCK_ERROR)
  await assert.rejects(authenticateVault(initial, 'short'), UNLOCK_ERROR)
  const altered = jsonClone(vault)
  altered.items.length = 0
  await assert.rejects(openVault(altered, PASSWORD), UNLOCK_ERROR)
  altered.kdf.memoryKiB = Number.MAX_SAFE_INTEGER
  await assert.rejects(openVault(altered, PASSWORD), UNLOCK_ERROR)
})

test('password-only authentication leaves sources encrypted and item AAD binds the ID', async () => {
  const altered = jsonClone(vault)
  altered.items[0].id = 'different-item-id'
  signTestSnapshot(altered)
  const authenticated = await authenticateVault(altered, PASSWORD)
  try {
    assert.deepEqual(authenticated, key)
    assert.throws(() => listItems(altered, authenticated), /authenticat/i)
  } finally {
    authenticated.fill(0)
  }
  await assert.rejects(openVault(altered, PASSWORD), UNLOCK_ERROR)
})

test('validates shape, canonical encodings, and limits before authentication', () => {
  const modifications = [
    (v) => { v.version = 2 },
    (v) => { v.extra = true },
    (v) => { v.kdf.name = 'argon2i' },
    (v) => { v.kdf.iterations = 4 },
    (v) => { v.kdf.parallelism = 2 },
    (v) => { v.kdf.memoryKiB = 2 ** 30 },
    (v) => { v.kdf.salt += '=' },
    (v) => { v.mac = v.mac.slice(1) },
    (v) => { v.items = new Array(129) },
    (v) => { v.items[0].iv = '' },
    (v) => { v.items[0].tag = `${v.items[0].tag.slice(0, -1)}B` },
    (v) => { v.items[0].ciphertext = 'A'.repeat(3 * 1024 * 1024) },
    (v) => { v.items[0].id = v.items[1].id },
    (v) => { v.items[0].id += '\n' },
    (v) => { delete v.items[0] },
    (v) => { v.items.extra = true },
    (v) => { Object.defineProperty(v.items[0], 'id', { get() { assert.fail('unexpected accessor execution') } }) },
  ]
  for (const modify of modifications) {
    const malformed = jsonClone(vault)
    modify(malformed)
    assert.throws(() => validateVault(malformed), /Invalid vault/)
  }
  const supplied = jsonClone(vault)
  const normalized = validateVault(supplied)
  supplied.items[0].id = 'changed'
  for (const frozen of [normalized, normalized.kdf, normalized.items, ...normalized.items]) {
    assert.ok(Object.isFrozen(frozen))
  }
  assert.equal(normalized.items[0].id, SECRET_ITEM.id)
})

test('applies item field, count and aggregate ciphertext bounds to additions', () => {
  for (const invalid of [
    { ...SECRET_ITEM, id: '../plugin' },
    { ...SECRET_ITEM, name: 'é'.repeat(129) },
    { ...SECRET_ITEM, name: '  ' },
    { ...SECRET_ITEM, source: '🔐'.repeat(64 * 1024) + 'a' },
    { ...SECRET_ITEM, source: '\ud800' },
  ]) assert.throws(() => addItem(initial, key, invalid), /Invalid vault item/)
  let full = initial
  for (let index = 0; index < 128; index += 1) {
    full = addItem(full, key, { id: `item-${index}`, name: 'Item', source: 'module.exports = {}' })
  }
  assert.equal(validateVault(jsonClone(full)).items.length, 128)
  assert.throws(() => addItem(full, key, SECRET_ITEM), /item limit/)

  // Six escaped bytes per source character hit the 8 MiB aggregate limit
  // after five additions while staying within the per-item source limit.
  const large = { name: 'Item', source: '\u0000'.repeat(256 * 1024) }
  full = initial
  for (let index = 0; index < 5; index += 1) full = addItem(full, key, { id: `large-${index}`, ...large })
  assert.equal(listItems(full, key)[0].source, large.source)
  assert.equal(validateVault(jsonClone(full)).items.length, 5)
  assert.throws(() => addItem(full, key, { id: 'one-too-many', ...large }), /size limit/)
  const oversized = jsonClone(full)
  oversized.items.push({ ...oversized.items[0], id: 'one-too-many' })
  assert.throws(() => validateVault(oversized), /Invalid vault data/)
})
