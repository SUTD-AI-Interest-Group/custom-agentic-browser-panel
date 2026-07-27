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
  if (post) return { name: 'post', slug: decodeURIComponent(post[1]) }
  return { name: 'home' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash))
      // A hash change is a navigation, not an anchor jump — start at the top,
      // unless the user asked for reduced motion mid-flight.
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}
