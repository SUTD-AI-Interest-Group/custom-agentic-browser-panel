import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

// jsdom does not implement scrollIntoView at all (not even as a no-op); both
// injType and injSelect call it before acting. Real Chrome has it, so this is
// a test-harness gap, not something either function should guard against.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// injType/injSelect are injected via chrome.scripting.executeScript — fully
// self-contained (no module imports/closures), so they cannot be imported
// directly for testing. Extracting the literal function body straight out of
// the real source (rather than retyping it here) is what keeps this test
// honest: it exercises whatever injType/injSelect actually say TODAY.
//
// esbuild strips the TypeScript syntax (param types, `as` casts) so the
// extracted body can be evaluated as plain JS. esbuild's own JS API can't run
// in-process here — vitest's jsdom environment installs a TextEncoder whose
// Uint8Array fails esbuild's own realm-identity check ("new TextEncoder()
// .encode('') instanceof Uint8Array" is false) — so this shells out to
// esbuild's CLI binary instead, which runs in a clean, separate Node process.
const HERE = fileURLToPath(import.meta.url)
const SRC_PATH = join(dirname(HERE), 'pageActions.ts')
const source = readFileSync(SRC_PATH, 'utf-8')

const require = createRequire(import.meta.url)
const esbuildBin = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild')

function extractFunctionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`could not find function ${name} in pageActions.ts`)
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
  if (end < 0) throw new Error(`could not brace-match function ${name} in pageActions.ts`)
  return source.slice(start, end)
}

/** Extract, strip TS, and return a callable bound to this test's own jsdom globals. */
function extractInjected(name: string): (...args: any[]) => any {
  const raw = extractFunctionSource(name)
  const code = execFileSync(esbuildBin, ['--loader=ts', '--target=es2022'], { input: raw, encoding: 'utf-8' })
  // eslint-disable-next-line no-new-func -- executing the real, extracted+stripped source, not hand-written logic
  return new Function(`"use strict"; return (${code})`)()
}

describe('injType — clean failure on the wrong control type (F7)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  // MEDIUM (d04 F7): WebIDL accessor branding throws "Illegal invocation" when
  // the native `value` setter obtained from HTMLInputElement.prototype is
  // called with `this` bound to an unrelated element (e.g. a <select>) — the
  // model saw an opaque thrown error instead of a clean, actionable message.
  it('returns a clean {ok:false} instead of throwing when called on a <select>', () => {
    document.body.innerHTML = '<select data-agent-idx="0"><option value="a">A</option></select>'
    const injType = extractInjected('injType')
    const result = injType('data-agent-idx', 0, 'hello', true)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/select/i)
  })

  it('still types into a real <input>, unaffected by the guard', () => {
    document.body.innerHTML = '<input data-agent-idx="0" value="">'
    const injType = extractInjected('injType')
    const result = injType('data-agent-idx', 0, 'hello', true)
    expect(result.ok).toBe(true)
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('hello')
  })

  it('still types into a <textarea>, unaffected by the guard', () => {
    document.body.innerHTML = '<textarea data-agent-idx="0"></textarea>'
    const injType = extractInjected('injType')
    const result = injType('data-agent-idx', 0, 'hello', true)
    expect(result.ok).toBe(true)
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello')
  })

  it('still types into a contenteditable element, unaffected by the guard', () => {
    // jsdom does not compute isContentEditable from the attribute at all (it
    // reads back `undefined`, never `true`) — force it, the way a real
    // browser's rendering engine would, so this exercises injType's own
    // isContentEditable branch rather than a jsdom gap.
    document.body.innerHTML = '<div data-agent-idx="0" contenteditable="true"></div>'
    const el = document.querySelector('div') as HTMLElement
    Object.defineProperty(el, 'isContentEditable', { value: true })
    const injType = extractInjected('injType')
    const result = injType('data-agent-idx', 0, 'hello', true)
    expect(result.ok).toBe(true)
  })

  it('reports the element missing the same way as before, unaffected by the guard', () => {
    document.body.innerHTML = ''
    const injType = extractInjected('injType')
    const result = injType('data-agent-idx', 0, 'hello', true)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no longer on the page/)
  })
})

