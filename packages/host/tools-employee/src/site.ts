/**
 * The tools site's working copy and how it reaches the server. The
 * framework (build script, page templates, standing pages, styles) ships
 * with the harness in `sites/tools-linkfa`; the working copy under the
 * employee's data directory is a git repository holding that framework plus
 * every tool, and is pushed to the site repository the Dokploy app builds
 * from. Each publish refreshes the framework from the shipped copy, runs
 * every tool's tests and the build's quality checks, commits, pushes and
 * (when a deploy hook is set) asks Dokploy to deploy. Whether the live site
 * serves that version is read back from its `build.json`.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Where the site lives and goes. */
export interface SiteSettings {
  /** The framework as shipped with the harness. */
  templateDir: string
  /** The working copy (a git repository). */
  workDir: string
  /** Where builds for the preview are written. */
  previewDir: string
  /** The site repository's https address; empty keeps the site local. */
  repo: () => string
  /** A token with push access to the repository. */
  token: () => string
  branch: string
  /** A Dokploy deploy webhook; empty when the app deploys on push. */
  deployHook: () => string
  /** The public site, such as `https://tools.linkfa.de`. */
  siteUrl: () => string
  /** The AdSense client written into the site's config on each publish; empty keeps ads off. */
  adsenseClient: () => string
}

/** A command's outcome. */
export interface CommandResult {
  ok: boolean
  code: number | null
  output: string
}

/** The build's report (`node build.mjs --json`). */
export interface BuildReport {
  ok: boolean
  problems: string[]
  version: string
  tools: { slug: string; title: string; h1: string; keyword: string; category: string; published: string; updated: string }[]
}

/** A tool's slug: lower-case words joined by hyphens. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

const OUTPUT_LIMIT = 6000

/**
 * Run a program without a shell.
 * @param file - the program.
 * @param args - its arguments.
 * @param options - working directory, timeout, extra environment.
 * @returns the exit status and the combined output's tail.
 */
export function run(
  file: string, args: string[], options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', ...options.env },
    }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim()
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({ ok: error === null, code, output: output.length > OUTPUT_LIMIT ? `…${output.slice(-OUTPUT_LIMIT)}` : output })
    })
  })
}

/**
 * Hide a token wherever it appears in text.
 * @param text - the text.
 * @param secret - the token.
 * @returns the text with the token replaced.
 */
export function redact(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join('***')
}

/**
 * The git option that authenticates an https push or clone with a token, so the token is never part of a URL or
 * stored in the repository's config.
 * @param token - the token.
 * @returns `-c` and its value.
 */
export function authArgs(token: string): string[] {
  if (token === '') return []
  return ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
}

/**
 * A hash of every file in a directory, by relative path and content.
 * @param dir - the directory.
 * @returns 16 hex characters.
 */
export async function dirHash(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (at: string): Promise<void> => {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else hash.update(relative(dir, full)).update('\0').update(await readFile(full)).update('\0')
    }
  }
  await walk(dir)
  return hash.digest('hex').slice(0, 16)
}

/** Placeholder values a new tool's files are made with. */
export interface ScaffoldFields {
  slug: string
  title: string
  h1: string
  category: string
  keyword: string
  today: string
}

/**
 * Fill a template's `{{name}}` placeholders.
 * @param template - the text.
 * @param fields - the values.
 * @returns the text.
 */
export function fill(template: string, fields: ScaffoldFields): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (whole, key: string) => {
    const value = (fields as unknown as Record<string, string | undefined>)[key]
    return value === undefined ? whole : value.replace(/"/gu, '\\"')
  })
}

/** The site's working copy and the operations on it. */
export class SiteRepo {
  /** @param settings - paths, repository and deployment settings. */
  constructor(readonly settings: SiteSettings) {}

  private git(args: string[], timeoutMs = 60_000): Promise<CommandResult> {
    return run('git', ['-c', 'user.name=Linkfa Tools employee', '-c', 'user.email=tools-employee@users.noreply.linkfa.de', ...args], {
      cwd: this.settings.workDir, timeoutMs,
    })
  }

  /** The directory of one tool. */
  toolDir(slug: string): string {
    return join(this.settings.workDir, 'tools', slug)
  }

