#!/usr/bin/env node
// Print a DSH_AUTH_PASSWORD_HASH value so the plaintext password never has to
// live in Dokploy's environment panel. Dot-separated on purpose: Compose
// expands `$name` inside a .env value, which would eat a `$`-separated digest.
//
//   node deploy/hash-password.mjs 'your password'
//   node deploy/hash-password.mjs            # prompts, no shell history

import { randomBytes, scryptSync } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

const SCRYPT_KEYLEN = 32
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }

let password = process.argv[2]

if (password === undefined) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  password = await rl.question('Password: ')
  rl.close()
}

if (password.length < 12) {
  console.error('Refusing: use at least 12 characters. This password is the only thing between the internet and a shell.')
  process.exit(1)
}

const salt = randomBytes(16)
const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
console.log(`scrypt.${salt.toString('hex')}.${hash.toString('hex')}`)
