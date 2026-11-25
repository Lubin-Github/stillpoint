import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto'
import { Worker } from 'node:worker_threads'

const VERSION = 1
const KDF = Object.freeze({ name: 'argon2id', memoryKiB: 65536, iterations: 3, parallelism: 1 })
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_ITEMS = 128
const MAX_NAME_BYTES = 256
const MAX_SOURCE_BYTES = 256 * 1024
// JSON string escaping can expand UTF-8 bytes sixfold, plus object syntax.
const MAX_ITEM_BYTES = 6 * (MAX_NAME_BYTES + MAX_SOURCE_BYTES) + 64
const MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024
const WORKER_TIMEOUT_MS = 60_000
const DOMAIN = 'dsh-lock-gate/vault/v1'
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const normalizedVaults = new WeakSet()

function invalidVault() {
  return new Error('Invalid vault data.')
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length > 512 || !password.isWellFormed()
      || Buffer.byteLength(password, 'utf8') > 512 || [...password].length < 12) {
    throw new Error('Password must contain at least 12 characters and at most 512 UTF-8 bytes.')
  }
}

function assertId(id) {
  if (typeof id !== 'string' || !id.length || id.length > 128 || /[^A-Za-z0-9_-]/.test(id)) {
    throw new Error('Invalid vault item ID.')
  }
}

function validText(value, maxBytes) {
  return typeof value === 'string' && value.length <= maxBytes && value.isWellFormed()
    && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function fields(value, keys) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== keys.length) throw invalidVault()
  return keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidVault()
    return descriptor.value
  })
}

function checkItemContent(name, source) {
  if (!validText(name, MAX_NAME_BYTES) || !name.trim()) throw new Error('Invalid vault item name.')
  if (!validText(source, MAX_SOURCE_BYTES)) throw new Error('Invalid vault item source.')
}

function dataBytes(value, maxBytes, exactBytes) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes * 4 / 3)
      || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidVault()
  const bytes = Buffer.from(value, 'base64url')
  if (!bytes.length || bytes.length > maxBytes || (exactBytes !== undefined && bytes.length !== exactBytes)
      || bytes.toString('base64url') !== value) throw invalidVault()
  return bytes.length
}

function snapshot(kdf, items, mac) {
  const vault = Object.freeze({ version: VERSION, kdf, items: Object.freeze(items), mac })
  normalizedVaults.add(vault)
  return vault
}

// Structural checks bound all decoding and run before any key derivation.
// Authentication is performed separately once a candidate key is available.
export function validateVault(input) {
  if (normalizedVaults.has(input)) return input
  const [version, rawKdf, rawItems, mac] = fields(input, ['version', 'kdf', 'items', 'mac'])
  if (version !== VERSION || !Array.isArray(rawItems) || rawItems.length > MAX_ITEMS
      || Reflect.ownKeys(rawItems).length !== rawItems.length + 1) throw invalidVault()
  const [name, memoryKiB, iterations, parallelism, salt] = fields(rawKdf, [
    'name', 'memoryKiB', 'iterations', 'parallelism', 'salt',
  ])
  if (name !== KDF.name || memoryKiB !== KDF.memoryKiB || iterations !== KDF.iterations
      || parallelism !== KDF.parallelism) throw invalidVault()
  dataBytes(salt, SALT_BYTES, SALT_BYTES)
  dataBytes(mac, KEY_BYTES, KEY_BYTES)

  const items = []
  const ids = new Set()
  let total = 0
  for (let index = 0; index < rawItems.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawItems, String(index))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidVault()
    const [id, iv, tag, ciphertext] = fields(descriptor.value, ['id', 'iv', 'tag', 'ciphertext'])
    assertId(id)
    if (ids.has(id)) throw invalidVault()
    ids.add(id)
    dataBytes(iv, IV_BYTES, IV_BYTES)
    dataBytes(tag, TAG_BYTES, TAG_BYTES)
    total += dataBytes(ciphertext, MAX_ITEM_BYTES)
    if (total > MAX_CIPHERTEXT_BYTES) throw invalidVault()
    items.push(Object.freeze({ id, iv, tag, ciphertext }))
  }
  return snapshot(Object.freeze({ ...KDF, salt }), items, mac)
}

function deriveKey(password, kdf) {
  return new Promise((resolve, reject) => {
    const encoded = new TextEncoder().encode(password)
    let worker
    try {
      worker = new Worker(new URL('./crypto-worker.js', import.meta.url), {
        workerData: { ...kdf, salt: Buffer.from(kdf.salt, 'base64url'), password: encoded },
        transferList: [encoded.buffer],
        execArgv: [],
      })
    } catch (error) {
      if (encoded.byteLength) encoded.fill(0)
      reject(error)
      return
    }

    let settled = false
    const finish = (error, key) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Observe termination errors even if the worker has already exited.
      void worker.terminate().catch(() => {})
      if (error) reject(error)
      else resolve(key)
    }
    const fail = () => finish(new Error('Vault key derivation failed.'))
    const timer = setTimeout(fail, WORKER_TIMEOUT_MS)
    worker.once('message', (bytes) => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== KEY_BYTES) {
        fail()
        return
      }
      if (settled) {
        bytes.fill(0)
        return
      }
      finish(null, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
    worker.once('messageerror', fail)
    worker.once('error', fail)
    worker.once('exit', fail)
  })
}

