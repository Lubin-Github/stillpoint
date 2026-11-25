import { parentPort, workerData } from 'node:worker_threads'
import { argon2id } from '@noble/hashes/argon2'

// The Host transfers a dedicated password buffer so the worker owns the only
// mutable copy of its encoded bytes. No password goes on the command line.
const { password, salt, memoryKiB, iterations, parallelism } = workerData
let derived
let output
try {
  derived = argon2id(password, salt, {
    m: memoryKiB,
    t: iterations,
    p: parallelism,
    dkLen: 32,
    version: 0x13,
  })
  output = Uint8Array.from(derived)
} finally {
  password.fill(0)
  derived?.fill(0)
}

try {
  parentPort.postMessage(output, [output.buffer])
} finally {
  if (output.byteLength) output.fill(0)
}
