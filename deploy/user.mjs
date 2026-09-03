#!/usr/bin/env node
// Manage the accounts able to sign in to this harness.
//
//   node deploy/user.mjs list
//   node deploy/user.mjs add <name> [email]     # prompts for the password
//   node deploy/user.mjs passwd <name>
//   node deploy/user.mjs remove <name>
//
// Accounts live in `users.json` in the Harness home, which is on the state
// volume, so they survive redeploys. Passwords are stored only as scrypt
// digests. While the file declares no accounts the environment-configured
// single account stands, which is why `remove` refuses to empty it.

import { randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'

const SCRYPT_KEYLEN = 32
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const USERS_PATH = join(DSH_HOME, 'users.json')

function read() {
  if (!existsSync(USERS_PATH)) return { version: 1, users: [] }
  const parsed = JSON.parse(readFileSync(USERS_PATH, 'utf8'))
  return { version: 1, users: Array.isArray(parsed.users) ? parsed.users : [] }
}

function write(document) {
  mkdirSync(DSH_HOME, { recursive: true })
  const temporary = `${USERS_PATH}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, USERS_PATH)
}

function digest(password) {
  const salt = randomBytes(16)
  return `scrypt.${salt.toString('hex')}.${scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex')}`
}

async function askPassword(name) {
  const fromArgv = process.argv[4]
  if (fromArgv !== undefined && process.argv[2] === 'passwd') return fromArgv
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const password = await rl.question(`Password for ${name}: `)
  rl.close()
  if (password.length < 12) {
    console.error('Refusing: use at least 12 characters. This password reaches a shell on this host.')
    process.exit(1)
  }
  return password
}

const [command, name, email] = process.argv.slice(2)
const document = read()

if (command === 'list') {
  if (document.users.length === 0) {
    console.log('No users.json accounts; the environment-configured account is in effect.')
  } else {
    for (const user of document.users) {
      console.log(`${user.name}${user.email === undefined ? '' : `  <${user.email}>`}`)
    }
  }
  process.exit(0)
}

if (name === undefined || name.trim() === '') {
  console.error('Usage: user.mjs list | add <name> [email] | passwd <name> | remove <name>')
  process.exit(1)
}

if (command === 'add') {
  if (document.users.some(user => user.name === name)) {
    console.error(`${name} already exists; use passwd to change the password.`)
    process.exit(1)
  }
  const password = await askPassword(name)
  document.users.push({ name, password: digest(password), ...(email === undefined ? {} : { email }) })
  write(document)
  console.error(`Added ${name}. Restart the container for it to take effect.`)
  process.exit(0)
}

if (command === 'passwd') {
  const user = document.users.find(row => row.name === name)
  if (user === undefined) {
    console.error(`${name} is not in ${USERS_PATH}.`)
    process.exit(1)
  }
  user.password = digest(await askPassword(name))
  write(document)
  console.error(`Changed the password for ${name}. Restart the container for it to take effect.`)
  process.exit(0)
}

if (command === 'remove') {
  const remaining = document.users.filter(row => row.name !== name)
  if (remaining.length === document.users.length) {
    console.error(`${name} is not in ${USERS_PATH}.`)
    process.exit(1)
  }
  if (remaining.length === 0) {
    console.error('Refusing to remove the last account: the file would fall back to the environment account,')
    console.error('which is rarely what someone deleting their only user intends. Remove users.json by hand instead.')
    process.exit(1)
  }
  write({ version: 1, users: remaining })
  console.error(`Removed ${name}. Restart the container, then revoke their sessions from /auth/sessions.`)
  process.exit(0)
}

console.error(`Unknown command ${JSON.stringify(command)}.`)
process.exit(1)
