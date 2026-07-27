import { useEffect } from 'react'
import { getArticle, render, bodyWithoutTitle, articles } from '../lib/content'
import { ArrowLeft } from '../components/icons'

export default function Post({ slug }: { slug: string }) {
  const article = getArticle(slug)

  useEffect(() => {
    if (article) document.title = `${article.title} — Lychee AI`
  }, [article])

  if (!article) {
    return (
      <div className="shell doc-head">
        <h1>Not found.</h1>
        <p className="doc-head__lead">
          There's no log entry at <code>{slug}</code>.
        </p>
        <p style={{ marginTop: 'var(--space-md)' }}>
          <a className="doc-back" href="#/log">
            <ArrowLeft /> All {articles.length - 1} entries
          </a>
        </p>
      </div>
    )
  }

  return (
    <article className="doc-page">
      <header className="shell doc-head">
        <a className="doc-back" href="#/log">
          <ArrowLeft /> Engineering log
        </a>
        <h1>{article.title}</h1>
        <p className="doc-head__meta">{article.minutes} min read</p>
      </header>
      <div
        className="shell prose"
        dangerouslySetInnerHTML={{ __html: render(bodyWithoutTitle(article.body)) }}
      />
    </article>
  )
}
