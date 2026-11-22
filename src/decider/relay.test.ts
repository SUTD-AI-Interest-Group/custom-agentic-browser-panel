import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The SW-side page reads (viewport text, select options). Mocked so each test controls when (and whether) they settle.
vi.mock('../platform/viewportText', () => ({ readViewportText: vi.fn() }))
vi.mock('../platform/domIndex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/domIndex')>()),
  readSelectOptions: vi.fn(),
}))

import { readViewportText } from '../platform/viewportText'
import { readSelectOptions, type IndexedElement, type PageSnapshot } from '../platform/domIndex'
import type { ControlSession, ControlSpec } from '../tools/pageControl'
import type { ControlJournalEntry } from '../tools/pageControlJournal'
import { DECIDER_MAX_TOKENS, DRIVER_RUN_MAX_TOKENS, MODEL_ID, MODEL_STATUS_KEY, PREVIOUS_ACTIONS_WINDOW, type DeciderSettings } from './config'
import { isReadyStatus, readModelReady } from './modelStatus'
import type { FillPlan } from './fillPlan'
import {
  deciderActionLine,
  forwardDeciderHooks,
  MAP_FORM_TIMEOUT_MS,
  NEXT_TIMEOUT_MS,
  parseDeciderRelay,
  parseMapFormRequest,
  parseNextRequest,
  SENSITIVE_VALUE_MASK,
  stepOf,
  type DeciderRelayMsg,
  type DecisionStep,
  type MapFormRequest,
  type NextRequest,
  type RelayedStep,
} from './relay'

beforeEach(() => {
  vi.mocked(readViewportText).mockReset()
  vi.mocked(readViewportText).mockResolvedValue('Checkout. Pay now.')
  vi.mocked(readSelectOptions).mockReset()
  vi.mocked(readSelectOptions).mockResolvedValue({ 1: ['Billing', 'Sales'] })
})

// ---------------------------------------------------------------------------
// relay.ts is bundled into the service worker. Its runtime import closure must stay free of the
// panel-only modules (the engine and its worker, OPFS storage, the panel hooks).
// ---------------------------------------------------------------------------

/** Relative, non-type-only import specifiers of one TypeScript source. */
function runtimeImports(source: string): string[] {
  const out: string[] = []
  const re = /^\s*(?:import|export(?=\s*[{*]))\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m[1]) continue // `import type …` is erased
    const clause = m[2].trim()
    // `import { type A, type B }` is erased too.
    const named = /^\{([\s\S]*)\}$/.exec(clause)
    if (named && named[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue
    out.push(m[3])
  }
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]) // side-effect imports
  return out
}

function closureOf(entry: string): Map<string, string> {
  const seen = new Map<string, string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    const src = readFileSync(file, 'utf8')
    seen.set(file, src)
    for (const spec of runtimeImports(src)) {
      if (!spec.startsWith('.')) {
        seen.set(`pkg:${spec}`, '')
        continue
      }
      visit(resolve(dirname(file), spec.endsWith('.ts') ? spec : `${spec}.ts`))
    }
  }
  visit(entry)
  return seen
}

describe('relay.ts stays service-worker safe', () => {
  const closure = closureOf(resolve(dirname(fileURLToPath(import.meta.url)), 'relay.ts'))

  it('never reaches the engine, its worker, OPFS storage or the panel hooks', () => {
    const names = [...closure.keys()].map((f) => basename(f))
    for (const banned of ['storage.ts', 'engine.ts', 'worker.ts', 'hooks.ts', 'tables.ts', 'tokenizer.ts', 'shadowStore.ts']) {
      expect(names, banned).not.toContain(banned)
    }
    expect([...closure.keys()].filter((k) => k.startsWith('pkg:'))).toEqual([])
  })

  it('pulls in no OPFS, Worker or IndexedDB code at all', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const [file, src] of closure) {
      expect(code(src), file).not.toMatch(/getDirectory|new Worker|indexedDB/)
    }
    // …and the scan would see it if it were there.
    expect(code('// getDirectory\nconst x = 1')).not.toMatch(/getDirectory/)
    expect(code('const d = navigator.storage.getDirectory() // note')).toMatch(/getDirectory/)
  })

  it('modelStatus.ts — the worker’s readiness probe — is in that closure only through toolHost, and touches no OPFS either', () => {
    const probe = closureOf(resolve(dirname(fileURLToPath(import.meta.url)), 'modelStatus.ts'))
    expect([...probe.keys()].map((f) => basename(f)).sort()).toEqual(['config.ts', 'modelStatus.ts'])
  })

  it('the guard itself sees through type-only imports and catches a real one', () => {
    expect(
      runtimeImports(
        `import type { A } from './storage'\nimport { type B } from './engine'\nimport { C, type D } from './hooks'\nimport x from './worker'\nimport './tables'\nexport { y } from './tokenizer'\nexport const z = 1 // comes from 'nowhere'`,
      ).sort(),
    ).toEqual(['./hooks', './tables', './tokenizer', './worker'])
  })
})

// ---------------------------------------------------------------------------
// The whole service worker (final review M13). relay.ts's own closure is not enough: any module the
// worker imports could pull the engine in beside it. So walk EVERYTHING reachable from
// src/background.ts — static imports, re-exports, side-effect imports and dynamic import()s (a lazy
// chunk is still loadable by the worker) — and hold the panel-only decider modules out of it.
// ---------------------------------------------------------------------------

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Relative specifiers a module loads at runtime, dynamic import() included (comments ignored). */
function loadedSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  return [...runtimeImports(code), ...[...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])]
}

function resolveModule(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ''))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      if (/\.(?:ts|tsx|json)$/.test(candidate) && readFileSync(candidate)) return candidate
    } catch {
      /* try the next one */
    }
  }
  return null
}

function serviceWorkerClosure(): { files: Set<string>; packages: Set<string>; unresolved: string[] } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const unresolved: string[] = []
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    if (file.endsWith('.json')) return
    for (const spec of loadedSpecifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) {
        packages.add(spec)
        continue
      }
      const target = resolveModule(file, spec)
      if (target) visit(target)
      else unresolved.push(`${file.slice(SRC.length + 1)} → ${spec}`)
    }
  }
  visit(resolve(SRC, 'background.ts'))
  return { files, packages, unresolved }
}

describe('the service worker (src/background.ts) never reaches the panel-only decider', () => {
  const sw = serviceWorkerClosure()
  const rel = [...sw.files].map((f) => f.slice(SRC.length + 1))

  it('walks the real closure (it resolves every import, and does reach the decider modules it may)', () => {
    expect(sw.unresolved).toEqual([])
    // Sanity: the walk got where the tools execute, and to the SW-safe decider pieces they use.
    for (const reached of ['background/toolHost.ts', 'tools/tools.ts', 'decider/relay.ts', 'decider/driverLoop.ts', 'decider/modelStatus.ts', 'decider/config.ts']) {
      expect(rel, reached).toContain(reached)
    }
  })

  it('contains no engine, worker, OPFS storage, shadow store, panel hooks, tables or tokenizer', () => {
    for (const banned of ['engine.ts', 'worker.ts', 'storage.ts', 'shadowStore.ts', 'hooks.ts', 'tables.ts', 'tokenizer.ts', 'profileLookup.ts', 'stats.ts']) {
      expect(rel, `decider/${banned}`).not.toContain(`decider/${banned}`)
    }
    for (const pkg of sw.packages) expect(pkg, pkg).not.toMatch(/^onnxruntime-web|^@huggingface\/tokenizers/)
  })

  it('no reachable decider module touches OPFS or spawns a Worker', () => {
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const f of rel.filter((r) => r.startsWith('decider/'))) {
      expect(code(readFileSync(resolve(SRC, f), 'utf8')), f).not.toMatch(/getDirectory|createSyncAccessHandle|new Worker/)
    }
  })

  it('the walker follows dynamic import() and index files — it would see a lazy engine', () => {
    expect(loadedSpecifiers(`const e = await import('../decider/engine')\n// import('./commented-out')\nimport type { T } from './t'`)).toEqual(['../decider/engine'])
  })
})

