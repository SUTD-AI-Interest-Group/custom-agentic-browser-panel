// The Northwind Store catalog: 120 products. The first eight are the original spike products the
// store tasks target; the look-alikes after them make the tasks discriminating (a blue mug among
// three colours, two "Pulse" earbuds, four "Halo" products); the rest is deterministic filler for
// the dense catalog page. Filler names never contain a word any store task searches for.
window.CATALOG = [
  { id: 'p1', name: 'Sonic Air wireless headphones', price: 129, cat: 'headphones' },
  { id: 'p2', name: 'Studio Pro wired headphones', price: 49, cat: 'headphones' },
  { id: 'p3', name: 'Arc wireless headphones', price: 64, cat: 'headphones' },
  { id: 'p4', name: 'Nimbus wireless headphones', price: 95, cat: 'headphones' },
  { id: 'p5', name: 'Pulse wireless earbuds', price: 39, cat: 'earbuds' },
  { id: 'p6', name: 'Orbit wireless speaker', price: 59, cat: 'speakers' },
  { id: 'p7', name: 'Halo noise-cancelling wireless headphones', price: 189, cat: 'headphones' },
  { id: 'p8', name: 'Aurora mug (blue)', price: 12, cat: 'kitchen' },
  { id: 'p9', name: 'Aurora mug (green)', price: 12, cat: 'kitchen' },
  { id: 'p10', name: 'Aurora mug (white)', price: 11, cat: 'kitchen' },
  { id: 'p11', name: 'Pulse Pro wireless earbuds', price: 59, cat: 'earbuds' },
  { id: 'p12', name: 'Halo wireless earbuds', price: 79, cat: 'earbuds' },
  { id: 'p13', name: 'Halo noise-cancelling headphones (wired)', price: 99, cat: 'headphones' },
  { id: 'p14', name: 'Halo Mini wireless speaker', price: 45, cat: 'speakers' },
]
;(() => {
  const adjectives = ['Cedar', 'Linen', 'Slate', 'Maple', 'Copper', 'Willow', 'Granite', 'Fern', 'Amber', 'Birch', 'Coral', 'Juniper', 'Pebble', 'Sage', 'Indigo']
  // Long, shop-style names on purpose: they make the catalog page's registry (and the decider's
  // prompt) long enough to cross the spec's 2,500-token dense-page mark.
  const nouns = [
    'adjustable desk lamp with linen shade',
    'chunky knit throw blanket, 130 × 170 cm',
    'silent sweep wall clock, 30 cm',
    'glazed ceramic plant pot with saucer',
    'hardcover dotted notebook, A5, 192 pages',
    'oak picture frame for 8 × 10 prints',
    'woven seagrass storage basket with handles',
    'soy wax candle in a reusable tin',
  ]
  const cats = ['lighting', 'textiles', 'decor', 'garden', 'office', 'decor', 'storage', 'decor']
  let n = 15
  for (let i = 0; window.CATALOG.length < 120; i++) {
    const a = adjectives[i % adjectives.length]
    const k = Math.floor(i / adjectives.length) % nouns.length
    window.CATALOG.push({ id: 'p' + n++, name: `${a} ${nouns[k]}`, price: 8 + ((i * 37) % 90), cat: cats[k] })
  }
})()
window.cart = () => JSON.parse(localStorage.getItem('cart') || '[]')
window.__cart = window.cart()
function header() {
  return `<header><a href="index.html">Northwind Store</a>
  <form action="search.html" method="get" role="search"><input type="search" name="q" aria-label="Search products" placeholder="Search products"><button type="submit">Search</button></form>
  <a href="cart.html" id="cart-link">Cart (${window.cart().length})</a></header>`
}
// Re-renders the header's cart count; the product page calls it after an add so the header
// agrees with the page's own "Added to your cart" message instead of staying at "Cart (0)".
window.refreshCartCount = () => {
  const link = document.getElementById('cart-link')
  if (link) link.textContent = `Cart (${window.cart().length})`
}
document.addEventListener('DOMContentLoaded', () => document.body.insertAdjacentHTML('afterbegin', header()))
