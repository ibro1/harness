#!/usr/bin/env node
/**
 * Build tools.linkfa.de to static files.
 *
 *   node build.mjs [--out dist] [--check] [--json] [--today YYYY-MM-DD]
 *
 * `--check` validates without writing; `--json` prints a machine-readable
 * report (problems, tools, version) on stdout. Any problem exits 1 and nothing
 * is written, so a page that fails the quality bar never reaches the server.
 */

import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { standingPages } from './pages/pages.mjs'
import { adsTxt, homePage, notFoundPage, plainPage, robots, sitemap, toolPage } from './lib/render.mjs'
import { loadSite, siteProblems } from './lib/site.mjs'

const root = dirname(fileURLToPath(import.meta.url))

function arg(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}

/**
 * Hash every source file, so a deployed site can be matched to its source.
 * @param {string} dir
 * @returns {string} 12 hex characters
 */
export function sourceVersion(dir) {
  const hash = createHash('sha256')
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      if (['dist', 'node_modules', '.git'].includes(name)) continue
      const full = join(at, name)
      if (statSync(full).isDirectory()) walk(full)
      else hash.update(relative(dir, full)).update('\0').update(readFileSync(full)).update('\0')
    }
  }
  walk(dir)
  return hash.digest('hex').slice(0, 12)
}

const out = resolve(root, arg('--out') ?? 'dist')
const today = arg('--today') ?? new Date().toISOString().slice(0, 10)
const check = process.argv.includes('--check')
const asJson = process.argv.includes('--json')

const site = loadSite(root)
const problems = siteProblems(site, today)
const version = sourceVersion(root)
const tools = site.tools.filter(t => t.meta !== undefined && t.meta !== null)
const summary = tools.map(t => ({ slug: t.dir, title: t.meta.title, h1: t.meta.h1, keyword: t.meta.keyword, category: t.meta.category, published: t.meta.published, updated: t.meta.updated }))

if (problems.length > 0 || check) {
  if (asJson) process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems, version, tools: summary })}\n`)
  else if (problems.length > 0) process.stderr.write(`Build refused:\n- ${problems.join('\n- ')}\n`)
  else process.stdout.write(`OK: ${String(tools.length)} tools pass the checks (version ${version}).\n`)
  process.exit(problems.length > 0 ? 1 : 0)
}

const { config } = site
const css = readFileSync(join(root, 'assets', 'site.css'), 'utf8').replace(/\n/gu, '')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const write = (path, text) => {
  const file = join(out, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const pages = [{ path: '/', lastmod: tools.reduce((max, t) => (t.meta.updated > max ? t.meta.updated : max), config.pagesUpdated) }]
write('index.html', homePage({ config, css, tools }))
for (const tool of tools) {
  write(`${tool.dir}/index.html`, toolPage({ config, css, tool, tools }))
  cpSync(join(tool.path, 'logic.mjs'), join(out, tool.dir, 'logic.mjs'))
  cpSync(join(tool.path, 'ui.mjs'), join(out, tool.dir, 'ui.mjs'))
  pages.push({ path: `/${tool.dir}/`, lastmod: tool.meta.updated })
}
for (const page of standingPages(config, config.pagesUpdated)) {
  write(`${page.path.slice(1)}index.html`, plainPage({ config, css, ...page }))
  pages.push({ path: page.path, lastmod: config.pagesUpdated })
}
write('404.html', notFoundPage({ config, css }))
write('sitemap.xml', sitemap(config.origin, pages))
write('robots.txt', robots(config.origin))
if (config.adsenseClient) write('ads.txt', adsTxt(config.adsenseClient))
cpSync(join(root, 'assets', 'favicon.svg'), join(out, 'favicon.svg'))
write('build.json', `${JSON.stringify({
  generator: 'linkfa-tools', version, builtAt: new Date().toISOString(), ads: Boolean(config.adsenseClient), tools: summary,
})}\n`)

if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, problems: [], version, tools: summary, out })}\n`)
else process.stdout.write(`Built ${String(tools.length)} tools and ${String(pages.length)} pages into ${relative(process.cwd(), out) || out} (version ${version}).\n`)
