import { useEffect, useState } from 'react'
import type { LinkRef } from './blocks'
import { getLinkPreview, type LinkPreview } from '../platform/linkPreview'
import { faviconUrl } from './Chat'

// A run of standalone links, each a card: favicon + domain + link text shown
// immediately, then upgraded with OpenGraph title/description/image if a
// client-side fetch resolves (see linkPreview.ts; gated by a privacy setting).

export default function LinkCardStack({ links }: { links: LinkRef[] }) {
  return (
    <div className="link-cards">
      {links.map((l, i) => (
        <LinkCard key={i} link={l} />
      ))}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function LinkCard({ link }: { link: LinkRef }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  const [imgOk, setImgOk] = useState(true)
  const host = hostOf(link.url)

  useEffect(() => {
    let live = true
    void getLinkPreview(link.url).then((p) => {
      if (live) setPreview(p)
    })
    return () => {
      live = false
    }
  }, [link.url])

  const title = preview?.title || link.text || host
  const showImage = imgOk && !!preview?.image

  return (
    <a className="link-card" href={link.url} target="_blank" rel="noreferrer">
      {showImage && (
        <span className="link-card-thumb">
          <img src={preview!.image} alt="" loading="lazy" onError={() => setImgOk(false)} />
        </span>
      )}
      <span className="link-card-body">
        <span className="link-card-site">
          <img className="link-card-favicon" src={faviconUrl(link.url)} alt="" />
          {preview?.siteName || host}
        </span>
        <span className="link-card-title">{title}</span>
        {preview?.description && <span className="link-card-desc">{preview.description}</span>}
      </span>
    </a>
  )
}
