// The store fixture's cart header: node --test scripts/decider-eval/cart.test.mjs
// catalog.js renders the header once at load; the product page must refresh the count after an
// add, or the page shows "Added to your cart" beside "Cart (0)" and a model rightly doubts it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const DIR = new URL('./fixtures/store/', import.meta.url)

test('refreshCartCount re-renders the header link from localStorage', () => {
  const store = {}
  const link = { textContent: 'Cart (0)' }
  const window = {}
  const ctx = {
    window,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v) },
    document: { addEventListener() {}, getElementById: (id) => (id === 'cart-link' ? link : null) },
  }
  vm.runInNewContext(readFileSync(new URL('catalog.js', DIR), 'utf8'), ctx)
  assert.equal(typeof window.refreshCartCount, 'function')
  store.cart = JSON.stringify(['Pulse wireless earbuds', 'Pulse wireless earbuds'])
  window.refreshCartCount()
  assert.equal(link.textContent, 'Cart (2)')
})

test('the header link is addressable, and the product page refreshes it after an add', () => {
  assert.match(readFileSync(new URL('catalog.js', DIR), 'utf8'), /<a href="cart.html" id="cart-link">Cart \(/)
  const product = readFileSync(new URL('product.html', DIR), 'utf8')
  assert.ok(product.indexOf('window.refreshCartCount()') > product.indexOf("localStorage.setItem('cart'"))
})
