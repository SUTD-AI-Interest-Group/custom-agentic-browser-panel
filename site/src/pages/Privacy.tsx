import { privacy, render, bodyWithoutTitle } from '../lib/content'

/**
 * Rendered from the repo's own PRIVACY.md, synced by scripts/sync-content.mjs.
 * The Chrome Web Store listing points at the same source, so the page a
 * reviewer reads and the page a user reads can never drift apart.
 */
export default function Privacy() {
  return (
    <article className="doc-page">
      <header className="shell doc-head">
        <p className="eyebrow eyebrow--ink">PRIVACY</p>
        <h1>{privacy.title.replace(/^Privacy Policy for\s+/i, 'Privacy policy — ')}</h1>
        <p className="doc-head__lead">
          There is no Lychee server. Everything below describes what stays on your machine and what, at your
          instruction, leaves it.
        </p>
      </header>
      <div className="shell prose" dangerouslySetInnerHTML={{ __html: render(bodyWithoutTitle(privacy.body)) }} />
    </article>
  )
}
