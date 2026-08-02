import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

// SENSITIVE_RE and INTERACTIVE_ROLES live INSIDE buildInteractiveIndex, the
// function injected via chrome.scripting.executeScript — it must stay fully
// self-contained (no module-scope imports/closures, per the project's inj*
// convention), so these regexes cannot simply be imported for testing.
//
// Extracting the literal regex text straight out of the real source (instead
// of retyping it here) is what keeps this test honest: it exercises whatever
// the real file says TODAY, so a future edit to the real regex is what this
// test actually pins down, not a hand-copied stand-in that can silently drift
// from it.
//
// Resolved via fileURLToPath + path.join rather than `new URL('./x', import.
// meta.url)`: under this project's vitest+jsdom setup, resolving a relative
// URL against import.meta.url as the base silently lands on
// http://localhost:3000/... instead of the file:// path (a jsdom/vitest
// interaction, not anything specific to this file).
const HERE = fileURLToPath(import.meta.url)
const SRC_PATH = join(dirname(HERE), 'domIndex.ts')
const source = readFileSync(SRC_PATH, 'utf-8')

function extractRegex(name: string): RegExp {
  const re = new RegExp(`const ${name} =\\s*\\n?\\s*(/(?:[^/\\\\\\n]|\\\\.)*/[a-z]*)`)
  const m = source.match(re)
  if (!m) throw new Error(`could not find ${name} in domIndex.ts — has it been renamed or reformatted?`)
  // Extracting the ACTUAL regex literal out of the real source, not
  // re-implementing it — indirect eval evaluates the literal in isolation.
  return (0, eval)(m[1])
}

describe('domIndex — SENSITIVE_RE (extracted from the real source)', () => {
  const SENSITIVE_RE = extractRegex('SENSITIVE_RE')

  it('matches the already-covered vocabulary', () => {
    for (const s of [
      'cardNumber',
      'accountNumber',
      'account number',
      'cvv',
      'ccv',
      'ssn',
      'password',
      'routing',
      'pin',
      'security code',
      'otp',
      'iban',
      'sort code',
    ]) {
      expect(SENSITIVE_RE.test(s), `expected "${s}" to match`).toBe(true)
    }
  })

  // CRITICAL (d03 F3): the near-universal cc/acct abbreviations were missing
  // entirely, so a real payment field named this way was never flagged
  // sensitive — defeating the "sensitive fields always raise a card" contract.
  it('matches the cc/acct abbreviations the CRITICAL finding says are missed', () => {
    for (const s of ['ccNumber', 'cc-number', 'cc_num', 'ccNo', 'acctNum', 'acct_number', 'acct']) {
      expect(SENSITIVE_RE.test(s), `expected "${s}" to match`).toBe(true)
    }
  })

  it('does not false-positive on unrelated field names', () => {
    for (const s of ['email', 'firstName', 'address', 'city', 'accept', 'accessory']) {
      expect(SENSITIVE_RE.test(s), `expected "${s}" NOT to match`).toBe(false)
    }
  })
})

describe('domIndex — INTERACTIVE_ROLES (extracted from the real source)', () => {
  const INTERACTIVE_ROLES = extractRegex('INTERACTIVE_ROLES')

  it('matches lowercase roles', () => {
    expect(INTERACTIVE_ROLES.test('button')).toBe(true)
    expect(INTERACTIVE_ROLES.test('tab')).toBe(true)
    expect(INTERACTIVE_ROLES.test('combobox')).toBe(true)
  })

  // LOW (d03 F6): every other classification regex in this codebase carries
  // the /i flag; this one alone didn't, so role="Button"/role="TAB" (sloppy
  // but real-world ARIA authoring) failed to match.
  it('matches roles regardless of case', () => {
    expect(INTERACTIVE_ROLES.test('Button')).toBe(true)
    expect(INTERACTIVE_ROLES.test('TAB')).toBe(true)
    expect(INTERACTIVE_ROLES.test('Combobox')).toBe(true)
    expect(INTERACTIVE_ROLES.test('Switch')).toBe(true)
  })

  it('still rejects non-interactive roles', () => {
    expect(INTERACTIVE_ROLES.test('presentation')).toBe(false)
    expect(INTERACTIVE_ROLES.test('article')).toBe(false)
  })
})

