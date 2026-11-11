import { useEffect, useState } from 'react'

/**
 * A ~30-line hash router instead of a routing dependency.
 *
 * Hash routing specifically: this deploys to GitHub Pages, which serves static
 * files and has no rewrite rule, so a deep path like /log/Page-Control would
 * 404 on a hard refresh under a history router. `#/log/Page-Control` always
 * resolves to index.html and lets the app do the rest.
 */
export type Route =
  | { name: 'home' }
  | { name: 'log' }
  | { name: 'post'; slug: string }
  | { name: 'privacy' }

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').replace(/\/$/, '')
  if (path === '' || path === 'home') return { name: 'home' }
  if (path === 'log') return { name: 'log' }
  if (path === 'privacy') return { name: 'privacy' }
  const post = path.match(/^log\/(.+)$/)
  if (post) {
    try { return { name: 'post', slug: decodeURIComponent(post[1]) } }
    catch { return { name: 'log' } }
  }
  return { name: 'home' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    let frame = 0
    const onChange = () => {
      setRoute(parseHash(window.location.hash))
      cancelAnimationFrame(frame)
      // Wait for the destination to mount before resolving its section anchor.
      frame = requestAnimationFrame(() => {
        const anchor = window.location.hash.match(/^#\/#([\w-]+)$/)?.[1]
        const section = anchor ? document.getElementById(anchor) : null
        if (section) section.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
        else window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      })
    }
    onChange()
    window.addEventListener('hashchange', onChange)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('hashchange', onChange) }
  }, [])

  return route
}