function el(over: Partial<IndexedElement> & { index: number }): IndexedElement {
  return { tag: 'button', name: `Element ${over.index}`, rect: { x: 1, y: 2, width: 3, height: 4 }, sensitive: false, ...over }
}
const snap = (elements: IndexedElement[]): PageSnapshot => ({
  url: 'https://shop.test/checkout', title: 'Checkout', origin: 'https://shop.test', dpr: 2, elements, text: 'registry text', truncated: false,
})
const journal = (summaries: string[]): ControlJournalEntry[] =>
  summaries.map((summary, k) => ({ at: k, action: 'click', summary, undoable: false, sensitive: false, origin: 'o', url: 'u', redactedValue: 'rv', label: 'lbl' }))
const session = (over: Partial<ControlSession> = {}): ControlSession => ({ tabId: 7, origin: 'https://shop.test', plan: 'Check out', active: true, ...over })

const STEP: RelayedStep = {
  tabId: 7,
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  plan: 'Check out',
  previousActions: ['clicked "Cart"'],
  elements: [{ index: 0, tag: 'input', type: 'email', name: 'Email', value: 'a@b.c', sensitive: false }],
  spec: { action: 'type', index: 0 },
  pageText: 'Checkout. Pay now.',
}

describe('stepOf', () => {
  it('carries only what a decision needs', () => {
    const spec: ControlSpec = { action: 'type', index: 1, text: 'typed-text', value: 'v', url: 'https://x.test', label: 'lbl', keys: 'Enter', clear: true, sensitive: true, timeoutMs: 5 }
    const step = stepOf({
      tabId: 7,
      snap: snap([
        el({ index: 0, tag: 'a', name: 'Home', href: 'https://shop.test/', formMethod: 'get', ancestorName: 'nav', role: 'link' }),
        el({ index: 1, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true }),
        el({ index: 2, tag: 'input', type: 'checkbox', name: 'Agree', checked: true }),
      ]),
      spec,
      session: session({ journal: journal(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12']), undoState: new Map([[1, { value: 'old', kind: 'type' }]]) }),
    })
    expect(step).toEqual({
      tabId: 7,
      url: 'https://shop.test/checkout',
      title: 'Checkout',
      plan: 'Check out',
      // The last ten: an eight-field form keeps its first field in view.
      previousActions: ['a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'],
      elements: [
        { index: 0, tag: 'a', role: 'link', name: 'Home', sensitive: false },
        { index: 1, tag: 'input', type: 'password', name: 'Password', value: SENSITIVE_VALUE_MASK, sensitive: true },
        { index: 2, tag: 'input', type: 'checkbox', name: 'Agree', checked: true, sensitive: false },
      ],
      spec: { action: 'type', index: 1 },
    })
    expect(JSON.stringify(step)).not.toContain('hunter2')
    expect(JSON.stringify(step)).not.toContain('typed-text')
  })

  it('describes each previous action with its (redacted) value, and a checkbox click by the state it left', () => {
    const URL_NOW = 'https://shop.test/checkout'
    const entry = (over: Partial<ControlJournalEntry>): ControlJournalEntry => ({
      at: 0, action: 'click', summary: 'clicked something', undoable: false, sensitive: false, origin: 'https://shop.test', url: URL_NOW, ...over,
    })
    const step = stepOf({
      tabId: 7,
      snap: snap([
        el({ index: 3, tag: 'input', type: 'text', name: 'Full name', value: 'Ada Lovelace' }),
        el({ index: 8, tag: 'input', type: 'checkbox', name: 'I agree', checked: true }),
        el({ index: 9, tag: 'input', type: 'checkbox', name: 'Newsletter', checked: false }),
        el({ index: 10, tag: 'button', type: 'submit', name: 'Send' }),
      ]),
      spec: { action: 'click', index: 10 },
      session: session({
        journal: [
          entry({ action: 'type', index: 3, label: 'Full name', summary: 'typed into “Full name”', redactedValue: 'Ada Lovelace' }),
          entry({ action: 'select', index: 6, label: 'Topic', summary: 'chose an option in “Topic”', redactedValue: 'Billing' }),
          entry({ action: 'click', index: 8, label: 'I agree', summary: 'clicked “I agree”' }),
          entry({ action: 'click', index: 9, label: 'Newsletter', summary: 'clicked “Newsletter”' }),
          // On another page: what [8] is now says nothing about what this click did.
          entry({ action: 'click', index: 8, label: 'Remember me', summary: 'clicked “Remember me”', url: 'https://shop.test/login' }),
          entry({ action: 'click', index: 10, label: 'Send', summary: 'clicked “Send”' }), // not a checkbox
          entry({ action: 'scroll', summary: 'scrolled down' }),
        ],
      }),
    })
    expect(step.previousActions).toEqual([
      'typed "Ada Lovelace" into “Full name”',
      'chose "Billing" in “Topic”',
      'ticked “I agree”',
      'unticked “Newsletter”',
      'clicked “Remember me”',
      'clicked “Send”',
      'scrolled down',
    ])
  })
})

describe('deciderActionLine', () => {
  const entry = (over: Partial<ControlJournalEntry>): ControlJournalEntry => ({
    at: 0, action: 'type', summary: 'the summary', undoable: true, sensitive: false, origin: 'o', url: 'u', ...over,
  })

  it('puts the value a type or select set into the line', () => {
    expect(deciderActionLine(entry({ action: 'type', label: 'Email', redactedValue: 'ada@example.com' }))).toBe('typed "ada@example.com" into “Email”')
    expect(deciderActionLine(entry({ action: 'select', label: 'Topic', redactedValue: 'Billing' }))).toBe('chose "Billing" in “Topic”')
    // The journal already redacted it: what it holds is what the decider sees.
    expect(deciderActionLine(entry({ action: 'type', label: 'Password', redactedValue: '••••' }))).toBe('typed "••••" into “Password”')
  })

  it('names an unlabelled target by its index, else the page', () => {
    expect(deciderActionLine(entry({ action: 'type', index: 4, redactedValue: 'x' }))).toBe('typed "x" into element 4')
    expect(deciderActionLine(entry({ action: 'type', redactedValue: 'x' }))).toBe('typed "x" into the page')
  })

  it('caps a long value at 80 characters, ellipsis included', () => {
    const line = deciderActionLine(entry({ action: 'type', label: 'Message', redactedValue: 'y'.repeat(200) }))
    expect(line).toBe(`typed "${'y'.repeat(79)}…" into “Message”`)
    expect(deciderActionLine(entry({ action: 'type', label: 'Message', redactedValue: 'z'.repeat(80) }))).toBe(`typed "${'z'.repeat(80)}" into “Message”`)
  })

  it('says ticked/unticked for a checkbox click whose state is known, and keeps the summary otherwise', () => {
    const click = entry({ action: 'click', index: 8, label: 'I agree', summary: 'clicked “I agree”' })
    expect(deciderActionLine(click, true)).toBe('ticked “I agree”')
    expect(deciderActionLine(click, false)).toBe('unticked “I agree”')
    expect(deciderActionLine(click)).toBe('clicked “I agree”')
    expect(deciderActionLine(entry({ action: 'type', label: 'Name', summary: 'typed into “Name”' }))).toBe('typed into “Name”') // no value
    expect(deciderActionLine(entry({ action: 'scroll', summary: 'scrolled down', redactedValue: 'down' }))).toBe('scrolled down')
    expect(deciderActionLine(entry({ action: 'navigate', summary: 'went to shop.test', redactedValue: 'https://shop.test' }))).toBe('went to shop.test')
  })

  it('the window is ten', () => {
    expect(PREVIOUS_ACTIONS_WINDOW).toBe(10)
  })
})

describe('parseDeciderRelay', () => {
  it('accepts a granted message and a well-formed step', () => {
    expect(parseDeciderRelay({ type: 'decider.granted', conversationId: 'c' })).toEqual({ type: 'decider.granted', conversationId: 'c' })
    expect(parseDeciderRelay({ type: 'decider.step', conversationId: 'c', step: STEP })).toEqual({ type: 'decider.step', conversationId: 'c', step: STEP })
  })

  it('survives the JSON round trip chrome.runtime.sendMessage makes', () => {
    const msg: DeciderRelayMsg = { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'scroll', direction: 'down' } } }
    expect(parseDeciderRelay(JSON.parse(JSON.stringify(msg)))).toEqual(msg)
  })

  it('rebuilds field by field: anything extra is dropped, a sensitive value is masked again', () => {
    const parsed = parseDeciderRelay({
      type: 'decider.step',
      conversationId: 'c',
      extra: 'x',
      step: {
        ...STEP,
        spec: { action: 'type', index: 0, text: 'typed-text' },
        elements: [{ index: 0, tag: 'input', name: 'Pin', value: '1234', sensitive: true, rect: { x: 0 }, href: 'h' }],
        snapshot: 'raw',
      },
    })
    expect(parsed).toEqual({
      type: 'decider.step',
      conversationId: 'c',
      step: { ...STEP, spec: { action: 'type', index: 0 }, elements: [{ index: 0, tag: 'input', name: 'Pin', value: SENSITIVE_VALUE_MASK, sensitive: true }] },
    })
  })

  it.each([
    ['not an object', 'decider.step'],
    ['null', null],
    ['unknown type', { type: 'decider.other', conversationId: 'c' }],
    ['no conversationId', { type: 'decider.granted' }],
    ['empty conversationId', { type: 'decider.granted', conversationId: '' }],
    ['no step', { type: 'decider.step', conversationId: 'c' }],
    ['fractional tabId', { type: 'decider.step', conversationId: 'c', step: { ...STEP, tabId: 1.5 } }],
    ['url not a string', { type: 'decider.step', conversationId: 'c', step: { ...STEP, url: 3 } }],
    ['previousActions not strings', { type: 'decider.step', conversationId: 'c', step: { ...STEP, previousActions: [1] } }],
    ['elements not an array', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: {} } }],
    ['element without an index', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: [{ tag: 'a', name: 'x', sensitive: false }] } }],
    ['element sensitive not boolean', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: [{ index: 0, tag: 'a', name: 'x', sensitive: 'no' }] } }],
    ['element value not a string', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: [{ index: 0, tag: 'a', name: 'x', sensitive: false, value: 5 }] } }],
    ['too many elements', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: Array.from({ length: 1001 }, (_, i) => ({ index: i, tag: 'a', name: 'x', sensitive: false })) } }],
    ['unknown action', { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'submit' } } }],
    ['negative index', { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'click', index: -1 } } }],
    ['unknown direction', { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'scroll', direction: 'left' } } }],
    ['pageText not a string', { type: 'decider.step', conversationId: 'c', step: { ...STEP, pageText: 5 } }],
    ['no pageText (a relayed step must carry the worker’s pre-action read)', { type: 'decider.step', conversationId: 'c', step: { ...STEP, pageText: undefined } }],
    ['pageText far beyond the viewport cap', { type: 'decider.step', conversationId: 'c', step: { ...STEP, pageText: 'x'.repeat(20_001) } }],
  ])('rejects %s', (_label, raw) => {
    expect(parseDeciderRelay(raw)).toBeNull()
  })

  it('carries the worker-read page text, or null when that read failed', () => {
    for (const pageText of ['Checkout. Pay now.', null]) {
      const msg = { type: 'decider.step', conversationId: 'c', step: { ...STEP, pageText } }
      expect(parseDeciderRelay(JSON.parse(JSON.stringify(msg)))).toEqual(msg)
    }
  })
})