// MEDIUM (d04 F5): a plain querySelectorAll('*') never descends into an open
// shadow root — a <button> living inside a web component was entirely
// invisible to the index, with no truncation-style flag telling the model
// content was skipped. Runs the REAL buildInteractiveIndex (extracted from
// the source and stripped of TypeScript syntax) against a fixture with an
// actual open shadow root, so this proves the fix landed in the function
// chrome.scripting.executeScript actually injects, not a stand-in.
const require = createRequire(import.meta.url)
const esbuildBin = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild')

function extractFunctionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`could not find function ${name} in domIndex.ts`)
  let depth = 0
  let bodyStarted = false
  let end = -1
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      depth++
      bodyStarted = true
    } else if (ch === '}') {
      depth--
      if (bodyStarted && depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error(`could not brace-match function ${name} in domIndex.ts`)
  return source.slice(start, end)
}

function extractInjected(name: string): (...args: any[]) => any {
  const raw = extractFunctionSource(name)
  // esbuild's own JS API can't run in-process under vitest's jsdom
  // environment (its TextEncoder fails esbuild's realm-identity check), so
  // this shells out to esbuild's CLI binary in a clean, separate process —
  // see pageActions.test.ts for the same technique and the full explanation.
  const code = execFileSync(esbuildBin, ['--loader=ts', '--target=es2022'], { input: raw, encoding: 'utf-8' })
  // eslint-disable-next-line no-new-func -- executing the real, extracted+stripped source, not hand-written logic
  return new Function(`"use strict"; return (${code})`)()
}

// Shared by every describe block below that needs a specific element to read
// as "visible": isVisible() needs a real-looking rect (jsdom's real
// getBoundingClientRect always reports 0x0 — there is no layout engine) and a
// hit-test via elementFromPoint (jsdom does not implement this at all). Both
// are Chrome runtime facts these fixtures have to fake; the behavior under
// test in each case is otherwise untouched. Hoisted out of the F5 describe
// block (which originally owned it alone) so the S5/ancestorName describes
// below can reuse the same stub instead of re-deriving it.
const savedRect = Element.prototype.getBoundingClientRect
const savedEFP = document.elementFromPoint

afterEach(() => {
  document.body.innerHTML = ''
  Element.prototype.getBoundingClientRect = savedRect
  document.elementFromPoint = savedEFP
})

function stubLayoutFor(el: Element) {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const base = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40, toJSON() {} }
    return this === el ? (base as DOMRect) : ({ ...base, width: 0, height: 0 } as DOMRect)
  }
  document.elementFromPoint = () => el
}

describe('domIndex — shadow DOM piercing (F5)', () => {
  it('indexes an interactive element inside an open shadow root', () => {
    document.body.innerHTML = '<my-widget></my-widget>'
    const host = document.querySelector('my-widget')!
    const shadow = (host as any).attachShadow ? host.attachShadow({ mode: 'open' }) : null
    if (!shadow) return // jsdom build without Shadow DOM support — skip rather than false-fail
    // aria-label rather than visible text: accessibleName() prefers innerText,
    // which jsdom does not compute (no layout engine) — aria-label sidesteps
    // that unrelated gap so this test isolates the shadow-piercing fix itself.
    shadow.innerHTML = '<button aria-label="Do the thing"></button>'
    const button = shadow.querySelector('button') as HTMLElement
    stubLayoutFor(button)

    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    const names = (result.elements as Array<{ name: string }>).map((e) => e.name)
    expect(names).toContain('Do the thing')
  })
})

