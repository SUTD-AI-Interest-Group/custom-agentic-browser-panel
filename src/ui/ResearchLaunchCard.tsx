import { useState } from 'react'
import type { ResearchProposal } from '../data/researchTasks'
import { addSite } from './researchSites'

/**
 * The editable launch card: the moment a background-research question becomes
 * visible and editable before anything runs. A user asked to compare "the 5
 * setups" on a page that listed 4; background research launched on that
 * phrasing, hunted for a fifth, and reported an unrelated machine as if it
 * belonged — 22 minutes later, with the wrong question never once shown to
 * the user. This card is what stands between an armed send and that outcome.
 *
 * Fully controlled: every edit (question text, site chips) calls `onChange`
 * with the next `ResearchProposal` — this component holds no proposal state
 * of its own, only the transient add-site input text. Rendered directly from
 * a transcript message carrying a `proposal` field (Chat.tsx) today, and,
 * once Task 11 lands, as the `researchCardState() === 'proposed'` face of the
 * unified research card — either way a plain, presentational component with
 * no conversationId/model/tool dependency of its own.
 */
export default function ResearchLaunchCard({
  proposal,
  onChange,
  onStart,
  onCancel,
}: {
  proposal: ResearchProposal
  onChange: (next: ResearchProposal) => void
  onStart: (proposal: ResearchProposal) => void
  onCancel: (proposal: ResearchProposal) => void
}) {
  // The add-site input's own text, separate from `proposal.sites` — cleared
  // only on a successful add, left alone otherwise so the user can see and
  // fix what they typed (junk, a bare public suffix, or a duplicate all
  // leave the box as-is rather than silently eating the keystrokes).
  const [siteText, setSiteText] = useState('')
  const nextSites = addSite(proposal.sites, siteText)
  const canAddSite = nextSites !== proposal.sites

  function addTypedSite() {
    if (!canAddSite) return
    onChange({ ...proposal, sites: nextSites })
    setSiteText('')
  }

  function removeSite(site: string) {
    onChange({ ...proposal, sites: proposal.sites.filter((s) => s !== site) })
  }

  return (
    // Same id shape as the report card (`research-<taskId>`, ResearchReportMessage
    // in Chat.tsx) — the transcript message's own id — so a future scroll-to
    // (or Task 11's single-slot transition) can target this card the same way.
    <div className="research-launch" id={`research-${proposal.taskId}`}>
      <div className="research-launch__label">◈ Deep research</div>

      <textarea
        className="research-launch__question"
        value={proposal.question}
        onChange={(e) => onChange({ ...proposal, question: e.target.value })}
        rows={2}
        aria-label="Research question"
      />

      {proposal.premise && (
        <div className="research-launch__premise" role="note">
          ⚠ You said {proposal.premise.asserted} — {proposal.premise.corrected}.
        </div>
      )}

      {/* Attached documents. Shown before the site scope because they are the
          stronger claim on the research: a file the user chose beats a host they
          allowed. Removable here, since the card is the last point at which
          dropping one costs nothing. */}
      {proposal.attachments && proposal.attachments.length > 0 && (
        <div className="research-launch__atts">
          {proposal.attachments.map((att) => (
            <span className="research-launch__att" key={att.id} title={att.name}>
              <span className="research-launch__att-icon" aria-hidden="true">
                {att.kind === 'image' ? '🖼' : '📄'}
              </span>
              <span className="research-launch__att-name">{att.name}</span>
              {att.pageCount != null && (
                <span className="research-launch__att-sub">
                  {att.pageCount} page{att.pageCount === 1 ? '' : 's'}
                </span>
              )}
              <button
                type="button"
                className="context-remove"
                title={`Remove ${att.name}`}
                aria-label={`Remove ${att.name}`}
                onClick={() =>
                  onChange({ ...proposal, attachments: proposal.attachments!.filter((a) => a.id !== att.id) })
                }
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
          {/* An image contributes nothing on this path — say so on the card rather
              than letting the user discover it from a report that never cites it. */}
          {proposal.attachments.some((a) => a.kind === 'image') && (
            <span className="research-launch__att-note">Images are carried as sources but not read</span>
          )}
        </div>
      )}

      <div className="research-launch__sites">
        {proposal.sites.map((site) => (
          <span className="research-launch__site" key={site}>
            {site}
            <button
              type="button"
              className="context-remove"
              title={`Remove ${site}`}
              aria-label={`Remove ${site}`}
              onClick={() => removeSite(site)}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                <path
                  d="M1.5 1.5l5 5M6.5 1.5l-5 5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </span>
        ))}
        <div className="research-launch__add-site">
          <input
            type="text"
            placeholder="Add a site…"
            value={siteText}
            onChange={(e) => setSiteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // No surrounding <form> to submit, but preventDefault anyway —
              // this is a plain text commit, not a navigation/submit action.
              e.preventDefault()
              addTypedSite()
            }}
            aria-label="Add a site to restrict sources to"
          />
          <button type="button" className="btn ghost small" onClick={addTypedSite} disabled={!canAddSite}>
            Add
          </button>
        </div>
      </div>

      {proposal.brief && (
        <details className="research-launch__brief">
          <summary>What it already knows</summary>
          <p>{proposal.brief}</p>
        </details>
      )}

      {proposal.clarifications && proposal.clarifications.length > 0 && (
        <div className="research-launch__clarifications">
          {proposal.clarifications.map((c, i) => (
            <div className="research-launch__clarification" key={i}>
              {c}
            </div>
          ))}
        </div>
      )}

      <div className="research-launch__duration">usually 10–20 min · keeps running if you close the panel</div>

      <div className="research-launch__actions">
        <button type="button" className="btn ghost" onClick={() => onCancel(proposal)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => onStart(proposal)}
          disabled={!proposal.question.trim()}
        >
          Start
        </button>
      </div>
    </div>
  )
}