describe('forwardDeciderHooks (the service-worker side)', () => {
  const input = () => ({
    tabId: 7,
    snap: snap([el({ index: 0, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true })]),
    spec: { action: 'type', index: 0, text: 'hunter2' } as ControlSpec,
    session: session({ journal: journal(['before']) }),
  })

  it('posts each step for its conversation, captured at call time, when the decider is on', async () => {
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'conv-1', settings: () => ({ mode: 'shadow' }), send })
    const i = input()
    expect(hooks.observeStep(i)).toBeUndefined()
    i.session.journal!.push(...journal(['the step itself'])) // lands after observeStep returns
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const msg = send.mock.calls[0][0] as DeciderRelayMsg
    expect(msg).toMatchObject({
      type: 'decider.step',
      conversationId: 'conv-1',
      step: { tabId: 7, previousActions: ['before'], spec: { action: 'type', index: 0 }, pageText: 'Checkout. Pay now.' },
    })
    expect(JSON.stringify(msg)).not.toContain('hunter2')
    expect(parseDeciderRelay(JSON.parse(JSON.stringify(msg)))).toEqual(msg)

    hooks.sessionGranted()
    expect(send).toHaveBeenLastCalledWith({ type: 'decider.granted', conversationId: 'conv-1' })
  })

  it('reads the page text in the worker BEFORE the action can run, and never waits for it', async () => {
    let settle: (t: string) => void = () => {}
    vi.mocked(readViewportText).mockReturnValue(new Promise<string>((r) => (settle = r)))
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send })
    hooks.observeStep(input())
    // The injection was issued synchronously — ahead of anything the step does next…
    expect(readViewportText).toHaveBeenCalledWith(7, 1200)
    // …but observeStep returned without it, and nothing is posted until the text is in.
    await new Promise((r) => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
    settle('Before the click.')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect((send.mock.calls[0][0] as { step: DecisionStep }).step.pageText).toBe('Before the click.')
  })

  it('posts pageText: null when the worker could not read the page, so the panel records the failure', async () => {
    vi.mocked(readViewportText).mockRejectedValue(new Error('Cannot access contents of the page'))
    const send = vi.fn()
    forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send }).observeStep(input())
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect((send.mock.calls[0][0] as { step: DecisionStep }).step.pageText).toBeNull()
  })

  it('a page-text read that throws synchronously is a failed read, not a thrown step', async () => {
    vi.mocked(readViewportText).mockImplementation(() => {
      throw new Error('chrome.scripting is undefined')
    })
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send })
    expect(() => hooks.observeStep(input())).not.toThrow()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect((send.mock.calls[0][0] as { step: DecisionStep }).step.pageText).toBeNull()
  })

  it('sends nothing when the decider is off, so page structure never rides the channel for it', async () => {
    const send = vi.fn()
    for (const settings of [undefined, { mode: 'off' }] as (DeciderSettings | undefined)[]) {
      const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => settings, send })
      hooks.observeStep(input())
      hooks.sessionGranted()
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
    expect(readViewportText).not.toHaveBeenCalled() // not even a page read
  })

  it('never throws and never surfaces a rejection — no panel open is the normal case', async () => {
    const rejects = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send: () => Promise.reject(new Error('Receiving end does not exist.')) })
    const throws = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send: () => { throw new Error('Extension context invalidated.') } })
    const badSettings = forwardDeciderHooks({ conversationId: 'c', settings: () => { throw new Error('boom') }, send: vi.fn() })
    for (const h of [rejects, throws, badSettings]) {
      expect(() => h.observeStep(input())).not.toThrow()
      expect(() => h.sessionGranted()).not.toThrow()
    }
    await new Promise((r) => setTimeout(r, 10)) // an unhandled rejection here fails the run
  })

  it("with an injected probe, mode() is 'off' until the model is ready", async () => {
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist', actThreshold: 0.7 }), send: vi.fn(), modelReady: async () => true })
    expect(hooks.mode()).toBe('off')
    await new Promise((r) => setTimeout(r, 10))
    expect(hooks.mode()).toBe('assist')
    expect(hooks.threshold()).toBe(0.7)
  })

  it('resolveMode() settles the probe: after it, mode() is exact from the first call', async () => {
    for (const [ready, want] of [[true, 'driver'], [false, 'off']] as const) {
      const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), send: vi.fn(), modelReady: async () => ready })
      expect(await hooks.resolveMode()).toBe(want)
      expect(hooks.mode()).toBe(want)
    }
    const throws = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), send: vi.fn(), modelReady: async () => { throw new Error('storage gone') } })
    expect(await throws.resolveMode()).toBe('off')
  })

  it('with the model missing (probe false), nothing is read, posted or requested — "off" is off in the worker (I1)', async () => {
    const send = vi.fn()
    const request = vi.fn()
    const requestNext = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), send, request, requestNext, modelReady: async () => false })
    await hooks.resolveMode()
    hooks.observeStep(input())
    hooks.sessionGranted()
    hooks.observeFill({ tabId: 7, snap: snap(FORM_ELEMENTS), session: session(), fields: [{ index: 0, value: 'Ada' }] })
    expect(await hooks.mapForm({ ...formInput(), values: {} })).toEqual({ error: 'the decision model is not in Assist mode' })
    expect(
      await hooks.next({ tabId: 7, snap: snap(FORM_ELEMENTS), session: session(), goal: 'g', values: {}, pageText: null, exclude: [] }),
    ).toEqual({ error: 'the decision model is not in Driver mode' })
    await new Promise((r) => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(requestNext).not.toHaveBeenCalled()
    expect(readViewportText).not.toHaveBeenCalled()
    expect(readSelectOptions).not.toHaveBeenCalled()
  })

  it('without a probe, mode() is the settings mode alone — readiness is the panel’s to check', () => {
    let settings: DeciderSettings | undefined = { mode: 'shadow' }
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => settings, send: vi.fn() })
    expect(hooks.mode()).toBe('shadow')
    settings = { mode: 'off' }
    expect(hooks.mode()).toBe('off')
    settings = undefined
    expect(hooks.mode()).toBe('off')
  })
})