  /**
   * Make sure the working copy exists: cloned from the site repository when one is set and reachable, otherwise a
   * fresh repository; then bring the framework and any missing seed tools over from the shipped copy.
   * @returns what happened, one line.
   */
  async ensure(): Promise<string> {
    const { workDir, templateDir } = this.settings
    if (!existsSync(join(templateDir, 'build.mjs'))) throw new Error(`The site framework is missing at ${templateDir}.`)
    let note = 'working copy ready'
    if (!existsSync(join(workDir, '.git'))) {
      await mkdir(workDir, { recursive: true })
      const repo = this.settings.repo().trim()
      const token = this.settings.token().trim()
      let cloned = false
      if (repo !== '' && token !== '' && (await readdir(workDir)).length === 0) {
        const clone = await run('git', [...authArgs(token), 'clone', '--branch', this.settings.branch, repo, workDir], { cwd: templateDir, timeoutMs: 120_000 })
        cloned = clone.ok
        if (!cloned) {
          // An empty repository has no branch to clone; it is filled by the first push.
          note = `the site repository could not be cloned (${redact(clone.output, token).slice(0, 200)}); started a fresh working copy`
          await rm(workDir, { recursive: true, force: true })
          await mkdir(workDir, { recursive: true })
        } else {
          note = 'cloned the site repository'
        }
      }
      if (!cloned) {
        const init = await run('git', ['init', '-b', this.settings.branch], { cwd: workDir, timeoutMs: 30_000 })
        if (!init.ok) throw new Error(`git init failed: ${init.output}`)
        if (note === 'working copy ready') note = 'started a fresh working copy'
      }
    }
    await this.syncFramework()
    return note
  }

  /**
   * Copy the shipped framework over the working copy (everything but the tools and the config), add any shipped
   * tool the working copy lacks, and merge the config: the shipped one, keeping categories the working copy added,
   * with the AdSense client from the settings.
   */
  async syncFramework(): Promise<void> {
    const { workDir, templateDir } = this.settings
    for (const entry of await readdir(templateDir, { withFileTypes: true })) {
      if (['tools', 'site.config.json', 'dist', 'node_modules', '.git'].includes(entry.name)) continue
      await cp(join(templateDir, entry.name), join(workDir, entry.name), { recursive: true, force: true })
    }
    await mkdir(join(workDir, 'tools'), { recursive: true })
    for (const entry of await readdir(join(templateDir, 'tools'), { withFileTypes: true })) {
      if (entry.isDirectory() && !existsSync(join(workDir, 'tools', entry.name))) {
        await cp(join(templateDir, 'tools', entry.name), join(workDir, 'tools', entry.name), { recursive: true })
      }
    }
    const shipped = JSON.parse(await readFile(join(templateDir, 'site.config.json'), 'utf8')) as Record<string, unknown> & { categories: { id: string }[] }
    const local = existsSync(join(workDir, 'site.config.json'))
      ? JSON.parse(await readFile(join(workDir, 'site.config.json'), 'utf8')) as { categories?: { id: string }[] }
      : {}
    const known = new Set(shipped.categories.map(c => c.id))
    const merged = {
      ...shipped,
      categories: [...shipped.categories, ...(local.categories ?? []).filter(c => !known.has(c.id))],
      adsenseClient: this.settings.adsenseClient().trim(),
    }
    await writeFile(join(workDir, 'site.config.json'), `${JSON.stringify(merged, null, 2)}\n`)
  }

  /**
   * Add a category to the working copy's config; an existing id is left as it is.
   * @param category - id, label and one-sentence intro.
   */
  async addCategory(category: { id: string; label: string; intro: string }): Promise<void> {
    if (!SLUG.test(category.id)) throw new Error(`"${category.id}" is not a category id: lower-case words joined by hyphens.`)
    const file = join(this.settings.workDir, 'site.config.json')
    const config = JSON.parse(await readFile(file, 'utf8')) as { categories: { id: string }[] }
    if (config.categories.some(c => c.id === category.id)) return
    config.categories.push(category)
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
  }

  /**
   * The tools in the working copy.
   * @returns their slugs.
   */
  async slugs(): Promise<string[]> {
    const dir = join(this.settings.workDir, 'tools')
    if (!existsSync(dir)) return []
    return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
  }

  /**
   * Create a new tool's files from the templates; refused when the tool exists.
   * @param fields - the placeholders.
   * @returns the tool's directory.
   */
  async scaffold(fields: ScaffoldFields): Promise<string> {
    if (!SLUG.test(fields.slug)) throw new Error(`"${fields.slug}" is not a slug: lower-case words joined by hyphens.`)
    const dir = this.toolDir(fields.slug)
    if (existsSync(dir)) throw new Error(`tools/${fields.slug} already exists; edit its files instead.`)
    await mkdir(dir, { recursive: true })
    const templates = join(this.settings.workDir, 'templates', 'tool')
    for (const name of await readdir(templates)) {
      if (!name.endsWith('.tpl')) continue
      await writeFile(join(dir, name.slice(0, -4)), fill(await readFile(join(templates, name), 'utf8'), fields))
    }
    return dir
  }

  /**
   * Run one tool's known-answer tests, or every test in the site.
   * @param slug - the tool; omitted runs all.
   * @returns the outcome.
   */
  async test(slug?: string): Promise<CommandResult> {
    const files = slug === undefined
      ? [...(await this.slugs()).map(s => join('tools', s, 'logic.test.mjs')), join('lib', 'site.test.mjs')]
      : [join('tools', slug, 'logic.test.mjs')]
    const present = files.filter(file => existsSync(join(this.settings.workDir, file)))
    if (present.length === 0) return { ok: false, code: null, output: `No tests found (${files.join(', ')}).` }
    return run(process.execPath, ['--test', '--test-reporter=spec', ...present], { cwd: this.settings.workDir, timeoutMs: 180_000 })
  }

