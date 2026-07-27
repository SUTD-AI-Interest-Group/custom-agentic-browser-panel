#!/usr/bin/env node
/**
 * sync-content.mjs — pull the engineering log out of the GitHub wiki and the
 * privacy policy out of the repo root, into src/content/ where Vite can glob
 * them at build time.
 *
 * The wiki is a separate git repo (`<repo>.wiki.git`) that GitHub does not
 * expose through the normal tree API, so cloning it is the only reliable way
 * to read it. We vendor the result into src/content/ and COMMIT it, which
 * means: the site builds offline, CI needs no wiki access, and a wiki edit
 * can't silently change a deployed page — someone has to re-run this and
 * commit the diff.
 *
 * PRIVACY.md is copied rather than duplicated so the store listing, the
 * extension docs, and this page can never disagree about what we collect.
 *
 * Usage: npm run sync:content
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const siteRoot = resolve(here, '..')
const repoRoot = resolve(siteRoot, '..')
const contentDir = join(siteRoot, 'src', 'content')
const wikiDir = join(contentDir, 'wiki')

const WIKI_URL = 'https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel.wiki.git'

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

const tmp = mkdtempSync(join(tmpdir(), 'lychee-wiki-'))
try {
  process.stdout.write(`→ cloning wiki…\n`)
  run('git', ['clone', '--depth', '1', WIKI_URL, tmp], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

  mkdirSync(wikiDir, { recursive: true })
  for (const f of readdirSync(wikiDir)) {
    if (f.endsWith('.md')) rmSync(join(wikiDir, f))
  }

  const pages = readdirSync(tmp).filter((f) => f.endsWith('.md'))
  let copied = 0
  for (const f of pages) {
    // _Sidebar.md drives ordering — keep it, it's parsed as the nav source.
    writeFileSync(join(wikiDir, f), readFileSync(join(tmp, f), 'utf8'))
    copied++
  }
  process.stdout.write(`✓ ${copied} wiki pages → src/content/wiki/\n`)

  copyFileSync(join(repoRoot, 'PRIVACY.md'), join(contentDir, 'privacy.md'))
  process.stdout.write(`✓ PRIVACY.md → src/content/privacy.md\n`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