// ---------------------------------------------------------------------------
// Form filling across the channel: mapForm is a request/response round trip, observeFill a post
// ---------------------------------------------------------------------------

const FORM_ELEMENTS = [
  el({ index: 0, tag: 'input', type: 'text', name: 'Full name' }),
  el({ index: 1, tag: 'select', name: 'Topic' }),
  el({ index: 2, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true }),
  el({ index: 3, tag: 'select', name: 'Card type', sensitive: true }),
  el({ index: 4, tag: 'input', type: 'checkbox', name: 'I agree', checked: false }),
]
const formInput = () => ({ tabId: 7, snap: snap(FORM_ELEMENTS), session: session({ plan: 'Fill the contact form' }) })

const PLAN: FillPlan = {
  fills: [
    { index: 0, kind: 'text', key: 'profile.full_name', value: 'Ada Lovelace', p: 0.9 },
    { index: 1, kind: 'select', key: 'Billing', value: 'Billing', p: 0.95 },
    { index: 4, kind: 'checkbox', key: 'tick', value: 'tick', p: 0.8 },
  ],
  left: [{ index: 3, reason: 'low-confidence' }],
}

describe('forwardDeciderHooks.mapForm (the service-worker side of assist)', () => {
  const answering = (reply: (msg: MapFormRequest) => unknown) => vi.fn(async (msg: MapFormRequest) => reply(msg))

  it('reads the select options here, asks the panel once, and returns the plan it validated', async () => {
    const request = answering((msg) => ({ requestId: msg.requestId, plan: PLAN }))
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'conv-1', settings: () => ({ mode: 'assist' }), send, request })
    const out = await hooks.mapForm({ ...formInput(), values: { message: 'Charged twice.' } })

    expect(out).toEqual(PLAN)
    // Only the non-sensitive select is read: a sensitive one is never a fill question.
    expect(readSelectOptions).toHaveBeenCalledWith(7, [1])
    expect(request).toHaveBeenCalledTimes(1)
    const msg = request.mock.calls[0][0]
    expect(msg).toEqual({
      type: 'decider.mapForm',
      conversationId: 'conv-1',
      requestId: expect.any(String),
      tabId: 7,
      snap: {
        url: 'https://shop.test/checkout',
        title: 'Checkout',
        elements: [
          { index: 0, tag: 'input', type: 'text', name: 'Full name', sensitive: false },
          { index: 1, tag: 'select', name: 'Topic', sensitive: false },
          { index: 2, tag: 'input', type: 'password', name: 'Password', value: SENSITIVE_VALUE_MASK, sensitive: true },
          { index: 3, tag: 'select', name: 'Card type', sensitive: true },
          { index: 4, tag: 'input', type: 'checkbox', name: 'I agree', checked: false, sensitive: false },
        ],
      },
      plan: 'Fill the contact form',
      selectOptions: { 1: ['Billing', 'Sales'] },
      values: { message: 'Charged twice.' },
    })
    expect(msg.requestId).not.toBe('')
    expect(JSON.stringify(msg)).not.toContain('hunter2')
    // What the panel parses is exactly what was sent, after the JSON round trip.
    expect(parseMapFormRequest(JSON.parse(JSON.stringify(msg)))).toEqual(msg)
    // The fire-and-forget step channel is not used for a request.
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['shadow', { mode: 'shadow' }],
    ['off', { mode: 'off' }],
    ['no settings', undefined],
  ] as [string, DeciderSettings | undefined][])('answers an error without asking anything in %s', async (_label, settings) => {
    const request = vi.fn()
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => settings, request }).mapForm({ ...formInput(), values: {} })
    expect(out).toEqual({ error: expect.stringContaining('Assist') })
    expect(request).not.toHaveBeenCalled()
    expect(readSelectOptions).not.toHaveBeenCalled()
  })

  it('still asks, with no options, when the select read fails', async () => {
    vi.mocked(readSelectOptions).mockRejectedValue(new Error('Cannot access contents of the page'))
    const request = answering((msg) => ({ requestId: msg.requestId, plan: PLAN }))
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request }).mapForm({ ...formInput(), values: {} })
    expect(out).toEqual(PLAN)
    expect(request.mock.calls[0][0].selectOptions).toEqual({})
  })

  it('gives up after its timeout — 90 s by default, since the panel may first need one chat-model call — and tells the panel', async () => {
    expect(MAP_FORM_TIMEOUT_MS).toBe(90_000)
    const request = vi.fn((_msg: MapFormRequest) => new Promise<never>(() => {}))
    const send = vi.fn()
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request, send, mapFormTimeoutMs: 20 }).mapForm({ ...formInput(), values: {} })
    expect(out).toEqual({ error: expect.stringContaining('did not answer') })
    // The panel must not count (or keep working on) a plan nobody will apply.
    expect(send).toHaveBeenCalledWith({ type: 'decider.mapForm.cancel', conversationId: 'c', requestId: request.mock.calls[0][0].requestId })
  })

  it('an abort ends the wait at once and tells the panel; an abort before asking asks nothing', async () => {
    const request = vi.fn((_msg: MapFormRequest) => new Promise<never>(() => {}))
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request, send })
    const controller = new AbortController()
    const out = hooks.mapForm({ ...formInput(), values: {}, signal: controller.signal })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await Promise.race([out, new Promise((r) => setTimeout(() => r('still waiting'), 500))])).toEqual({ error: 'the turn was stopped' })
    expect(send).toHaveBeenCalledWith({ type: 'decider.mapForm.cancel', conversationId: 'c', requestId: request.mock.calls[0][0].requestId })

    request.mockClear()
    send.mockClear()
    expect(await hooks.mapForm({ ...formInput(), values: {}, signal: AbortSignal.abort() })).toEqual({ error: 'the turn was stopped' })
    expect(request).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('sends no cancel when the panel answered, plan or error', async () => {
    const send = vi.fn()
    for (const reply of [(id: string) => ({ requestId: id, plan: PLAN }), (id: string) => ({ requestId: id, error: 'the decision model is not ready' })]) {
      const request = answering((msg) => reply(msg.requestId))
      await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request, send }).mapForm({ ...formInput(), values: {} })
    }
    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    ['the send rejects: no panel is open', () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')), 'no Lychee panel'],
    ['the port closes unanswered', () => Promise.reject(new Error('The message port closed before a response was received.')), 'no Lychee panel'],
    ['nobody answers', async () => undefined, 'no Lychee panel'],
    ['the send throws synchronously', () => { throw new Error('Extension context invalidated.') }, 'Extension context invalidated'],
  ])('answers an error when %s', async (_label, request, reason) => {
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request: request as never }).mapForm({ ...formInput(), values: {} })
    expect(out).toEqual({ error: expect.stringContaining(reason) })
  })

  it("passes the panel's own error through", async () => {
    const request = answering((msg) => ({ requestId: msg.requestId, error: 'the decision model is not ready' }))
    expect(await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request }).mapForm({ ...formInput(), values: {} })).toEqual({
      error: 'the decision model is not ready',
    })
  })

  it.each([
    ['another request’s answer', (id: string) => ({ requestId: `${id}-other`, plan: PLAN })],
    ['a fill for an index not on the page', (id: string) => ({ requestId: id, plan: { ...PLAN, fills: [{ ...PLAN.fills[0], index: 99 }] } })],
    ['a fill of an unknown kind', (id: string) => ({ requestId: id, plan: { ...PLAN, fills: [{ ...PLAN.fills[0], kind: 'submit' }] } })],
    ['two fills for one field', (id: string) => ({ requestId: id, plan: { ...PLAN, fills: [PLAN.fills[0], PLAN.fills[0]] } })],
    ['a value that is not a string', (id: string) => ({ requestId: id, plan: { ...PLAN, fills: [{ ...PLAN.fills[0], value: 7 }] } })],
    ['a probability outside [0, 1]', (id: string) => ({ requestId: id, plan: { ...PLAN, fills: [{ ...PLAN.fills[0], p: Number.NaN }] } })],
    ['an unknown left reason', (id: string) => ({ requestId: id, plan: { ...PLAN, left: [{ index: 3, reason: 'bored' }] } })],
    ['no plan at all', (id: string) => ({ requestId: id })],
  ])('rejects %s as a malformed reply', async (_label, reply) => {
    const request = answering((msg) => reply(msg.requestId))
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request }).mapForm({ ...formInput(), values: {} })
    expect(out).toEqual({ error: expect.stringContaining('malformed') })
  })

  it('never sends a request the panel would reject: values are trimmed to what it accepts, an oversized page is refused here', async () => {
    const request = answering((msg) => ({ requestId: msg.requestId, plan: PLAN }))
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request })
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`v${k}`, 'x']))
    await hooks.mapForm({ ...formInput(), values: { ...many, ['k'.repeat(65)]: 'long key', '': 'empty key' } })
    const sent = request.mock.calls[0][0]
    expect(Object.keys(sent.values)).toHaveLength(50)
    expect(Object.keys(sent.values).every((k) => k.startsWith('v'))).toBe(true)
    expect(parseMapFormRequest(sent)).toEqual(sent)

    const huge = { ...formInput(), snap: { ...snap(FORM_ELEMENTS), url: `https://shop.test/?q=${'x'.repeat(20_001)}` } }
    expect(await hooks.mapForm({ ...huge, values: {} })).toEqual({ error: 'the form is too large to send to the decision model' })
    expect(request).toHaveBeenCalledTimes(1) // not again: nothing the panel would silently drop
  })

  it('rebuilds the plan field by field: anything extra is dropped', async () => {
    const request = answering((msg) => ({
      requestId: msg.requestId,
      extra: 1,
      plan: { fills: [{ ...PLAN.fills[0], note: 'x' }], left: [{ index: 3, reason: 'leave-empty', why: 'y' }], debug: true },
    }))
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), request }).mapForm({ ...formInput(), values: {} })
    expect(out).toEqual({ fills: [PLAN.fills[0]], left: [{ index: 3, reason: 'leave-empty' }] })
  })
})

