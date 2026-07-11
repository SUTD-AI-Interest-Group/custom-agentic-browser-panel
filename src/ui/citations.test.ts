import { test, expect } from 'vitest'
import {
  encodeCitations,
  replaceCitationSentinels,
  citationsToPlain,
  escapeAttr,
  CITE_OPEN,
  CITE_CLOSE,
} from './citations'

test('encodeCitations swaps [[n]] for private-use sentinels, leaving literal [n] alone', () => {
  const out = encodeCitations('A fact [[1]] and a quote "[2]" and cluster [[1]][[2]].')
  expect(out).toBe(`A fact ${CITE_OPEN}1${CITE_CLOSE} and a quote "[2]" and cluster ${CITE_OPEN}1${CITE_CLOSE}${CITE_OPEN}2${CITE_CLOSE}.`)
})

test('replaceCitationSentinels renders each n and handles adjacent clusters', () => {
  const encoded = encodeCitations('x [[1]][[2]] y')
  const out = replaceCitationSentinels(encoded, (n) => `<c>${n}</c>`)
  expect(out).toBe('x <c>1</c><c>2</c> y')
})

test('replaceCitationSentinels only fires on sentinels, not raw brackets', () => {
  const out = replaceCitationSentinels('plain [[1]] text', () => 'X')
  expect(out).toBe('plain [[1]] text') // not encoded → untouched
})

test('citationsToPlain degrades [[n]] to [n] for copy/fallback', () => {
  expect(citationsToPlain('a [[1]] b [[23]] c')).toBe('a [1] b [23] c')
})

test('escapeAttr neutralizes quote/angle/amp', () => {
  expect(escapeAttr('a"b<c>&d')).toBe('a&quot;b&lt;c&gt;&amp;d')
})
