#!/usr/bin/env node
/* Personal-data guard. Refuses to publish tracked files that carry values belonging to this
   machine: real hostnames, the LAN address, the Cloudflare tunnel id, or a token from this
   install. Patterns come from local files (secrets/, store/, windows/access.json and an optional
   personal/guard-patterns.txt), so a fresh clone checks only the generic rules below.
   Run it before committing (the .githooks/pre-commit hook does it for you):
     node scripts/check-personal.mjs            # everything tracked
     node scripts/check-personal.mjs --staged   # only what is staged */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const staged = process.argv.includes('--staged')
// git is not always on PATH (the portable connector ships its own copy), so resolve it once.
const GIT = [
  process.env.GIT,
  'git',
  'C:/Program Files/Git/cmd/git.exe',
  path.join(root, '..', 'chatgpt', 'tools', 'git', 'cmd', 'git.exe'),
  path.join(root, 'tools', 'git', 'cmd', 'git.exe'),
].find(candidate => candidate && spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0)
if (!GIT) {
  console.error('personal guard: git not found (set GIT or install Git for Windows)')
  process.exit(2)
}
const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8') } catch { return '' } }
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const patterns = []
const addValue = (label, value) => {
  const v = String(value || '').trim()
  if (v.length >= 6) patterns.push({ label, re: new RegExp(escapeRe(v), 'i') })
}
const addRule = (label, source) => {
  try { patterns.push({ label, re: new RegExp(source, 'i') }) } catch { /* skip bad local rule */ }
}
const lines = file => read(file).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))

// Tokens and hostnames this installation already knows about. They are never printed.
for (const file of ['secrets/mcp-token', 'secrets/app-token']) addValue(`token in ${file}`, read(file))
try { addValue('openGym bearer token', JSON.parse(read('secrets/opengym-token.json')).token) } catch { /* none */ }
for (const file of ['store/public-url.txt', 'store/app-url.txt']) {
  try { addValue(`hostname in ${file}`, new URL(read(file).trim()).hostname) } catch { /* missing */ }
}
try {
  const cfg = JSON.parse(read('store/cloudflare.json'))
  addValue('cloudflare app host', cfg.app)
  addValue('cloudflare mcp host', cfg.mcp)
} catch { /* no tunnel configured yet */ }
try {
  const access = JSON.parse(fs.readFileSync(path.join(root, '..', 'windows', 'access.json'), 'utf8'))
  try { addValue('LAN host in windows/access.json', new URL(access.app).hostname) } catch { /* empty */ }
  addValue('tunnel id in windows/access.json', access.tunnel && access.tunnel.id)
} catch { /* this is not the Windows install */ }
try {
  const origin = read(path.join('..', 'windows', 'public-origin.txt')).trim()
  addValue('public origin hostname', new URL(origin).hostname)
} catch { /* none */ }

// Extra machine-specific rules, one regular expression per line (gitignored).
for (const rule of lines('personal/guard-patterns.txt')) addRule(`personal/guard-patterns.txt: ${rule.slice(0, 40)}`, rule)

// Generic rules that do not depend on any one deployment.
addRule('64-hex token-like string', '[0-9a-f]{64}')

const blockedPaths = [
  [/^secrets\//, 'secrets/ is never committed'],
  [/^store\//, 'store/ is local runtime state'],
  [/^personal\//, 'personal/ is local deployment notes'],
  [/^tools\//, 'tools/ holds downloaded binaries and credentials'],
  [/\.mobileconfig$/, 'an iPhone configuration profile is local'],
  [/^windows\/access\.json$/, 'access.json is generated per machine'],
]

const git = args => execFileSync(GIT, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const list = (staged
  ? git(['diff', '--cached', '--name-only', '-z']).split('\0')
  : git(['ls-files', '-z']).split('\0')).filter(Boolean)

const skip = new Set(['scripts/check-personal.mjs', '.githooks/pre-commit'])
let bad = 0
for (const file of list) {
  if (skip.has(file)) continue
  for (const [re, why] of blockedPaths) {
    if (re.test(file)) { console.error(`BLOCKED  ${file}  (${why})`); bad++; break }
  }
  const text = staged
    ? (() => { try { return git(['show', `:${file}`]) } catch { return '' } })()
    : read(file)
  if (!text) continue
  for (const pattern of patterns) {
    if (pattern.re.test(text)) {
      console.error(`BLOCKED  ${file}  (${pattern.label})`)
      bad++
      break
    }
  }
}
if (bad) {
  console.error(`\n${bad} file(s) carry personal data. Move them to personal/ (gitignored) or use placeholders.`)
  process.exit(1)
}
console.log(`personal guard: ${list.length} file(s) checked, clean`)