describe('parseMapFormRequest', () => {
  const REQ: MapFormRequest = {
    type: 'decider.mapForm', conversationId: 'c', requestId: 'r1', tabId: 7,
    snap: { url: 'https://shop.test/', title: 'Shop', elements: [{ index: 0, tag: 'input', type: 'password', name: 'Pin', value: SENSITIVE_VALUE_MASK, sensitive: true }] },
    plan: 'p', selectOptions: { 1: ['A', 'B'] }, values: { message: 'm' },
  }

  it('accepts a well-formed request and re-masks a sensitive value', () => {
    expect(parseMapFormRequest(REQ)).toEqual(REQ)
    const raw = { ...REQ, snap: { ...REQ.snap, elements: [{ ...REQ.snap.elements[0], value: '1234' }] } }
    expect(parseMapFormRequest(raw)).toEqual(REQ)
  })

  it.each([
    ['another type', { ...REQ, type: 'decider.step' }],
    ['an empty requestId', { ...REQ, requestId: '' }],
    ['a value that is not a string', { ...REQ, values: { n: 3 } }],
    ['options that are not a list', { ...REQ, selectOptions: { 1: 'A' } }],
    ['an option key that is not an index', { ...REQ, selectOptions: { x: ['A'] } }],
    ['no snap', { ...REQ, snap: undefined }],
  ])('rejects %s', (_label, raw) => {
    expect(parseMapFormRequest(raw)).toBeNull()
  })
})

