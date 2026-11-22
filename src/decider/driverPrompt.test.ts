import { describe, expect, it } from 'vitest'
import {
  driverModelText,
  driverSpecFor,
  driverUnavailableReason,
  frameGoal,
  goalPhrases,
  MAX_DRIVER_PHRASES,
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

  it('no quotes → the goal\'s candidate phrases instead (goalPhrases)', () => {
    expect(parseDriverPrompt('@driver add the blue Aurora mug to my cart').values).toEqual({ phrase: 'blue Aurora mug' })
  })

  it('goal phrases in use → the decider is told a plan: search for the FIRST phrase, then the user\'s goal (which stays as typed)', () => {
    expect(parseDriverPrompt('@driver add the blue Aurora mug to my cart')).toEqual({
      goal: 'add the blue Aurora mug to my cart',
      values: { phrase: 'blue Aurora mug' },
      deciderGoal: 'search for "blue Aurora mug", then add the blue Aurora mug to my cart',
    })
    const many = parseDriverPrompt('@driver search wireless headphones and add the cheapest under $100 to my cart')
    expect(many.goal).toBe('search wireless headphones and add the cheapest under $100 to my cart')
    expect(many.deciderGoal).toBe('search for "wireless headphones", then search wireless headphones and add the cheapest under $100 to my cart')
  })

  it('no framing with quoted values, nor when there is no phrase to search for', () => {
    expect(parseDriverPrompt('@driver search "wireless headphones" and add the cheapest to my cart')).not.toHaveProperty('deciderGoal')
    expect(parseDriverPrompt('@driver add it to the cart')).toEqual({ goal: 'add it to the cart', values: {} })
  })

  it('frameGoal', () => {
    expect(frameGoal('add the mug to my cart', 'mug')).toBe('search for "mug", then add the mug to my cart')
  })

  it('a quoted value means no phrases at all', () => {
    expect(parseDriverPrompt('@driver search "wireless headphones" and add the cheapest to my cart').values).toEqual({ search: 'wireless headphones' })
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

  it('an unclosed quote is not a value (the text is offered as a phrase instead)', () => {
    expect(parseDriverPrompt('@driver search "wireless').values).toEqual({ phrase: 'wireless' })
  })
})

describe('goalPhrases (unquoted text, offered for a search box)', () => {
  it('the thing to find, without verb, determiner or the cart', () => {
    expect(goalPhrases('add the blue Aurora mug to my cart')).toEqual({ phrase: 'blue Aurora mug' })
    expect(goalPhrases('add the Halo noise-cancelling wireless headphones to my cart')).toEqual({ phrase: 'Halo noise-cancelling wireless headphones' })
  })
  it('splits on connector words and keeps every chunk that names something, in order', () => {
    const p = goalPhrases('search wireless headphones and add the cheapest under $100 to my cart')
    expect(Object.values(p)).toContain('wireless headphones')
    expect(p).toEqual({ phrase: 'wireless headphones', phrase_2: 'cheapest', phrase_3: '$100' })
    expect(goalPhrases('find a hotel in Paris for 2 nights')).toEqual({ phrase: 'hotel', phrase_2: 'Paris', phrase_3: '2 nights' })
  })
  it('"of" is not a connector', () => {
    expect(goalPhrases('order a pair of running socks')).toEqual({ phrase: 'pair of running socks' })
  })
  it('strips several leading verbs and determiners, case-insensitively, but not inside the phrase', () => {
    expect(goalPhrases('Go find me THE Orbit speaker')).toEqual({ phrase: 'Orbit speaker' })
    expect(goalPhrases('pick the one that you like')).toEqual({ phrase: 'one that you like' })
  })
  it('drops empty, stopword-only and cart/checkout/basket chunks', () => {
    expect(goalPhrases('add it to the cart')).toEqual({})
    expect(goalPhrases('go to checkout')).toEqual({})
    expect(goalPhrases('put the mug in my shopping basket')).toEqual({ phrase: 'mug' })
    expect(goalPhrases('click on it, then go')).toEqual({})
  })
  it('splits on sentence punctuation but not inside a price, and trims quotes and brackets', () => {
    expect(goalPhrases('buy the $12.99 mug. then checkout')).toEqual({ phrase: '$12.99 mug' })
    expect(goalPhrases('find (Aurora mug), and stop')).toEqual({ phrase: 'Aurora mug', phrase_2: 'stop' })
  })
  it('dedupes case-insensitively and caps the count', () => {
    expect(goalPhrases('find mugs and MUGS with Mugs')).toEqual({ phrase: 'mugs' })
    const p = goalPhrases('red and green and blue and white and black')
    expect(Object.keys(p)).toHaveLength(MAX_DRIVER_PHRASES)
    expect(p).toEqual({ phrase: 'red', phrase_2: 'green', phrase_3: 'blue', phrase_4: 'white' })
  })
})

describe('driverSpecFor (a composed message: tab mentions are not the token)', () => {
  it('a tab titled "Driver Booster…" mentioned as @Driver Booster is an ordinary message', () => {
    expect(driverSpecFor('@Driver Booster Pro what is this?', ['@Driver Booster Pro'])).toBeUndefined()
    expect(driverSpecFor('summarize @Driver Booster Pro', ['@Driver Booster Pro'])).toBeUndefined()
    // Without knowing it is a mention, the same text would read as @driver.
    expect(driverSpecFor('@Driver Booster Pro what is this?')).toBeDefined()
  })
  it('an explicit @driver beside such a mention is a driver message; the goal leaves the mention out', () => {
    expect(driverSpecFor('@driver open @Driver Booster Pro downloads', ['@Driver Booster Pro'])).toEqual({
      goal: 'open downloads',
      values: { phrase: 'downloads' },
      deciderGoal: 'search for "downloads", then open downloads',
    })
  })
  it('the model-facing copy is the text the goal came from, so the scripted run finds its turn', () => {
    const text = '@driver open @Driver Booster Pro downloads'
    const tokens = ['@Driver Booster Pro']
    expect(driverModelText(text, tokens).replace(/\s+/g, ' ')).toBe(driverSpecFor(text, tokens)!.goal)
    expect(driverModelText('@driver add the mug')).toBe('add the mug')
  })
  it('a longer token is removed whole before a shorter one inside it', () => {
    expect(driverSpecFor('@Driver Booster Pro and @Driver Booster', ['@Driver Booster', '@Driver Booster Pro'])).toBeUndefined()
    // Shorter first would leave " Max" of "@Driver Max" behind in the goal.
    expect(driverSpecFor('@driver open @Driver Max', ['@Driver', '@Driver Max'])?.goal).toBe('open')
  })
  it('never with a leading /skill', () => {
    expect(driverSpecFor('/summarize @driver add it')).toBeUndefined()
    expect(driverSpecFor('@driver add it')).toBeDefined()
  })
})

describe('the parser on hyphens and inch marks', () => {
  it('a hyphenated word is not split at a connector inside it', () => {
    expect(goalPhrases('add the in-ear headphones to my cart')).toEqual({ phrase: 'in-ear headphones' })
    expect(goalPhrases('find a step-by-step guide')).toEqual({ phrase: 'step-by-step guide' })
    expect(goalPhrases('find a carry-on bag for the trip')).toEqual({ phrase: 'carry-on bag', phrase_2: 'trip' })
  })
  it('a quote right after a digit is an inch mark, not a quote', () => {
    expect(parseDriverPrompt('@driver compare the 15" laptop and the 13" tablet').values).not.toHaveProperty('text')
    // ("compare" is not one of the stripped verbs.)
    expect(parseDriverPrompt('@driver compare the 15" laptop and the 13" tablet').values).toEqual({ phrase: 'compare the 15" laptop', phrase_2: '13" tablet' })
    // A real quote after one still counts.
    expect(parseDriverPrompt('@driver buy the 15" laptop, search "sleeve"').values).toEqual({ search: 'sleeve' })
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
