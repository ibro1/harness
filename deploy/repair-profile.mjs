#!/usr/bin/env node
// Bring the web profile's installed plugins in line with the harness it now runs on.
//
// A profile outlives the image: plugins installed from the UI stay on the
// state volume, pinned by a caret range that, below 1.0, never crosses a minor
// version. After an upstream upgrade they can be left calling APIs the harness
// has retired, and the only visible symptom is a "Problem" badge. This runs at
// boot and repairs the cases known to break, so an upgrade does not need a
// terminal session.
//
//   node deploy/repair-profile.mjs [--dry-run]

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const MANIFEST = join(PROFILE_DIR, 'package.json')
const APP_DIR = process.env.APP_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY_RUN = process.argv.includes('--dry-run')

// Bundles upstream folded into another package; the name no longer resolves.
const RETIRED_BUNDLES = new Map([
  ['@deepseek-ai/dsh-experimental-agent-team-web-profile', 'folded into Agent Teams in 0.1.7'],
])

// Plugins whose older releases call APIs 0.1.7 retired, and the first release that does not.
const MINIMUM_RELEASES = new Map([
  ['dsh-mnemon', { minimum: '0.5.16', reason: 'releases before 0.5 call the retired ctx.settings.register' }],
])

function log(message) {
  console.error(`repair-profile: ${message}`)
}

/** Compare dotted numeric versions, ignoring any prerelease suffix. */
function older(version, minimum) {
  const parse = (value) => value.split('-')[0].split('.').map(Number)
  const [a, b] = [parse(version), parse(minimum)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

if (!existsSync(MANIFEST)) {
  log(`no profile at ${PROFILE_DIR}; nothing to repair`)
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const kept = bundles.filter((name) => !RETIRED_BUNDLES.has(name))
  for (const name of bundles.filter((entry) => RETIRED_BUNDLES.has(entry))) {
    log(`removing bundle ${name} (${RETIRED_BUNDLES.get(name)})`)
  }
  if (kept.length !== bundles.length && !DRY_RUN) {
    manifest.dsh.profile.bundles = kept
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

for (const [name, { minimum, reason }] of MINIMUM_RELEASES) {
  const installed = join(PROFILE_DIR, 'node_modules', name, 'package.json')
  if (!existsSync(installed)) continue
  const { version } = JSON.parse(readFileSync(installed, 'utf8'))
  if (!older(version, minimum)) continue
  log(`upgrading ${name} ${version} -> ^${minimum} (${reason})`)
  if (DRY_RUN) continue
  try {
    execFileSync(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'plugin', '--profile', PROFILE, 'install', `${name}@^${minimum}`], {
      cwd: APP_DIR, stdio: ['ignore', 'ignore', 'inherit'], timeout: 300_000,
    })
  } catch (error) {
    // The old release stays installed and fails as before; the boot goes on.
    log(`could not upgrade ${name} (${error.message.split('\n')[0]}); it stays at ${version}`)
  }
}