describe('forwardDeciderHooks.observeFill (shadowing a call that brought its own fields)', () => {
  const FIELDS = [
    { index: 0, value: 'Ada Lovelace' },
    { index: 2, value: 'hunter2' }, // a sensitive element: never sent
    { index: 4, value: 'true', sensitive: true }, // flagged sensitive by the model: never sent
    { index: 1, value: 'Billing' },
  ]

  it('reads the select options here, then posts the observation with the non-sensitive fields only', async () => {
    let settle: (o: Record<number, string[]>) => void = () => {}
    vi.mocked(readSelectOptions).mockReturnValue(new Promise((r) => (settle = r)))
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'conv-1', settings: () => ({ mode: 'shadow' }), send })
    expect(hooks.observeFill({ ...formInput(), fields: FIELDS })).toBeUndefined()
    expect(readSelectOptions).toHaveBeenCalledWith(7, [1]) // issued before observeFill returned
    await new Promise((r) => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
    settle({ 1: ['Billing', 'Sales'] })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const msg = send.mock.calls[0][0] as DeciderRelayMsg
    expect(msg).toMatchObject({
      type: 'decider.fill',
      conversationId: 'conv-1',
      fill: { tabId: 7, plan: 'Fill the contact form', selectOptions: { 1: ['Billing', 'Sales'] }, fields: [{ index: 0, value: 'Ada Lovelace' }, { index: 1, value: 'Billing' }] },
    })
    expect(JSON.stringify(msg)).not.toContain('hunter2')
    expect(parseDeciderRelay(JSON.parse(JSON.stringify(msg)))).toEqual(msg)
  })

  it('sends nothing when the decider is off, or every field is sensitive', async () => {
    const send = vi.fn()
    forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'off' }), send }).observeFill({ ...formInput(), fields: FIELDS })
    forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send }).observeFill({ ...formInput(), fields: [FIELDS[1], FIELDS[2]] })
    await new Promise((r) => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
    expect(readSelectOptions).not.toHaveBeenCalled()
  })

  it('never throws: a failed read posts no options, a failed send is swallowed', async () => {
    vi.mocked(readSelectOptions).mockImplementation(() => {
      throw new Error('chrome.scripting is undefined')
    })
    const send = vi.fn(() => Promise.reject(new Error('Receiving end does not exist.')))
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist' }), send })
    expect(() => hooks.observeFill({ ...formInput(), fields: FIELDS })).not.toThrow()
    expect(() => hooks.observeFill(null as never)).not.toThrow()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect((send.mock.calls[0] as unknown as [{ fill: { selectOptions: unknown } }])[0].fill.selectOptions).toEqual({})
    await new Promise((r) => setTimeout(r, 10)) // an unhandled rejection here fails the run
  })
})

describe('parseDeciderRelay — decider.mapForm.cancel', () => {
  it('accepts a cancel naming its request, and rebuilds it', () => {
    expect(parseDeciderRelay({ type: 'decider.mapForm.cancel', conversationId: 'c', requestId: 'r1', extra: 1 })).toEqual({
      type: 'decider.mapForm.cancel', conversationId: 'c', requestId: 'r1',
    })
  })

  it.each([
    ['no requestId', { type: 'decider.mapForm.cancel', conversationId: 'c' }],
    ['an empty requestId', { type: 'decider.mapForm.cancel', conversationId: 'c', requestId: '' }],
    ['a requestId that is not a string', { type: 'decider.mapForm.cancel', conversationId: 'c', requestId: 7 }],
  ])('rejects %s', (_label, raw) => {
    expect(parseDeciderRelay(raw)).toBeNull()
  })
})

