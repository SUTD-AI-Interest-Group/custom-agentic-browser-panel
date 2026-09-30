// Shared plumbing for the Von fine-tuning pipeline: bundling the shipped TS,
// JSONL I/O, the deterministic split, and the LM Studio teacher client.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const here = path.dirname(fileURLToPath(import.meta.url))
export const repo = path.resolve(here, '../..')
export const env = process.env
export const DATA = path.resolve(env.VFT_DATA ?? path.join(here, 'data'))
export const LM_URL = env.VFT_LM_URL ?? 'http://127.0.0.1:1234/v1'
export const TEACHERS = (env.VFT_TEACHERS ?? 'google/gemma-4-26b-a4b,qwen3.8-27b-uncensored-mlx').split(',')

const require = createRequire(import.meta.url)
export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

/** esbuild a TS entry from this directory into the cache; returns the output path. */
export async function bundle(entry, format) {
  const esbuild = require(path.join(repo, 'node_modules/esbuild'))
  const out = path.join(DATA, '.cache', entry.replace(/\.ts$/, format === 'iife' ? '.js' : '.mjs'))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(here, entry)], bundle: true, outfile: out, format,
    platform: format === 'iife' ? 'browser' : 'node', target: 'es2022', logLevel: 'error',
  })
  return out
}

/** The shipped actLoop prompt builders (see prompt-entry.ts). */
export async function promptLib() {
  return import(pathToFileURL(await bundle('prompt-entry.ts', 'esm')).href)
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
export function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(row) + '\n')
}
export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

/** Registrable-ish domain, so every page of one site lands in the same split. */
export function siteOf(url) {
  const h = new URL(url).hostname.replace(/^www\./, '')
  const parts = h.split('.')
  return parts.length > 2 && parts.at(-2).length <= 3 ? parts.slice(-3).join('.') : parts.slice(-2).join('.')
}
/** ~10% of SITES (not pages) are validation — a page never shares a site with its val twin. */
export const splitOf = (url, valPct = Number(env.VFT_VAL_PCT ?? 10)) =>
  parseInt(sha(siteOf(url)).slice(0, 8), 16) % 100 < valPct ? 'val' : 'train'

/** Deterministic PRNG so a rerun makes the same picks. */
export function rng(seed) {
  let s = parseInt(sha(String(seed)).slice(0, 8), 16) >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
export const shuffle = (xs, r) => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

/** The last balanced top-level JSON object in a reply (reasoning models may think first). */
export function lastJson(text) {
  if (!text) return null
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  for (let end = s.lastIndexOf('}'); end >= 0; end = s.lastIndexOf('}', end - 1)) {
    let depth = 0
    for (let i = end; i >= 0; i--) {
      if (s[i] === '}') depth++
      else if (s[i] === '{' && --depth === 0) {
        try { return JSON.parse(s.slice(i, end + 1)) } catch { break }
      }
    }
  }
  return null
}

/**
 * One chat completion that must return a JSON object. JSON is requested in the
 * prompt rather than with response_format: a strict schema grammar suppresses
 * a reasoning model's thinking (qwen3.8 then answered with an empty string).
 */
export async function askJson(model, system, user, { maxTokens = 4096, retries = 2, timeoutMs = 600_000 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const t0 = Date.now()
      const res = await fetch(`${LM_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer lm-studio' },
        body: JSON.stringify({
          model, temperature: attempt === 0 ? 0 : 0.3, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`${model} ${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 400)}`)
      const body = await res.json()
      const content = body.choices?.[0]?.message?.content ?? ''
      const json = lastJson(content)
      if (json) return { json, ms: Date.now() - t0, usage: body.usage }
      lastErr = new Error(`no JSON object in reply: ${content.slice(-200)}`)
    } catch (err) {
      lastErr = err
    }
    // LM Studio can 400/500 transiently while it swaps or loads a model.
    if (attempt < retries) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1) ** 2))
  }
  throw lastErr
}

export const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name))

/** First DNS label of a site (`ikea.com`, `www.ikea.com`, `ikea` → `ikea`): the key every corpus shares for the site-level split. */
export const siteKey = (site) => String(site).toLowerCase().replace(/^www\./, '').split('.')[0]
