import { describe, it, expect, afterEach, vi } from 'vitest'
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

// (C6) SENSITIVE_RE's multi-word phrases (social security, sort code,
// security code) require a literal space, and the account alternation had
// no "num" abbreviation — but real name/id values are written kebab-case,
// snake_case or camelCase, never "account number" with an actual space, so
// every one of these silently read as sensitive:false. Runs the REAL
// buildInteractiveIndex (not just the extracted regex) against an <input>
// whose id alone carries the field's identity, so this proves the fix
// landed in the full `sensitive` computation — normalizeForSensitivity is a
// const arrow function nested inside buildInteractiveIndex and can't be
// extracted standalone the way SENSITIVE_RE (a plain regex literal) can.
describe('domIndex — sensitivity is robust to separator conventions (C6)', () => {
  it('flags every separator convention the CRITICAL finding says is missed', () => {
    for (const id of [
      'account_number',
      'account-number',
      'accountNum',
      'sort_code',
      'sortCode',
      'security_code',
      'socialSecurityNumber',
      'social_security_number',
    ]) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" to be sensitive`).toBe(true)
    }
  })

  // Guard against over-matching: normalizing separators/camelCase must not
  // turn ordinary field names into new false positives.
  it('does not false-positive on ordinary field names after normalization', () => {
    for (const id of ['username', 'email', 'search', 'firstName', 'address', 'comment', 'quantity']) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" NOT to be sensitive`).toBe(false)
    }
  })

  // Calibration cases from the audit (S3): unaffected by this fix, must
  // stay exactly as before — "account"/"bankAccount" carry no number/no/num
  // suffix at all, so they must not start matching just because "num" was
  // added to the alternation.
  it('leaves bare "account"/"bankAccount" non-sensitive — no number/no/num suffix present', () => {
    for (const id of ['account', 'bankAccount']) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" NOT to be sensitive`).toBe(false)
    }
  })
})