describe('parseDeciderRelay — decider.fill', () => {
  const FILL = {
    tabId: 7,
    snap: { url: 'https://shop.test/', title: 'Shop', elements: [{ index: 0, tag: 'input', name: 'Name', sensitive: false }] },
    plan: 'p',
    selectOptions: {},
    fields: [{ index: 0, value: 'Ada' }],
  }

  it('accepts and rebuilds a fill observation', () => {
    expect(parseDeciderRelay({ type: 'decider.fill', conversationId: 'c', fill: { ...FILL, extra: 1 } })).toEqual({ type: 'decider.fill', conversationId: 'c', fill: FILL })
  })

  it.each([
    ['fields not a list', { ...FILL, fields: {} }],
    ['a field value that is not a string', { ...FILL, fields: [{ index: 0, value: 1 }] }],
    ['a field index that is not an index', { ...FILL, fields: [{ index: -1, value: 'a' }] }],
    ['no snap', { ...FILL, snap: null }],
  ])('rejects %s', (_label, fill) => {
    expect(parseDeciderRelay({ type: 'decider.fill', conversationId: 'c', fill })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Driver mode across the channel: decider.next is a request per FastSteps step
// ---------------------------------------------------------------------------

const DRIVE_ELEMENTS = [
  el({ index: 0, tag: 'input', type: 'search', name: 'Search products' }),
  el({ index: 1, tag: 'button', type: 'submit', name: 'Search' }),
  el({ index: 2, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true }),
  el({ index: 3, tag: 'select', name: 'Sort by' }),
]
const SORT = ['Featured', 'Price: low to high', 'Price: high to low']
const driveInput = (over: Record<string, unknown> = {}) => ({
  tabId: 7,
  snap: snap(DRIVE_ELEMENTS),
  session: session({ plan: 'Find headphones', journal: journal(['opened the store']) }),
  goal: 'search for wireless headphones',
  values: { query: 'wireless headphones' },
  pageText: 'Northwind Store. Search products.',
  exclude: [{ op: 'click' as const, index: 1 }],
  ...over,
})
const DECISION = { top3: [{ op: 'type', index: 0, p: 0.91 }, { op: 'select', index: 3, p: 0.05 }, { op: 'scroll', p: 0.02 }], tokens: 512, ms: 180 }

describe('forwardDeciderHooks.next (the service-worker side of driver mode)', () => {
  const answering = (reply: (msg: NextRequest) => unknown) => vi.fn(async (msg: NextRequest) => reply(msg))

  it('asks the panel once with the masked page, the worker-read text and the exclusions, and returns the decision it validated', async () => {
    vi.mocked(readSelectOptions).mockResolvedValue({ 3: SORT })
    const requestNext = answering((msg) => ({ requestId: msg.requestId, ...DECISION, value: { key: 'request.query', text: 'wireless headphones', p: 0.88 } }))
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'conv-1', settings: () => ({ mode: 'driver' }), send, requestNext })
    const out = await hooks.next(driveInput())
    expect(out).toEqual({ ...DECISION, value: { key: 'request.query', text: 'wireless headphones', p: 0.88 } })
    expect(requestNext).toHaveBeenCalledTimes(1)
    const msg = requestNext.mock.calls[0][0]
    expect(msg).toEqual({
      type: 'decider.next',
      conversationId: 'conv-1',
      requestId: expect.any(String),
      tabId: 7,
      goal: 'search for wireless headphones',
      plan: 'Find headphones',
      values: { query: 'wireless headphones' },
      snap: {
        url: 'https://shop.test/checkout',
        title: 'Checkout',
        elements: [
          { index: 0, tag: 'input', type: 'search', name: 'Search products', sensitive: false },
          { index: 1, tag: 'button', type: 'submit', name: 'Search', sensitive: false },
          { index: 2, tag: 'input', type: 'password', name: 'Password', value: SENSITIVE_VALUE_MASK, sensitive: true },
          { index: 3, tag: 'select', name: 'Sort by', sensitive: false },
        ],
      },
      pageText: 'Northwind Store. Search products.',
      selectOptions: { 3: SORT },
      previousActions: ['opened the store'],
      exclude: [{ op: 'click', index: 1 }],
    })
    expect(msg.requestId).not.toBe('')
    expect(JSON.stringify(msg)).not.toContain('hunter2')
    expect(parseNextRequest(JSON.parse(JSON.stringify(msg)))).toEqual(msg)
    expect(send).not.toHaveBeenCalled() // a request, not a post
    expect(readViewportText).not.toHaveBeenCalled() // the loop read it, before the step
    expect(readSelectOptions).toHaveBeenCalledWith(7, [3]) // the worker reads what a select can choose
  })

  it('a @driver run: the hooks say so, and a step’s token cap rides the request (absent otherwise)', async () => {
    vi.mocked(readSelectOptions).mockResolvedValue({ 3: SORT })
    const requestNext = answering((msg) => ({ requestId: msg.requestId, ...DECISION }))
    const driver = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext, driverRun: true })
    expect(driver.driverRun).toBe(true)
    await driver.next({ ...driveInput(), maxTokens: DRIVER_RUN_MAX_TOKENS })
    expect(requestNext.mock.calls[0][0].maxTokens).toBe(DRIVER_RUN_MAX_TOKENS)
    const plain = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext })
    expect(plain).not.toHaveProperty('driverRun')
    await plain.next(driveInput())
    expect(requestNext.mock.calls[1][0]).not.toHaveProperty('maxTokens')
  })

  it('accepts a select value only when it is one of the options this worker read off that select', async () => {
    vi.mocked(readSelectOptions).mockResolvedValue({ 3: SORT })
    const choose = (text: string) =>
      answering((msg) => ({ requestId: msg.requestId, top3: [{ op: 'select', index: 3, p: 0.9 }], tokens: 400, ms: 150, value: { key: 'option.1', text, p: 0.8 } }))
    const ok = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext: choose('Price: low to high') }).next(driveInput())
    expect(ok).toMatchObject({ value: { key: 'option.1', text: 'Price: low to high', p: 0.8 } })
    const invented = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext: choose('Delete my account') }).next(driveInput())
    expect(invented).toEqual({ error: expect.stringContaining('malformed') })
  })

  it('enforces its own exclusions on the reply: an excluded pair anywhere in it is an error, never a decision', async () => {
    const offering = (top3: unknown[], extra: Record<string, unknown> = {}) =>
      answering((msg) => ({ requestId: msg.requestId, top3, tokens: 400, ms: 150, ...extra }))
    const hooks = (requestNext: ReturnType<typeof answering>) => forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext })
    // driveInput excludes click [1].
    expect(await hooks(offering([{ op: 'click', index: 1, p: 0.9 }])).next(driveInput())).toEqual({ error: expect.stringContaining('exclude') })
    expect(await hooks(offering([{ op: 'scroll', p: 0.6 }, { op: 'click', index: 1, p: 0.3 }])).next(driveInput())).toEqual({ error: expect.stringContaining('exclude') })
    expect(await hooks(offering([{ op: 'click', index: 1, p: 0.9 }], { steerPending: true })).next(driveInput())).toMatchObject({ steerPending: true })
    expect(await hooks(offering([{ op: 'click', index: 0, p: 0.9 }])).next(driveInput())).toMatchObject({ top3: [{ op: 'click', index: 0, p: 0.9 }] })
  })

  it.each([
    ['assist', { mode: 'assist' }],
    ['shadow', { mode: 'shadow' }],
    ['off', { mode: 'off' }],
    ['no settings', undefined],
  ] as [string, DeciderSettings | undefined][])('answers an error without asking anything in %s', async (_label, settings) => {
    const requestNext = vi.fn()
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => settings, requestNext }).next(driveInput())
    expect(out).toEqual({ error: expect.stringContaining('Driver') })
    expect(requestNext).not.toHaveBeenCalled()
  })

  it('gives up after 30 s by default and tells the panel', async () => {
    expect(NEXT_TIMEOUT_MS).toBe(30_000)
    const requestNext = vi.fn((_msg: NextRequest) => new Promise<never>(() => {}))
    const send = vi.fn()
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext, send, nextTimeoutMs: 20 }).next(driveInput())
    expect(out).toEqual({ error: expect.stringContaining('did not answer') })
    expect(send).toHaveBeenCalledWith({ type: 'decider.next.cancel', conversationId: 'c', requestId: requestNext.mock.calls[0][0].requestId })
  })

  it('an abort ends the wait at once and tells the panel; an abort before asking asks nothing', async () => {
    const requestNext = vi.fn((_msg: NextRequest) => new Promise<never>(() => {}))
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext, send })
    const controller = new AbortController()
    const out = hooks.next({ ...driveInput(), signal: controller.signal })
    await vi.waitFor(() => expect(requestNext).toHaveBeenCalledTimes(1))
    controller.abort()
    expect(await Promise.race([out, new Promise((r) => setTimeout(() => r('still waiting'), 500))])).toEqual({ error: 'the turn was stopped' })
    expect(send).toHaveBeenCalledWith({ type: 'decider.next.cancel', conversationId: 'c', requestId: requestNext.mock.calls[0][0].requestId })

    requestNext.mockClear()
    send.mockClear()
    expect(await hooks.next({ ...driveInput(), signal: AbortSignal.abort() })).toEqual({ error: 'the turn was stopped' })
    expect(requestNext).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("passes the panel's error through, with the dense and steer flags", async () => {
    const requestNext = answering((msg) => ({ requestId: msg.requestId, error: 'dense page (3540 tokens)', dense: true, steerPending: true, extra: 1 }))
    expect(await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext }).next(driveInput())).toEqual({
      error: 'dense page (3540 tokens)',
      dense: true,
      steerPending: true,
    })
  })

  it('carries a steer flag on a decision', async () => {
    const requestNext = answering((msg) => ({ requestId: msg.requestId, ...DECISION, steerPending: true }))
    expect(await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext }).next(driveInput())).toEqual({ ...DECISION, steerPending: true })
  })

  it.each([
    ['another request’s answer', (id: string) => ({ ...DECISION, requestId: `${id}-other` })],
    ['an option for an element not on the page', (id: string) => ({ requestId: id, ...DECISION, top3: [{ op: 'click', index: 99, p: 0.9 }] })],
    ['an unknown op', (id: string) => ({ requestId: id, ...DECISION, top3: [{ op: 'navigate', p: 0.9 }] })],
    ['a click without an index', (id: string) => ({ requestId: id, ...DECISION, top3: [{ op: 'click', p: 0.9 }] })],
    ['a probability outside [0, 1]', (id: string) => ({ requestId: id, ...DECISION, top3: [{ op: 'scroll', p: 1.5 }] })],
    ['no options', (id: string) => ({ requestId: id, ...DECISION, top3: [] })],
    ['a value under a click', (id: string) => ({ requestId: id, ...DECISION, top3: [{ op: 'click', index: 1, p: 0.9 }], value: { key: 'request.query', text: 'x', p: 0.9 } })],
    ['a value whose text is not a string', (id: string) => ({ requestId: id, ...DECISION, value: { key: 'request.query', text: 7, p: 0.9 } })],
    ['no timing', (id: string) => ({ requestId: id, top3: DECISION.top3 })],
  ])('rejects %s as a malformed reply', async (_label, reply) => {
    const requestNext = answering((msg) => reply(msg.requestId))
    const out = await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext }).next(driveInput())
    expect(out).toEqual({ error: expect.stringContaining('malformed') })
  })

  it('answers an error when no panel is open', async () => {
    const requestNext = vi.fn(() => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')))
    expect(await forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), requestNext }).next(driveInput())).toEqual({
      error: expect.stringContaining('no Lychee panel'),
    })
  })
})