// (S5) Element.closest('form') does not pierce a shadow boundary: a
// form-associated custom element whose internal submit control lives in an
// open shadow root, with the real <form> in the light DOM outside it, used
// to read formMethod:undefined — silently exempting it from browsePolicy's
// "no POST submits" deny. Runs the real buildInteractiveIndex against a
// fixture that reproduces exactly that light-DOM-form / shadow-DOM-button
// split, reusing the same shadow-piercing technique F5 already proved works
// (just walking the opposite direction: up via getRootNode().host instead of
// down via el.shadowRoot).
describe('domIndex — formMethod resolves across a shadow boundary (S5)', () => {
  it('finds the light-DOM ancestor <form> from a button inside an open shadow root', () => {
    document.body.innerHTML = '<form method="post"><my-widget></my-widget></form>'
    const host = document.querySelector('my-widget')!
    const shadow = (host as any).attachShadow ? host.attachShadow({ mode: 'open' }) : null
    if (!shadow) return // jsdom build without Shadow DOM support — skip rather than false-fail
    shadow.innerHTML = '<button aria-label="Submit"></button>'
    const button = shadow.querySelector('button') as HTMLElement
    stubLayoutFor(button)

    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    const entry = (result.elements as Array<{ name: string; formMethod?: string }>).find((e) => e.name === 'Submit')
    expect(entry?.formMethod).toBe('post')
  })
})

// (S2/S3) ancestorName is the raw DOM fact the classifiers (pageControl.ts,
// browsePolicy.ts) read to close the event-delegation gap: a container
// attaches one handler (or is itself a <form>/dialog) and dispatches by
// target, so the actually-clicked descendant can carry an innocuous name of
// its own while its container's own name says otherwise. domIndex.ts only
// collects the fact here — see pageControl.test.ts / browsePolicy.test.ts for
// the classifiers actually treating a committing ancestorName as committing.
describe('domIndex — ancestorName (delegated committing context, S2/S3)', () => {
  it("reads a <form>'s own aria-label for a descendant with no name of its own", () => {
    document.body.innerHTML = '<form aria-label="Delete account"><button></button></form>'
    const button = document.querySelector('button') as HTMLElement
    stubLayoutFor(button)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    const entry = (result.elements as Array<{ ancestorName?: string }>)[0]
    expect(entry?.ancestorName).toBe('Delete account')
  })

  it("reads a dialog/alertdialog ancestor's title from its first heading when there is no aria-label", () => {
    document.body.innerHTML = '<div role="alertdialog"><h2>Delete this file?</h2><button aria-label="OK"></button></div>'
    const button = document.querySelector('button') as HTMLElement
    stubLayoutFor(button)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    const entry = (result.elements as Array<{ ancestorName?: string }>)[0]
    expect(entry?.ancestorName).toBe('Delete this file?')
  })

  it("reads the nearest independently-clickable ancestor's own aria-label (event-delegation pattern)", () => {
    // aria-label rather than visible text on the span too — see the F5
    // comment above: jsdom computes no innerText at all (no layout engine),
    // so an un-labelled span would read as name:'' regardless of this fix.
    document.body.innerHTML = '<div aria-label="Delete row" onclick="void 0"><span role="button" aria-label="Row 42"></span></div>'
    const span = document.querySelector('span') as HTMLElement
    stubLayoutFor(span)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    const entry = (result.elements as Array<{ name: string; ancestorName?: string }>).find((e) => e.name === 'Row 42')
    expect(entry?.ancestorName).toBe('Delete row')
  })

  it('is empty when no ancestor names itself — card-fatigue guard against flagging every form/dialog membership', () => {
    document.body.innerHTML = '<form><button aria-label="Save"></button></form>'
    const button = document.querySelector('button') as HTMLElement
    stubLayoutFor(button)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    const entry = (result.elements as Array<{ ancestorName?: string }>)[0]
    expect(entry?.ancestorName ?? '').toBe('')
  })
})