  /**
   * The build's quality checks without writing anything.
   * @returns the report.
   */
  async check(): Promise<BuildReport> {
    return this.buildReport(['--check'])
  }

  /**
   * Build the site into the preview directory.
   * @returns the report.
   */
  async build(): Promise<BuildReport> {
    return this.buildReport(['--out', this.settings.previewDir])
  }

  private async buildReport(args: string[]): Promise<BuildReport> {
    const result = await run(process.execPath, ['build.mjs', '--json', ...args], { cwd: this.settings.workDir, timeoutMs: 120_000 })
    const line = result.output.split('\n').reverse().find(l => l.startsWith('{'))
    if (line === undefined) return { ok: false, problems: [`The build did not report: ${result.output.slice(0, 1000)}`], version: '', tools: [] }
    return JSON.parse(line) as BuildReport
  }

  /**
   * Commit everything in the working copy.
   * @param message - the commit message.
   * @returns the commit hash, and whether anything changed.
   */
  async commit(message: string): Promise<{ commit: string; changed: boolean }> {
    const add = await this.git(['add', '-A'])
    if (!add.ok) throw new Error(`git add failed: ${add.output}`)
    const status = await this.git(['status', '--porcelain'])
    const changed = status.output.trim() !== ''
    if (changed) {
      const done = await this.git(['commit', '-q', '-m', message])
      if (!done.ok) throw new Error(`git commit failed: ${done.output}`)
    }
    const head = await this.git(['rev-parse', '--short', 'HEAD'])
    return { commit: head.ok ? head.output.trim() : '', changed }
  }

  /**
   * Push the working copy to the site repository.
   * @returns what happened, one line.
   */
  async push(): Promise<string> {
    const repo = this.settings.repo().trim()
    const token = this.settings.token().trim()
    if (repo === '') return 'not pushed: no site repository is set'
    if (token === '') return 'not pushed: TOOLS_SITE_GIT_TOKEN is not set on the harness'
    const result = await this.git([...authArgs(token), 'push', repo, `HEAD:${this.settings.branch}`], 120_000)
    return result.ok ? `pushed to ${repo} (${this.settings.branch})` : `push failed: ${redact(result.output, token).slice(0, 400)}`
  }

  /**
   * Ask Dokploy to deploy, when a deploy hook is set.
   * @param fetcher - HTTP.
   * @returns what happened, one line.
   */
  async deploy(fetcher: typeof fetch): Promise<string> {
    const hook = this.settings.deployHook().trim()
    if (hook === '') return 'no deploy hook: the Dokploy app deploys on push'
    try {
      const response = await fetcher(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30_000) })
      return response.ok ? 'Dokploy deploy requested' : `Dokploy deploy hook answered HTTP ${String(response.status)}`
    } catch (error) {
      return `Dokploy deploy hook failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * Read the live site's `build.json` and compare it with the version just built.
 * @param fetcher - HTTP.
 * @param siteUrl - the public site.
 * @param localVersion - the working copy's version, if known.
 * @returns the state and a sentence for the owner.
 */
export async function liveCheck(
  fetcher: typeof fetch, siteUrl: string, localVersion: string | undefined,
): Promise<{ state: 'live' | 'outdated' | 'not-deployed' | 'unreachable'; detail: string; liveVersion: string | null }> {
  const url = `${siteUrl.replace(/\/+$/u, '')}/build.json`
  let response: Response
  try {
    response = await fetcher(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    return { state: 'unreachable', detail: `${siteUrl} did not answer (${error instanceof Error ? error.message : String(error)}).`, liveVersion: null }
  }
  const host = new URL(siteUrl).host
  if (response.status >= 300 && response.status < 400) {
    const to = response.headers.get('location') ?? ''
    return {
      state: 'not-deployed',
      detail: `${host} redirects to ${to || 'another address'}: the wildcard site answers it, so the Dokploy app with the ${host} domain is not set up yet.`,
      liveVersion: null,
    }
  }
  const text = await response.text()
  let body: { generator?: unknown; version?: unknown } | undefined
  try {
    body = JSON.parse(text) as { generator?: unknown; version?: unknown }
  } catch {
    // Not JSON: another site answers the address.
    body = undefined
  }
  if (!response.ok || body?.generator !== 'linkfa-tools') {
    return { state: 'not-deployed', detail: `${host} answers HTTP ${String(response.status)} without the tools site's build file: the Dokploy app for it is not set up yet.`, liveVersion: null }
  }
  const live = typeof body.version === 'string' ? body.version : null
  if (localVersion !== undefined && live !== localVersion) {
    return { state: 'outdated', detail: `${host} serves version ${live ?? '?'}; the latest build is ${localVersion} (a deploy may still be running).`, liveVersion: live }
  }
  return { state: 'live', detail: `${host} serves the latest build (${live ?? '?'}).`, liveVersion: live }
}