describe('driver mode includes assist and shadow', () => {
  it('observeStep posts, sessionGranted posts, and mapForm asks — all in driver mode', async () => {
    const send = vi.fn()
    const request = vi.fn(async (msg: MapFormRequest) => ({ requestId: msg.requestId, plan: PLAN }))
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'driver' }), send, request })
    expect(await hooks.mapForm({ ...formInput(), values: {} })).toEqual(PLAN)
    hooks.sessionGranted()
    expect(send).toHaveBeenCalledWith({ type: 'decider.granted', conversationId: 'c' })
    hooks.observeStep({ tabId: 7, snap: snap(DRIVE_ELEMENTS), spec: { action: 'click', index: 1 }, session: session() })
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'decider.step' })))
    expect(hooks.settingsMode()).toBe('driver')
  })
})

describe('parseNextRequest', () => {
  const REQ: NextRequest = {
    type: 'decider.next', conversationId: 'c', requestId: 'r1', tabId: 7, goal: 'g', plan: 'p', values: { query: 'q' },
    snap: { url: 'https://shop.test/', title: 'Shop', elements: [{ index: 0, tag: 'input', type: 'password', name: 'Pin', value: SENSITIVE_VALUE_MASK, sensitive: true }] },
    pageText: null, selectOptions: { 4: ['A', 'B'] }, previousActions: ['a'], exclude: [{ op: 'click', index: 0 }, { op: 'scroll' }],
  }

  it('accepts a well-formed request, re-masks a sensitive value and drops anything extra', () => {
    expect(parseNextRequest(REQ)).toEqual(REQ)
    const raw = { ...REQ, extra: 1, snap: { ...REQ.snap, elements: [{ ...REQ.snap.elements[0], value: '1234' }] } }
    expect(parseNextRequest(raw)).toEqual(REQ)
  })

  it.each([
    ['another type', { ...REQ, type: 'decider.mapForm' }],
    ['an empty requestId', { ...REQ, requestId: '' }],
    ['a goal that is not a string', { ...REQ, goal: 1 }],
    ['page text that is not a string or null', { ...REQ, pageText: 3 }],
    ['an exclusion with an unknown op', { ...REQ, exclude: [{ op: 'press' }] }],
    ['a click exclusion without an index', { ...REQ, exclude: [{ op: 'click' }] }],
    ['a scroll exclusion with an index', { ...REQ, exclude: [{ op: 'scroll', index: 2 }] }],
    ['too many exclusions', { ...REQ, exclude: Array.from({ length: 51 }, () => ({ op: 'scroll' })) }],
    ['values that are not strings', { ...REQ, values: { query: 1 } }],
    ['select options that are not lists', { ...REQ, selectOptions: { 4: 'A' } }],
    ['no select options', { ...REQ, selectOptions: undefined }],
    ['a token cap that is not an integer', { ...REQ, maxTokens: 2500.5 }],
    ['a token cap of zero', { ...REQ, maxTokens: 0 }],
    ['a token cap over the engine’s hard cap', { ...REQ, maxTokens: DECIDER_MAX_TOKENS + 1 }],
    ['a token cap that is a string', { ...REQ, maxTokens: '6000' }],
  ])('rejects %s', (_label, raw) => {
    expect(parseNextRequest(raw)).toBeNull()
  })

  it('carries a @driver run’s token cap; a request without one has none', () => {
    expect(parseNextRequest({ ...REQ, maxTokens: DRIVER_RUN_MAX_TOKENS })).toEqual({ ...REQ, maxTokens: DRIVER_RUN_MAX_TOKENS })
    expect(parseNextRequest({ ...REQ, maxTokens: DECIDER_MAX_TOKENS })).toEqual({ ...REQ, maxTokens: DECIDER_MAX_TOKENS })
    expect(parseNextRequest(REQ)).not.toHaveProperty('maxTokens')
  })

  it('a driver cancel is a relay message like assist’s', () => {
    expect(parseDeciderRelay({ type: 'decider.next.cancel', conversationId: 'c', requestId: 'r1', x: 1 })).toEqual({ type: 'decider.next.cancel', conversationId: 'c', requestId: 'r1' })
    expect(parseDeciderRelay({ type: 'decider.next.cancel', conversationId: 'c', requestId: '' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// modelStatus.ts — the worker-safe readiness probe (I1)
// ---------------------------------------------------------------------------

describe('modelStatus: ready means the status record says ready, for this build’s model', () => {
  it('isReadyStatus', () => {
    expect(isReadyStatus({ state: 'ready', modelId: MODEL_ID, bytes: 1, importedAt: 1 })).toBe(true)
    for (const raw of [undefined, null, 'ready', {}, { state: 'ready' }, { state: 'ready', modelId: 'another-model' }, { state: 'importing', done: 1, total: 2 }, { state: 'failed', message: 'x' }, { state: 'absent' }]) {
      expect(isReadyStatus(raw), JSON.stringify(raw)).toBe(false)
    }
  })

  it('readModelReady reads only the status key, and is false (never a rejection) when storage fails', async () => {
    const get = vi.fn(async (key: string) => ({ [key]: { state: 'ready', modelId: MODEL_ID, bytes: 1, importedAt: 1 } }))
    vi.stubGlobal('chrome', { storage: { local: { get } } })
    expect(await readModelReady()).toBe(true)
    expect(get).toHaveBeenCalledWith(MODEL_STATUS_KEY)
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => ({})) } } })
    expect(await readModelReady()).toBe(false)
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async () => { throw new Error('gone') }) } } })
    expect(await readModelReady()).toBe(false)
    vi.stubGlobal('chrome', undefined)
    expect(await readModelReady()).toBe(false)
    vi.unstubAllGlobals()
  })
})
