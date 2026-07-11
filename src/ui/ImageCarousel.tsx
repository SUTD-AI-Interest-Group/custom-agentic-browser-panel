import { useState } from 'react'
import { downloadImage } from '../platform/download'

// Renders a run of image URLs (grouped by splitBlocks) as a full-width,
// horizontally side-scrollable carousel. Hovering a thumbnail tints it and
// reveals a download icon; clicking downloads that image via the system Save As
// dialog. Thumbnails that fail to load are dropped.

export default function ImageCarousel({ urls }: { urls: string[] }) {
  const [failed, setFailed] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState<number | null>(null)

  async function download(url: string, i: number) {
    setBusy(i)
    try {
      await downloadImage(url)
    } finally {
      setBusy(null)
    }
  }

  // If every image 404s there's nothing to show — collapse the whole carousel.
  if (urls.every((_, i) => failed.has(i))) return null

  return (
    <div className="img-carousel">
      {urls.map((url, i) =>
        failed.has(i) ? null : (
          <button
            key={i}
            type="button"
            className="img-carousel-item"
            aria-label="Download image"
            title="Download image"
            disabled={busy === i}
            onClick={() => void download(url, i)}
          >
            <img
              src={url}
              alt=""
              loading="lazy"
              onError={() => setFailed((prev) => new Set(prev).add(i))}
            />
            <span className="img-carousel-overlay" aria-hidden="true">
              <DownloadIcon />
            </span>
          </button>
        ),
      )}
    </div>
  )
}

function DownloadIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}
