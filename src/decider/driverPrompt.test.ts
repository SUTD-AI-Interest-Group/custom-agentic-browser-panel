import { describe, expect, it } from 'vitest'
import {
  driverUnavailableReason,
  isDriverMessage,
  MAX_DRIVER_VALUE_CHARS,
  MAX_DRIVER_VALUES,
  parseDriverPrompt,
  stripDriverToken,
  type DriverAvailability,
} from './driverPrompt'

describe('isDriverMessage', () => {
  it('matches @driver as a word, anywhere, in any case', () => {
    expect(isDriverMessage('@driver add the mug')).toBe(true)
    expect(isDriverMessage('please @driver add the mug')).toBe(true)
    expect(isDriverMessage('add the mug\n@Driver')).toBe(true)
    expect(isDriverMessage('@DRIVER, add it')).toBe(true)
  })
  it('does not match a longer word, an embedded token or a plain mention of drivers', () => {
    expect(isDriverMessage('@drivers add the mug')).toBe(false)
    expect(isDriverMessage('mail@driver.com add the mug')).toBe(false)
    expect(isDriverMessage('update my driver')).toBe(false)
    expect(isDriverMessage('')).toBe(false)
  })
})

describe('stripDriverToken (the model-facing copy)', () => {
  it('drops the token and one following space, keeping the rest as typed', () => {
    expect(stripDriverToken('@driver add the blue mug')).toBe('add the blue mug')
    expect(stripDriverToken('please @driver add it')).toBe('please add it')
    expect(stripDriverToken('add it @driver')).toBe('add it')
    expect(stripDriverToken('line one\n@driver line two')).toBe('line one\nline two')
  })
  it('leaves a message without the token alone', () => {
    expect(stripDriverToken('mail@driver.com')).toBe('mail@driver.com')
  })
})

describe('parseDriverPrompt', () => {
  it('goal: the token removed, whitespace collapsed, quotes kept', () => {
    expect(parseDriverPrompt('@driver  add the   blue\nAurora mug to my cart ').goal).toBe('add the blue Aurora mug to my cart')
    expect(parseDriverPrompt('@driver search "wireless headphones" and add the cheapest').goal).toBe(
      'search "wireless headphones" and add the cheapest',
    )
    expect(parseDriverPrompt('add it @driver please').goal).toBe('add it please')
  })

  it('no quotes → no values', () => {
    expect(parseDriverPrompt('@driver add the blue Aurora mug to my cart').values).toEqual({})
  })

  it('keys a value by the word right before its opening quote, lowercased to [a-z0-9_]', () => {
    expect(parseDriverPrompt('@driver search "wireless headphones" and add the cheapest').values).toEqual({ search: 'wireless headphones' })
    expect(parseDriverPrompt('@driver fill Email: "ada@example.com" and Subject_Line "Hi"').values).toEqual({
      email: 'ada@example.com',
      subject_line: 'Hi',
    })
    expect(parseDriverPrompt('@driver E-mail "x@y.z"').values).toEqual({ email: 'x@y.z' })
  })

  it('falls back to text, text_2, … when no word precedes the quote', () => {
    expect(parseDriverPrompt('@driver "first" "second"').values).toEqual({ text: 'first', text_2: 'second' })
    // Only the text since the previous quote counts: the first value never names the second.
    expect(parseDriverPrompt('@driver type "a" "b"').values).toEqual({ type: 'a', text: 'b' })
    expect(parseDriverPrompt('@driver add -- "x"').values).toEqual({ text: 'x' })
  })

  it('numbers duplicate keys _2, _3', () => {
    expect(parseDriverPrompt('@driver search "a" then search "b" then search "c"').values).toEqual({ search: 'a', search_2: 'b', search_3: 'c' })
  })

  it('reads curly quotes, and mixed pairs', () => {
    expect(parseDriverPrompt('@driver search “noise cancelling” then message "hi there”').values).toEqual({
      search: 'noise cancelling',
      message: 'hi there',
    })
  })

  it('skips empty (and blank) quotes, which take no key', () => {
    expect(parseDriverPrompt('@driver search "" then name "  " then city "London"').values).toEqual({ city: 'London' })
  })

  it('caps the count and the length', () => {
    const many = Array.from({ length: MAX_DRIVER_VALUES + 3 }, (_, i) => `v "${i}"`).join(' ')
    const values = parseDriverPrompt(`@driver ${many}`).values
    expect(Object.keys(values)).toHaveLength(MAX_DRIVER_VALUES)
    expect(values.v).toBe('0')
    expect(values[`v_${MAX_DRIVER_VALUES}`]).toBe(String(MAX_DRIVER_VALUES - 1))
    const long = 'x'.repeat(MAX_DRIVER_VALUE_CHARS + 50)
    expect(parseDriverPrompt(`@driver note "${long}"`).values.note).toHaveLength(MAX_DRIVER_VALUE_CHARS)
  })

  it('an unclosed quote is not a value', () => {
    expect(parseDriverPrompt('@driver search "wireless').values).toEqual({})
  })
})

describe('driverUnavailableReason', () => {
  const ok: DriverAvailability = { mode: 'shadow', modelReady: true, requestPolicy: 'ask', controlPolicy: 'ask', fastStepsPolicy: 'ask' }
  it('null when the model is on (any non-off mode) and ready and page control is allowed', () => {
    for (const mode of ['shadow', 'assist', 'driver']) expect(driverUnavailableReason({ ...ok, mode })).toBeNull()
  })
  it('Off (or never set) still means off', () => {
    expect(driverUnavailableReason({ ...ok, mode: 'off' })).toMatch(/Turn the decision model on/)
    expect(driverUnavailableReason({ ...ok, mode: undefined })).toMatch(/Turn the decision model on/)
  })
  it('a model that is not imported', () => {
    expect(driverUnavailableReason({ ...ok, modelReady: false })).toBe("The decision model isn't imported — Settings → Experimental.")
  })
  it('a page-control tool set to Never', () => {
    expect(driverUnavailableReason({ ...ok, requestPolicy: 'never' })).toMatch(/Never/)
    expect(driverUnavailableReason({ ...ok, controlPolicy: 'never' })).toMatch(/Never/)
    expect(driverUnavailableReason({ ...ok, fastStepsPolicy: 'never' })).toMatch(/Never/)
  })
})
