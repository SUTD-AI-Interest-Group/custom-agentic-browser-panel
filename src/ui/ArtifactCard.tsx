// An agent-created artifact in the transcript. The tool result carries only
// the artifactId (payloads never ride model history); the HTML is read from
// the lychee-artifacts store on mount and rendered by mounting the SEALED
// sandbox page (sandbox-exec.html) in render mode — same isolation as code
// execution: opaque origin, no network, scripts-only nested iframe.

import { useEffect, useRef, useState } from 'react'
import { getArtifact, type CodeArtifact } from '../data/artifacts'

const COLLAPSED_H = 360
const EXPANDED_H = 720

export function ArtifactCard({ artifactId, revision }: { artifactId: string; revision?: number }) {
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null)
  const [missing, setMissing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    let stale = false
    getArtifact(artifactId).then((a) => {
      if (stale) return
      if (a) setArtifact(a)
      else setMissing(true)
    })
    return () => {
      stale = true
    }
  }, [artifactId, revision])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      if (e.data && e.data.type === 'exec:ready') setFrameReady(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    if (!frameReady || !artifact) return
    frameRef.current?.contentWindow?.postMessage(
      { type: 'exec:render', requestId: crypto.randomUUID(), html: artifact.html },
      '*',
    )
  }, [frameReady, artifact])

  const download = () => {
    if (!artifact) return
    const url = URL.createObjectURL(new Blob([artifact.html], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${artifact.title.replace(/[^\w-]+/g, '-').toLowerCase() || 'artifact'}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (missing) return <div className="artifact-card artifact-missing">Artifact no longer stored.</div>

  return (
    <div className="artifact-card">
      <div className="artifact-head">
        <span className="artifact-title">{artifact?.title ?? '…'}</span>
        {artifact && artifact.revision > 1 && <span className="artifact-rev">v{artifact.revision}</span>}
        <button className="btn ghost small" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <button className="btn ghost small" onClick={download} disabled={!artifact}>
          Download
        </button>
      </div>
      <iframe
        ref={frameRef}
        title={artifact?.title ?? 'Artifact'}
        src={chrome.runtime.getURL('sandbox-exec.html')}
        style={{ height: expanded ? EXPANDED_H : COLLAPSED_H }}
      />
    </div>
  )
}