describe('injSelect — clean failure on the wrong control type (F7)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns a clean {ok:false} instead of throwing when called on an <input>', () => {
    document.body.innerHTML = '<input data-agent-idx="0" value="">'
    const injSelect = extractInjected('injSelect')
    const result = injSelect('data-agent-idx', 0, 'a')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/select|input/i)
  })

  it('still selects a real <select> option by value, unaffected by the guard', () => {
    document.body.innerHTML =
      '<select data-agent-idx="0"><option value="a">A</option><option value="b">B</option></select>'
    const injSelect = extractInjected('injSelect')
    const result = injSelect('data-agent-idx', 0, 'b')
    expect(result.ok).toBe(true)
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('b')
  })
})

describe('open shadow root actions', () => {
  afterEach(() => { document.body.innerHTML = '' })
  function nested(html: string) {
    const host = document.body.appendChild(document.createElement('div'))
    const first = host.attachShadow({ mode: 'open' })
    const inner = first.appendChild(document.createElement('div'))
    const root = inner.attachShadow({ mode: 'open' })
    root.innerHTML = html
    return { host, root }
  }

  it('clicks a nested shadow button exactly once and scrolls it into view', () => {
    const { root } = nested('<button data-agent-idx="7">Save</button>')
    const button = root.querySelector('button')!
    let clicks = 0
    let scrolls = 0
    button.addEventListener('click', () => clicks++)
    button.scrollIntoView = () => { scrolls++ }
    expect(extractInjected('injClick')('data-agent-idx', 7).ok).toBe(true)
    expect(clicks).toBe(1)
    expect(scrolls).toBe(1)
    expect(extractInjected('injScroll')('data-agent-idx', 'toElement', 7).ok).toBe(true)
    expect(scrolls).toBe(2)
  })

  it('types, appends and restores a field with native setters and composed input events', () => {
    const { root, host } = nested('<input data-agent-idx="8" value="old">')
    const input = root.querySelector('input')!
    let events = 0
    host.addEventListener('input', () => events++)
    const type = extractInjected('injType')
    expect(type('data-agent-idx', 8, 'new', true).prior).toBe('old')
    expect(input.value).toBe('new')
    expect(type('data-agent-idx', 8, '!', false).prior).toBe('new')
    expect(input.value).toBe('new!')
    type('data-agent-idx', 8, 'old', true)
    expect(input.value).toBe('old')
    expect(events).toBe(3)
  })

  it('selects a nested option and preserves the previous value for undo', () => {
    const { root } = nested('<select data-agent-idx="9"><option value="a">A</option><option value="b">B</option></select>')
    const select = root.querySelector('select')!
    let changes = 0
    select.addEventListener('change', () => changes++)
    expect(extractInjected('injSelect')('data-agent-idx', 9, 'B')).toMatchObject({ ok: true, prior: 'a' })
    expect(select.value).toBe('b')
    expect(changes).toBe(1)
  })

  it('does not resolve detached or closed shadow controls', () => {
    const { host } = nested('<button data-agent-idx="7">Save</button>')
    host.remove()
    const closed = document.body.appendChild(document.createElement('div')).attachShadow({ mode: 'closed' })
    closed.innerHTML = '<button data-agent-idx="7">Save</button>'
    for (const [name, args] of [
      ['injClick', ['data-agent-idx', 7]],
      ['injType', ['data-agent-idx', 7, 'x', true]],
      ['injSelect', ['data-agent-idx', 7, 'x']],
      ['injScroll', ['data-agent-idx', 'toElement', 7]],
    ] as const) expect(extractInjected(name)(...args).ok).toBe(false)
  })

  it('sends keys to the deepest focused field and respects prevented submission', () => {
    const { root, host } = nested('<form><input data-agent-idx="8"></form>')
    const input = root.querySelector('input')!
    input.focus()
    let keys = 0
    let hostKeys = 0
    input.addEventListener('keydown', event => { keys++; event.preventDefault() })
    host.addEventListener('keydown', () => hostKeys++)
    const result = extractInjected('injPress')('Enter')
    expect(result.message).toBe('pressed Enter')
    expect(keys).toBe(1)
    expect(hostKeys).toBe(1)
  })
})
