import { readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// An MV3 service worker cannot load code on demand: `import()` is disallowed in
// ServiceWorkerGlobalScope, and the failure is a TypeError at the moment the code path runs — the
// worker still starts, so nothing obvious breaks (the MCP task monitor silently stopped polling the
// one time this happened). Every dynamic import() reachable from the worker's entry must therefore
// be one that provably never EXECUTES there. This pins that list: adding a lazy load anywhere in
// the worker's graph fails here until someone records why it is safe.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ALLOWED: Record<string, string> = {
  // pdf.ts runs only in page-like contexts (side panel, offscreen host), never the worker (CLAUDE.md).
  'platform/pdf.ts -> pdfjs-dist': 'page-only',
  'platform/pdf.ts -> pdfjs-dist/build/pdf.worker.min.mjs?url': 'page-only',
  // The parsers built on parse5 are called by research tools (offscreen host) and link previews
  // (panel); the worker imports webFetch only for its URL guard.
  'platform/extractionHtml.ts -> parse5': 'page-only callers',
  // The worker's entry provides this module statically (provideMcpClientModule), so the import()
  // branch is never taken there — and newClient() throws a clear error if it ever would be.
  'mcp/manager.ts -> @modelcontextprotocol/sdk/client/index.js': 'provided statically by background.ts',
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
const staticSpecs = (c: string) =>
  [...c.matchAll(/(?:^|[\s;])(?:import|export)\s+(?!type\b)(?:[\w*{}\s,$]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1])
// `typeof import('x')` is a type, not a load.
const dynamicSpecs = (c: string) =>
  [...c.matchAll(/(?<!typeof\s)\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])

function resolveModule(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ''))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try {
      if (/\.(?:ts|tsx)$/.test(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* next */
    }
  }
  return null
}

function dynamicImportsReachableFromWorker(): string[] {
  const seen = new Set<string>()
  const found = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const code = strip(readFileSync(file, 'utf8'))
    for (const spec of dynamicSpecs(code)) found.add(`${relative(SRC, file)} -> ${spec}`)
    for (const spec of [...staticSpecs(code), ...dynamicSpecs(code)]) {
      if (!spec.startsWith('.')) continue
      const target = resolveModule(file, spec)
      if (target) visit(target)
    }
  }
  visit(resolve(SRC, 'background.ts'))
  return [...found].sort()
}

describe('the service worker never runs a dynamic import()', () => {
  it('reaches only dynamic imports recorded as never executing in the worker', () => {
    expect(dynamicImportsReachableFromWorker()).toEqual(Object.keys(ALLOWED).sort())
  })

  it('the worker entry provides the MCP client module before anything can connect', () => {
    const entry = strip(readFileSync(resolve(SRC, 'background.ts'), 'utf8'))
    expect(entry).toMatch(/import \* as \w+ from '@modelcontextprotocol\/sdk\/client\/index\.js'/)
    expect(entry).toMatch(/^provideMcpClientModule\(\w+\)/m)
  })

  it('the walker sees a lazy load and ignores type-only `typeof import()`', () => {
    expect(dynamicSpecs(`const a = await import('./x')\ntype M = typeof import('./y')`)).toEqual(['./x'])
  })
})
