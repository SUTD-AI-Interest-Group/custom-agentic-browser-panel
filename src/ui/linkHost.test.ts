import { describe, it, expect } from 'vitest'
import { hostOfLink } from './linkHost'

describe('hostOfLink', () => {
  it('returns the bare hostname', () => {
    expect(hostOfLink('https://example.com/page?x=1')).toBe('example.com')
  })

  it('strips a leading www.', () => {
    expect(hostOfLink('https://www.example.com/page')).toBe('example.com')
  })

  it('does not strip "www" from a subdomain that merely contains it, only a literal leading www.', () => {
    expect(hostOfLink('https://wwwexample.com')).toBe('wwwexample.com')
  })

  it('drops the port — hostname, not host', () => {
    expect(hostOfLink('https://example.com:8443/page')).toBe('example.com')
  })

  it('falls back to the original string verbatim when it is not a parseable URL', () => {
    expect(hostOfLink('not a url')).toBe('not a url')
  })
})
