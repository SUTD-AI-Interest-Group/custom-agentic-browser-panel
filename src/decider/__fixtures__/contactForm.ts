import type { IndexedElement } from '../../platform/domIndex'

const rect = { x: 0, y: 0, width: 100, height: 20 }
const el = (index: number, tag: string, name: string, extra: Partial<IndexedElement> = {}): IndexedElement => ({
  index,
  tag,
  name,
  rect,
  sensitive: false,
  ...extra,
})

/** Recorded contact-form registry (checkbox lines rewritten to the `(unchecked)` format). */
export const CONTACT_FORM: IndexedElement[] = [
  el(0, 'a', 'Home'),
  el(1, 'a', 'FAQ'),
  el(2, 'a', 'Service status'),
  el(3, 'input', 'Full name'),
  el(4, 'input', 'Email address', { type: 'email' }),
  el(5, 'input', 'Phone number'),
  el(6, 'select', 'Topic', { type: 'select-one' }),
  el(7, 'textarea', 'How can we help?', { type: 'textarea' }),
  el(8, 'input', 'I agree to be contacted about my request', { type: 'checkbox', checked: false }),
  el(9, 'input', 'Send me the monthly newsletter', { type: 'checkbox', checked: false }),
  el(10, 'button', 'Send message', { type: 'submit' }),
  el(11, 'button', 'Clear form', { type: 'reset' }),
]