function subkey(key, kdf, purpose) {
  return Buffer.from(hkdfSync('sha256', key, Buffer.from(kdf.salt, 'base64url'), `${DOMAIN}/${purpose}`, KEY_BYTES))
}

function manifestMac(kdf, items, key) {
  const macKey = subkey(key, kdf, 'manifest')
  try {
    const hmac = createHmac('sha256', macKey)
    hmac.update(JSON.stringify([DOMAIN, VERSION, kdf.name, kdf.memoryKiB, kdf.iterations, kdf.parallelism, kdf.salt, items.length]))
    // Newlines frame the ordered tuples. Every tuple field is ASCII and the
    // ciphertext is authenticated as stored, including its encoding.
    for (const { id, iv, tag, ciphertext } of items) {
      hmac.update('\n').update(JSON.stringify([id, iv, tag, ciphertext]))
    }
    return hmac.digest()
  } finally {
    macKey.fill(0)
  }
}

function signedSnapshot(kdf, items, key) {
  return snapshot(kdf, items, manifestMac(kdf, items, key).toString('base64url'))
}

function authenticate(input, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('Invalid vault key.')
  const vault = validateVault(input)
  if (!timingSafeEqual(manifestMac(vault.kdf, vault.items, key), Buffer.from(vault.mac, 'base64url'))) {
    throw new Error('Vault authentication failed.')
  }
  return vault
}

function itemAad(kdf, id) {
  return Buffer.from(JSON.stringify([DOMAIN, VERSION, kdf.salt, id]), 'utf8')
}

function encryptItem(kdf, key, id, name, source) {
  const itemKey = subkey(key, kdf, 'items')
  const plaintext = Buffer.from(JSON.stringify({ name, source }), 'utf8')
  try {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', itemKey, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(itemAad(kdf, id))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Object.freeze({
      id,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    })
  } finally {
    plaintext.fill(0)
    itemKey.fill(0)
  }
}

function decryptItem(kdf, itemKey, { id, iv, tag, ciphertext }) {
  const decipher = createDecipheriv('aes-256-gcm', itemKey, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES })
  decipher.setAAD(itemAad(kdf, id))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  let part
  let end
  let plaintext
  try {
    part = decipher.update(Buffer.from(ciphertext, 'base64url'))
    end = decipher.final()
    plaintext = Buffer.concat([part, end])
    const [name, source] = fields(JSON.parse(UTF8.decode(plaintext)), ['name', 'source'])
    checkItemContent(name, source)
    return Object.freeze({ id, name, source })
  } finally {
    part?.fill(0)
    end?.fill(0)
    plaintext?.fill(0)
  }
}

export async function createVault(password) {
  validatePassword(password)
  let key
  try {
    const kdf = Object.freeze({ ...KDF, salt: randomBytes(SALT_BYTES).toString('base64url') })
    key = await deriveKey(password, kdf)
    return { vault: signedSnapshot(kdf, [], key), key }
  } catch {
    key?.fill(0)
    throw new Error('Unable to initialize vault.')
  }
}

async function unlock(input, password) {
  let key
  try {
    validatePassword(password)
    const vault = validateVault(input)
    key = await deriveKey(password, vault.kdf)
    authenticate(vault, key)
    return { vault, key }
  } catch {
    key?.fill(0)
    throw new Error('Unable to unlock vault.')
  }
}

// Password-only authentication for paths that must leave sources encrypted.
export async function authenticateVault(input, password) {
  const { key } = await unlock(input, password)
  return key
}

export async function openVault(input, password) {
  const { vault, key } = await unlock(input, password)
  try {
    return { key, items: decryptItems(vault, key) }
  } catch {
    key.fill(0)
    throw new Error('Unable to unlock vault.')
  }
}

export function listItems(input, key) {
  return decryptItems(authenticate(input, key), key)
}

function decryptItems({ kdf, items }, key) {
  const itemKey = subkey(key, kdf, 'items')
  try {
    return Object.freeze(items.map((item) => decryptItem(kdf, itemKey, item)))
  } finally {
    itemKey.fill(0)
  }
}

export function addItem(input, key, item) {
  const { kdf, items } = authenticate(input, key)
  const [id, name, source] = fields(item, ['id', 'name', 'source'])
  assertId(id)
  checkItemContent(name, source)
  if (items.some((existing) => existing.id === id)) throw new Error('Vault item ID already exists.')
  if (items.length >= MAX_ITEMS) throw new Error('Vault item limit reached.')
  const next = encryptItem(kdf, key, id, name, source)
  const total = [next, ...items].reduce((sum, { ciphertext }) => sum + Math.floor(ciphertext.length * 3 / 4), 0)
  if (total > MAX_CIPHERTEXT_BYTES) throw new Error('Vault size limit reached.')
  return signedSnapshot(kdf, [...items, next], key)
}

export function removeItem(input, key, id) {
  const { kdf, items } = authenticate(input, key)
  assertId(id)
  const remaining = items.filter((item) => item.id !== id)
  if (remaining.length === items.length) throw new Error('Vault item does not exist.')
  return signedSnapshot(kdf, remaining, key)
}
