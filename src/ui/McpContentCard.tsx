import { useEffect, useState } from 'react'
import { getMcpArtifact, type McpArtifact } from '../data/mcpArtifacts'
import { sanitizeMcpHtml } from './mcpHtmlSanitize'

/**
 * One rich payload an MCP tool returned, rendered for the user from IndexedDB.
 * The transcript (and the model's tool result) carries only the artifact id —
 * media data never rides model history (see src/mcp/content.ts).
 *
 * HTML artifacts here are STATIC: sanitized and inlined, no scripts, and no
 * tag/attribute that would auto-fetch a remote host on render (see
 * mcpHtmlSanitize.ts — this content has no sandbox or CSP of its own, unlike
 * CreateArtifact's HTML). Interactive MCP Apps are a different, deliberately
 * separate path (McpAppCard → the manifest-sandboxed page) because running
 * scripts takes a unique-origin sandbox, not a sanitizer.
 */
export default function McpContentCard({ artifactId }: { artifactId: string }) {
  const [artifact, setArtifact] = useState<McpArtifact | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let alive = true
    getMcpArtifact(artifactId)
      .then((a) => {
        if (!alive) return
        if (a) setArtifact(a)
        else setMissing(true)
      })
      .catch(() => alive && setMissing(true))
    return () => {
      alive = false
    }
  }, [artifactId])

  // Artifacts are pruned by age/size, so an old chat can outlive its media.
  if (missing) return <div className="shot-card-missing">This content is no longer stored.</div>
  if (!artifact) return null

  return (
    <figure className="mcp-content-card">
      <Body artifact={artifact} />
      <figcaption className="mcp-content-meta">
        <span className="mcp-content-title">{artifact.title}</span>
        <span className="mcp-content-source">
          {artifact.server} · {artifact.tool}
        </span>
        {artifact.dataUrl && (
          <a
            className="mcp-content-download"
            href={artifact.dataUrl}
            download={suggestFilename(artifact)}
          >
            Download
          </a>
        )}
      </figcaption>
    </figure>
  )
}

function Body({ artifact }: { artifact: McpArtifact }) {
  switch (artifact.kind) {
    case 'image':
      return <img className="mcp-content-media" src={artifact.dataUrl} alt={artifact.title} />
    case 'audio':
      return <audio className="mcp-content-audio" controls src={artifact.dataUrl} />
    case 'video':
      return <video className="mcp-content-media" controls src={artifact.dataUrl} />
    case 'html':
      return (
        <div
          className="mcp-content-html"
          // Static render only: scripts, event handlers, frames, and any
          // tag/attribute that would auto-fetch a remote host are stripped.
          dangerouslySetInnerHTML={{ __html: sanitizeMcpHtml(artifact.text ?? '') }}
        />
      )
    case 'text':
      return <pre className="mcp-content-text">{artifact.text}</pre>
    default:
      return (
        <div className="mcp-content-blob">
          <span className="mcp-badge">{artifact.mimeType}</span> attachment
        </div>
      )
  }
}

function suggestFilename(a: McpArtifact): string {
  const safe = a.title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'mcp-content'
  const ext = a.mimeType.split('/')[1]?.split(';')[0]
  return ext && !safe.endsWith(`.${ext}`) ? `${safe}.${ext}` : safe
}
