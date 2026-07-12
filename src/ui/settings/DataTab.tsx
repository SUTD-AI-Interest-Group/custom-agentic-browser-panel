import { useEffect, useState } from 'react'
import { resetSettingsKeepingProviders, type Settings } from '../../data/settings'
import { clearStore, eraseAllData, storageReport } from '../../data/storage'
import { formatBytes, type StorageReport, type StoreKey } from '../../data/usage'
import { Section } from './primitives'

const ROWS: Array<{ key: StoreKey; label: string }> = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'screenshots', label: 'Screenshots' },
  { key: 'memory', label: 'Memory' },
  { key: 'skills', label: 'Skills' },
  { key: 'research', label: 'Research' },
]

/** What clearing each store actually destroys — revealed once the button is armed. */
const CLEAR_EFFECT: Record<StoreKey, string> = {
  conversations: 'Deletes every chat and its screenshots.',
  screenshots: 'Deletes every captured image.',
  memory: 'Deletes all memories and the episode log.',
  skills: 'Deletes your custom skills. Built-ins are restored.',
  research: 'Deletes all saved reports.',
}

/**
 * Data tab: what the extension is storing, and every way to throw it away.
 *
 * Destructive actions confirm inline and two-step (Clear → Sure?) rather than in a
 * modal: the panel has no modal system, and a dialog at ~400px is worse than the
 * thing it guards. The one exception is the full erase, which takes the user's API
 * keys with it and so demands the word typed out.
 */
export default function DataTab({
  draft,
  commit,
  onErased,
}: {
  draft: Settings
  commit: (next: Settings) => void
  onErased: () => void
}) {
  const [report, setReport] = useState<StorageReport | null>(null)
  // The row whose button is currently armed ("Sure?"), if any.
  const [armed, setArmed] = useState<StoreKey | 'settings' | null>(null)
  const [busy, setBusy] = useState(false)
  const [eraseText, setEraseText] = useState('')

  function refresh() {
    void storageReport()
      .then(setReport)
      .catch(() => setReport(null))
  }
  useEffect(refresh, [])

  // Disarm after a few seconds — an armed destructive button left sitting there is
  // a trap for the next click.
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 4000)
    return () => clearTimeout(t)
  }, [armed])

  async function doClear(key: StoreKey) {
    setBusy(true)
    await clearStore(key).catch(() => {})
    setArmed(null)
    setBusy(false)
    refresh()
  }

  async function doErase() {
    setBusy(true)
    await eraseAllData().catch(() => {})
    setBusy(false)
    onErased()
  }

  const pct = report && report.quota ? Math.min(100, (report.total / report.quota) * 100) : null

  return (
    <div className="settings-tabpane">
      <Section title="Data & storage">
        {!report ? (
          <p className="hint">Measuring…</p>
        ) : (
          <>
            <div className="usage-head">
              <span className="usage-total">{formatBytes(report.total)} used</span>
              {report.quota && (
                <span className="usage-quota">of {formatBytes(report.quota)} available</span>
              )}
            </div>
            {pct !== null && (
              <div className="usage-bar">
                {/* A sliver keeps the bar legible when usage rounds to ~0%. */}
                <div className="usage-fill" style={{ width: `${Math.max(pct, 0.5)}%` }} />
              </div>
            )}

            <div className="data-rows">
              {ROWS.map(({ key, label }) => {
                const usage = report.stores[key]
                const isArmed = armed === key
                return (
                  <div className={`data-row ${isArmed ? 'armed' : ''}`} key={key}>
                    <div className="data-row-main">
                      <span className="data-label">{label}</span>
                      <span className="data-detail">{usage.detail ?? `${usage.count} items`}</span>
                    </div>
                    <span className="data-bytes">{formatBytes(usage.bytes)}</span>
                    <button
                      className={`btn small ${isArmed ? 'danger-solid' : 'ghost'}`}
                      disabled={busy || usage.count === 0}
                      onClick={() => (isArmed ? void doClear(key) : setArmed(key))}
                    >
                      {isArmed ? 'Sure?' : 'Clear'}
                    </button>
                    {isArmed && <p className="data-warn">{CLEAR_EFFECT[key]}</p>}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </Section>

      <Section title="Danger zone">
        <div className="danger-row">
          <div className="data-row-main">
            <span className="data-label">Reset settings to defaults</span>
            <span className="data-detail">Keeps your chats, memory, skills and API keys.</span>
          </div>
          <button
            className={`btn small ${armed === 'settings' ? 'danger-solid' : 'ghost'}`}
            disabled={busy}
            onClick={() => {
              if (armed === 'settings') {
                commit(resetSettingsKeepingProviders(draft))
                setArmed(null)
              } else {
                setArmed('settings')
              }
            }}
          >
            {armed === 'settings' ? 'Sure?' : 'Reset'}
          </button>
        </div>

        <div className="danger-row">
          <div className="data-row-main">
            <span className="data-label">Erase all data &amp; start over</span>
            <span className="data-detail">
              Everything above, plus your providers and API keys. This cannot be undone.
            </span>
          </div>
        </div>
        <div className="erase-confirm">
          <input
            value={eraseText}
            placeholder="Type erase to confirm"
            aria-label="Type erase to confirm"
            onChange={(e) => setEraseText(e.target.value)}
          />
          <button
            className="btn small danger-solid"
            disabled={busy || eraseText.trim().toLowerCase() !== 'erase'}
            onClick={() => void doErase()}
          >
            Erase
          </button>
        </div>
      </Section>
    </div>
  )
}
