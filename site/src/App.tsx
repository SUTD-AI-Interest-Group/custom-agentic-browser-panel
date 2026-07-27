import { useEffect, useRef, useState } from 'react'
import { useRoute } from './lib/router'
import Home from './pages/Home'
import Log from './pages/Log'
import Post from './pages/Post'
import Privacy from './pages/Privacy'

export const REPO = 'https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel'

/**
 * The Chrome Web Store listing does not exist yet. Everything CTA-shaped reads
 * this one constant: while it is null the buttons render their pre-launch
 * state, and at launch a single URL here turns the whole site live. No layout
 * changes, nothing else to remember.
 */
export const STORE_URL: string | null = null

export function Cta({
  variant = 'primary',
  size,
}: {
  variant?: 'primary' | 'invert'
  size?: 'sm'
}) {
  const cls = `btn btn--${variant}${size === 'sm' ? ' btn--sm' : ''}`
  if (!STORE_URL) {
    return (
      <a className={cls} href={`${REPO}#install`} target="_blank" rel="noopener noreferrer">
        Get it on GitHub
      </a>
    )
  }
  return (
    <a className={cls} href={STORE_URL} target="_blank" rel="noopener noreferrer">
      Add to Chrome
    </a>
  )
}

function Nav() {
  return (
    <nav className="nav" aria-label="Primary">
      <a className="nav__mark" href="#/">
        <span className="nav__dot" aria-hidden="true" />
        Lychee AI
      </a>
      <div className="nav__links">
        <a href="#/#how">How it works</a>
        <a href="#/#privacy-band">Privacy</a>
        <a href="#/log">Engineering log</a>
        <a href={REPO} target="_blank" rel="noopener noreferrer">
          Open source
        </a>
      </div>
      <Cta size="sm" />
    </nav>
  )
}

/**
 * Exported because the homepage nests it inside the closing CTA section — the
 * two are both black and read as one final frame there. Every other route
 * still renders it standalone below `<main>`, so the markup lives in one place.
 */
export function Footer() {
  return (
    <footer className="footer">
      <div className="shell">
        <h2 className="footer__statement">Private. Permissioned. Powerful.</h2>
        <div className="footer__bar">
          <a className="nav__mark" href="#/">
            <span className="nav__dot" aria-hidden="true" />
            Lychee AI
          </a>
          <div className="footer__links">
            <a href={REPO} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <a href="#/log">Engineering log</a>
            <a href="#/privacy">Privacy</a>
            <a href={`${REPO}/issues`} target="_blank" rel="noopener noreferrer">
              Issues
            </a>
          </div>
          <span className="footer__colophon">SUTD AI Interest Group · MIT</span>
        </div>
      </div>
    </footer>
  )
}

/** Adds `.is-in` as each element scrolls into view; no-ops under reduced motion. */
export function useReveal() {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const targets = root.querySelectorAll<HTMLElement>('.reveal')
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      targets.forEach((el) => el.classList.add('is-in'))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in')
            io.unobserve(e.target)
          }
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    )
    targets.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])
  return ref
}

/** Sets the document title per route — the tab is part of the navigation. */
function useTitle(title: string) {
  useEffect(() => {
    document.title = title
  }, [title])
}

export default function App() {
  const route = useRoute()
  const [ready, setReady] = useState(false)

  useEffect(() => setReady(true), [])

  let page = <Home />
  let title = "Lychee AI — an AI agent in Chrome's side panel"

  if (route.name === 'log') {
    page = <Log />
    title = 'Engineering log — Lychee AI'
  } else if (route.name === 'post') {
    page = <Post slug={route.slug} />
    title = 'Engineering log — Lychee AI'
  } else if (route.name === 'privacy') {
    page = <Privacy />
    title = 'Privacy policy — Lychee AI'
  }

  useTitle(title)

  return (
    <>
      <Nav />
      <main key={route.name === 'post' ? route.slug : route.name} data-ready={ready}>
        {page}
      </main>
      {/* The homepage renders its own footer inside the closing CTA section. */}
      {route.name !== 'home' && <Footer />}
    </>
  )
}
