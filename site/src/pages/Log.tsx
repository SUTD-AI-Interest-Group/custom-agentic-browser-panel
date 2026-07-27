import { sections, logIntro, articles } from '../lib/content'
import { useReveal } from '../App'

/**
 * The engineering-log index. Deliberately a *reading* page, not a card grid:
 * the wiki's own sidebar grouping is the structure, and each entry gets a real
 * excerpt so the list is scannable as prose.
 */
export default function Log() {
  const ref = useReveal()

  return (
    <div ref={ref as React.RefObject<HTMLDivElement>} className="doc-page">
      <header className="shell doc-head">
        <p className="eyebrow eyebrow--ink">ENGINEERING LOG</p>
        <h1>How this was actually built.</h1>
        <p className="doc-head__lead">
          {logIntro?.excerpt ??
            'What we set out to build, how each feature was built, what broke, and why the code looks the way it does.'}
        </p>
        <p className="doc-head__meta">
          {articles.length - 1} entries · written against the commit history, not from memory
        </p>
      </header>

      <div className="shell log">
        {sections.map((section) => (
          <section className="log__section" key={section.heading}>
            <h2 className="log__heading">{section.heading}</h2>
            <ul className="log__list">
              {section.articles.map((a) => (
                <li key={a.slug}>
                  <a className="log__item" href={`#/log/${a.slug}`}>
                    <span className="log__item-title">{a.title}</span>
                    <span className="log__item-excerpt">{a.excerpt}</span>
                    <span className="log__item-meta">{a.minutes} min read</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