// (C5) sensitivity used to be tested ONLY against name/id — a field whose
// human-readable label lives in placeholder, aria-label, or an associated
// <label> (extremely common in React/MUI-style forms with generated ids,
// e.g. id="mui-42") read as sensitive:false no matter how plainly the label
// said "Card number". Runs the REAL buildInteractiveIndex against fixtures
// that reproduce each labelling shape from the audit.
describe('domIndex — sensitivity reads placeholder/aria-label/associated labels (C5)', () => {
  it('flags a field whose ONLY sensitive signal is its placeholder (the reported repro case)', () => {
    document.body.innerHTML = '<input id="mui-42" placeholder="Card number" autocomplete="off">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  it('flags a field whose ONLY sensitive signal is its aria-label', () => {
    document.body.innerHTML = '<input id="mui-7" aria-label="Social security number">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  // The masking gap accessibleName() alone would have: aria-label wins its
  // internal priority cascade, so a bland aria-label sitting next to a
  // sensitive placeholder would otherwise hide the placeholder entirely.
  it('flags a sensitive placeholder even when a bland aria-label is also present', () => {
    document.body.innerHTML = '<input id="mui-13" aria-label="Field 3" placeholder="Card number">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  it('flags a field labelled via an associated <label for>', () => {
    document.body.innerHTML = '<label for="mui-9">Card number</label><input id="mui-9">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  it('flags a field labelled by a wrapping <label>', () => {
    document.body.innerHTML = '<label>Card number <input id="mui-10"></label>'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  it('does not false-positive on a field with a benign placeholder/aria-label/label', () => {
    document.body.innerHTML =
      '<label for="mui-11">First name</label><input id="mui-11" placeholder="Jane" aria-label="First name">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(false)
  })

  // The load-bearing property (see accessibleName's S4 comment): a label —
  // however it's spelled — can only ADD a sensitivity detection, never
  // suppress one. type="password" is a structural, non-name-based signal;
  // an innocuous aria-label must not undo it.
  it('an innocuous aria-label cannot suppress the type=password structural check', () => {
    document.body.innerHTML = '<input id="mui-12" type="password" aria-label="Search">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  // Same property from the name/id side: a sensitive id stays sensitive no
  // matter what a co-located label claims.
  it('a benign-sounding aria-label cannot suppress a sensitive id', () => {
    document.body.innerHTML = '<input id="cardNumber" aria-label="Optional field">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })
})

// (Follow-up HIGH) aria-labelledby is as mainstream a labelling mechanism
// as aria-label — design systems commonly label a control from a separate
// visible heading/legend element rather than duplicating the text into
// aria-label — but was read nowhere in the original C5 fix. Runs the REAL
// buildInteractiveIndex against fixtures that reproduce the adversarial
// review's exact repro (`<span id="lbl-1">Card number</span><input
// aria-labelledby="lbl-1">`).
describe('domIndex — sensitivity reads aria-labelledby (follow-up HIGH)', () => {
  it('flags a field labelled via aria-labelledby pointing at a separate element (the reported repro case)', () => {
    document.body.innerHTML = '<span id="lbl-1">Card number</span><input id="mui-1" aria-labelledby="lbl-1">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  // Neither half alone matches SENSITIVE_RE ("Social" and "Security" are
  // each innocuous on their own — only the two-word phrase "social
  // security" does) — this only passes if BOTH space-separated ids are
  // actually resolved and concatenated, not just the first one (the
  // multi-id bug this fix's own comment calls out in dialogTitleOf's
  // single-id handling, which this deliberately does NOT repeat).
  it('resolves multiple space-separated aria-labelledby ids and concatenates their text', () => {
    document.body.innerHTML =
      '<span id="a">Social</span><span id="b">Security</span><input id="mui-2" aria-labelledby="a b">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  it('does not false-positive on a benign aria-labelledby reference', () => {
    document.body.innerHTML = '<span id="lbl-2">First name</span><input id="mui-3" aria-labelledby="lbl-2">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(false)
  })
})

// (Follow-up MEDIUM — performance regression) labelAssociationTextOf used
// to re-run root.querySelectorAll('label') from scratch for EVERY indexed
// element with an id — O(inputs × labels), ~1.2s on a 200-input/2000-label
// form per the review. A wall-clock timing assertion would be flaky under
// CI load, so this measures the actual complexity property instead: before
// the fix, N labelled inputs meant exactly N querySelectorAll('label')
// calls; after the fix (a single querySelectorAll('*') pass per root,
// building an O(1)-lookup map), that count must be 0 — structurally, not
// just numerically smaller — and must not grow with N.
describe('domIndex — labelAssociationTextOf avoids O(inputs × labels) DOM scans (follow-up MEDIUM)', () => {
  for (const n of [5, 50]) {
    it(`makes zero querySelectorAll('label') calls for ${n} labelled inputs`, () => {
      const parts: string[] = []
      for (let i = 0; i < n; i++) parts.push(`<label for="f${i}">Field ${i}</label><input id="f${i}">`)
      document.body.innerHTML = parts.join('')
      // Uniform stub, not stubLayoutFor (which only makes ONE element
      // visible): every element reports the same valid rect, and
      // elementFromPoint always returns document.body — which .contains()
      // every input — so isVisible's topmost hit-test passes for all of
      // them regardless of which one is currently being tested.
      Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40, toJSON() {} } as DOMRect
      }
      document.elementFromPoint = () => document.body

      // Broadened per the follow-up review: a spy watching only the exact
      // string 'label' would be blind to an equivalent re-scan spelled
      // querySelectorAll('LABEL') (CSS tag selectors are case-insensitive —
      // confirmed to still trigger the O(N×M) blowup in jsdom) or one
      // rewritten as getElementsByTagName('label'). Neither happens in the
      // current implementation, so both assertions are 0 today, but this is
      // what stops a future edit from reintroducing the regression through
      // a spelling the original spy wouldn't have caught.
      const querySpy = vi.spyOn(document, 'querySelectorAll')
      const tagSpy = vi.spyOn(document, 'getElementsByTagName')
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      // Sanity check the stub actually worked — otherwise "zero label
      // calls" would be true only because nothing got indexed at all.
      expect((result.elements as unknown[]).length, 'expected all inputs to be indexed').toBe(n)

      const labelCalls = querySpy.mock.calls.filter(
        ([selector]) => typeof selector === 'string' && selector.toLowerCase() === 'label',
      )
      expect(
        labelCalls.length,
        'querySelectorAll("label"/"LABEL") must never be called — labelForMaps replaces it',
      ).toBe(0)
      const tagCalls = tagSpy.mock.calls.filter(([name]) => typeof name === 'string' && name.toLowerCase() === 'label')
      expect(tagCalls.length, 'getElementsByTagName("label") must never be called either').toBe(0)
      querySpy.mockRestore()
      tagSpy.mockRestore()
    })
  }
})

// (Follow-up MEDIUM — vocabulary) cvv/ccv already covered the Visa/generic
// terms for a card's security code, but not Mastercard's own "cvc"/"cvc2";
// SWIFT/BIC (international wire-transfer bank identifiers) had no
// alternative at all. Runs the REAL buildInteractiveIndex, not just the
// extracted regex, so this exercises the same raw+normalized dual test path
// C6 established (accountNum-style abbreviations need the normalized pass;
// bare ids like "cvc" match raw directly).
describe('domIndex — SENSITIVE_RE covers cvc/swift/bic (follow-up MEDIUM)', () => {
  it('flags the reported repro cases, including every swift/bic + code separator convention', () => {
    for (const id of [
      'cvc',
      'cvc2',
      'swiftCode',
      'swift_code',
      'swift-code',
      'bicCode',
      'bic_code',
      'bic-code',
    ]) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" to be sensitive`).toBe(true)
    }
  })

  it('flags bare swift/bic with no "code" suffix too', () => {
    for (const id of ['swift', 'bic']) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" to be sensitive`).toBe(true)
    }
  })

  // Guard against over-matching: bic/swift are short, real-word-adjacent
  // tokens (BIC is also a pen brand) — the trailing \b is what stops a
  // substring match inside an unrelated word that merely CONTAINS one.
  it('does not false-positive on words that merely contain cvc/swift/bic as a substring', () => {
    for (const id of ['bicycle', 'bicycleRack', 'swiftly']) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" NOT to be sensitive`).toBe(false)
    }
  })

  // Re-run the existing negative vocabulary — including the specific names
  // the adversarial review's own sweep called out (accountNumeric,
  // item_number, tracking_number) — to confirm this widening didn't
  // collide with anything already proven safe.
  it('does not false-positive on the existing negative vocabulary', () => {
    for (const id of [
      'username',
      'email',
      'search',
      'firstName',
      'address',
      'comment',
      'quantity',
      'account',
      'bankAccount',
      'city',
      'accept',
      'accessory',
      'accountNumeric',
      'item_number',
      'tracking_number',
    ]) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" NOT to be sensitive`).toBe(false)
    }
  })
})

// (Follow-up round 2, MEDIUM) The round-1 fix put swift/bic inside the
// SHARED SENSITIVE_RE, which is also tested against
// normalizeForSensitivity's camelCase-split output — and normalization
// exists specifically to manufacture a token boundary the raw string
// doesn't have. For an ordinary word/brand/framework name that happens to
// START with "swift"/"bic" (SwiftUI, a BIC pen), that manufactured boundary
// IS the false positive: "swiftUIPreview" normalizes to "swift UI Preview",
// which a bare \bswift\b then matches even though "swift" was never
// actually a standalone token in the real id. Confirmed live against the
// pre-fix regex: SENSITIVE_RE.test('swiftUIPreview') is false on the raw
// string and only becomes true after normalizeForSensitivity — this
// describe block is the regression test for that exact mechanism. The fix
// moves swift/bic into their own SWIFT_BIC_RAW_RE, tested ONLY against the
// raw nameId/labelText.
describe('domIndex — swift/bic do not collide with normalizeForSensitivity (follow-up round 2, MEDIUM)', () => {
  it('does not false-positive on real words/brands/frameworks that merely start with swift/bic', () => {
    for (const id of [
      'swiftUIPreview',
      'swiftUIDemo',
      'swiftSearch',
      'swiftAction',
      'swift_action',
      'bicPenColor',
      'bicLighterSku',
      'bicPen',
    ]) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" NOT to be sensitive`).toBe(false)
    }
  })

  // A second, independent sweep the reviewer specifically asked for —
  // ordinary words that happen to CONTAIN "bic"/"swift"/short fragments,
  // beyond the bicycle/bicycleRack/swiftly already covered above.
  it('does not false-positive on the extended negative sweep', () => {
    for (const id of ['basicAuth', 'arabicText', 'civicNumber', 'publicKey', 'topicName']) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" NOT to be sensitive`).toBe(false)
    }
  })

  // The fix must not have thrown out the baby with the bathwater — every
  // required-match case from the round-1 vocabulary test must still hold
  // once swift/bic move to their own regex path.
  it('still flags every required swift/bic match after moving to the raw-only path', () => {
    for (const id of ['swift', 'bic', 'swiftCode', 'swift_code', 'swift-code', 'bicCode', 'bic_code', 'bic-code']) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" to be sensitive`).toBe(true)
    }
  })
})

// (Follow-up round 3, MEDIUM) Round 2 moved swift/bic to a raw-only regex,
// but a bare \bswift\b/\bbic\b regex alternative has a SECOND collision
// independent of normalizeForSensitivity: "-" is a non-word character, so a
// leading/trailing \b is satisfied on BOTH sides of "swift" inside
// "swift-search" or "bic-pen" even though the field isn't swift/bic at all
// — it just has a hyphen next to that word. \b can tell "swift" apart from
// a word-CHARACTER neighbor (arabicText) but not a hyphen neighbor; no
// amount of regex-only cleverness fixes that on the raw string alone. The
// fix drops the bare regex alternatives entirely and replaces them with
// isBareSwiftOrBic — exact string equality (trim + lowercase) checked
// against each INDIVIDUAL source (name attr, id, aria-label, placeholder,
// accessible name, label[for] text, aria-labelledby text) rather than any
// concatenated string, so a field is only bare-flagged when one of its own
// sources IS "swift"/"bic", never when it merely contains that word next to
// other text.
describe('domIndex — bare swift/bic no longer leak through kebab-case neighbors (follow-up round 3, MEDIUM)', () => {
  it('does not false-positive on kebab-case names that merely contain swift/bic next to other words', () => {
    for (const id of ['swift-search', 'bic-pen', 'swift-nav', 'my-swift-thing']) {
      document.body.innerHTML = `<input id="${id}">`
      const input = document.querySelector('input') as HTMLElement
      stubLayoutFor(input)
      const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
      const result = buildInteractiveIndex('data-agent-idx', 200)
      const entry = (result.elements as Array<{ sensitive: boolean }>)[0]
      expect(entry?.sensitive, `expected id="${id}" NOT to be sensitive`).toBe(false)
    }
  })

  // Deliberate design choice, not a leftover gap: "bic-code-x" genuinely
  // contains a "bic-code" token (e.g. a variant/suffix of a real SWIFT/BIC
  // field), so the compound regex is meant to match it as a substring —
  // same reasoning as userSwiftCodeField matching elsewhere. This is the
  // opposite of the kebab-case cases above, which contain NO "code" token
  // at all.
  it('still flags "bic-code-x" — it genuinely contains a bic-code token (deliberate, not a false positive)', () => {
    document.body.innerHTML = '<input id="bic-code-x">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(true)
  })

  // Bare swift/bic must still work as a WHOLE identifier — this is what
  // isBareSwiftOrBic exists to preserve now that the regex alternative is
  // gone. Covers name attr, id attr, and a visible label as the SOLE
  // signal (a field whose id/name carries no clue at all, exactly the C5
  // shape from round 1).
  it('still flags a field that IS exactly swift/bic, from every individual source', () => {
    // name attribute (not id)
    document.body.innerHTML = '<input name="swift">'
    let input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    let buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    let result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive, 'name="swift"').toBe(true)

    // id attribute
    document.body.innerHTML = '<input id="bic">'
    input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive, 'id="bic"').toBe(true)

    // aria-label, exactly
    document.body.innerHTML = '<input id="field-1" aria-label="Swift">'
    input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive, 'aria-label="Swift"').toBe(true)

    // a visible <label> whose ONLY text is exactly "BIC" — the case the
    // reviewer named explicitly.
    document.body.innerHTML = '<label>BIC<input id="field-2"></label>'
    input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive, '<label>BIC</label>').toBe(true)

    // associated <label for>, exactly "BIC"
    document.body.innerHTML = '<label for="field-3">BIC</label><input id="field-3">'
    input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive, '<label for> BIC').toBe(true)
  })

  // A field whose label text merely CONTAINS "swift"/"bic" alongside other
  // words must not bare-match — only an exact whole-source match should.
  it('does not false-positive when a label source contains swift/bic alongside other words', () => {
    document.body.innerHTML = '<input id="field-4" aria-label="Swift delivery option">'
    const input = document.querySelector('input') as HTMLElement
    stubLayoutFor(input)
    const buildInteractiveIndex = extractInjected('buildInteractiveIndex')
    const result = buildInteractiveIndex('data-agent-idx', 200)
    expect((result.elements as Array<{ sensitive: boolean }>)[0]?.sensitive).toBe(false)
  })
})
