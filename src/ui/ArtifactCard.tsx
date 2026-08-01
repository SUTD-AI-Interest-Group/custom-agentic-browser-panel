// An agent-created artifact in the transcript. The tool result carries only
// the artifactId (payloads never ride model history); the HTML is read from
// the lychee-artifacts store on mount and rendered by mounting the SEALED
// sandbox page (sandbox-exec.html) in render mode — a real DOM/JS page under
// a default-src 'none' CSP: inline <script>/<style> and data: images work,
// but no fetch/XHR/WebSocket, no remote script/image/font, and no form ever
// reaches the network (see sandbox-exec.html's own comment for the exact
// allowance list). This is NOT the same isolation as RunCode's QuickJS
// sandbox, which has no DOM/network surface at all regardless of CSP.

import { useEffect, useRef, useState } from 'react'
import { getArtifact, type CodeArtifact } from '../data/artifacts'
import { artifactFrameReducer } from './artifactVisibility'

// These sizes are quoted in the CreateArtifact/UpdateArtifact descriptions
// (src/tools/tools.ts) so the model designs for the real viewport — keep in sync.
const COLLAPSED_H = 360
const EXPANDED_H = 720

// How far outside the viewport a card is still kept mounted-and-running
// before its sandboxed iframe is torn down. Wide enough that ordinary
// scrolling doesn't thrash iframe creation/teardown; still bounds how many
// artifacts run concurrently in a long, artifact-heavy conversation (see
// artifactVisibility.ts for the suspend/restore semantics this implements).
const VISIBILITY_MARGIN = '600px'

export function ArtifactCard({ artifactId, revision }: { artifactId: string; revision?: number }) {
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null)
  const [missing, setMissing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  // Assume visible until observed otherwise, so a card just created (and
  // presumably being watched as it streams in) renders immediately instead
  // of flashing a placeholder for one frame. Off-screen cards from history
  // (e.g. scrolled straight to the bottom of a long conversation) are
  // corrected to suspended within the observer's first callback.
  const [visible, setVisible] = useState(true)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

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

  // Suspend the sandboxed iframe (unmount it, halting every timer/animation
  // it was running) once the card is well outside the viewport; restore it
  // on demand when scrolled back near the viewport. See artifactVisibility.ts
  // for why this is the chosen tradeoff and what it does and doesn't preserve.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const obs = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: VISIBILITY_MARGIN,
    })
    obs.observe(root)
    return () => obs.disconnect()
  }, [])

  // A suspended iframe is about to unmount (or just did) — drop frameReady so
  // a freshly restored iframe always waits for its OWN exec:ready before
  // anything is posted into it (see artifactFrameReducer's own comment).
  useEffect(() => {
    setFrameReady((prev) => artifactFrameReducer(prev, { type: 'visibility', visible }))
  }, [visible])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      if (e.data && e.data.type === 'exec:ready') {
        setFrameReady((prev) => artifactFrameReducer(prev, { type: 'frame-ready' }))
      }
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

  const frameHeight = expanded ? EXPANDED_H : COLLAPSED_H

  return (
    <div className="artifact-card" ref={rootRef}>
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
      {visible ? (
        <iframe
          ref={frameRef}
          title={artifact?.title ?? 'Artifact'}
          src={chrome.runtime.getURL('sandbox-exec.html')}
          style={{ height: frameHeight }}
        />
      ) : (
        // Suspended: no iframe mounted, nothing running. Same footprint so
        // scrolling doesn't jump when a card above/below suspends or restores.
        <div className="artifact-suspended" style={{ height: frameHeight }} />
      )}
    </div>
  )
}
