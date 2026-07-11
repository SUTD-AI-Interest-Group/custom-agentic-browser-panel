import { useEffect, useState } from 'react'
import {
  TOOL_CATALOG,
  toolPolicy,
  type Settings,
  type ToolGroup,
  type ToolPolicy,
} from '../../data/settings'
import {
  BROWSING_CAPABILITIES,
  type BrowsingCapability,
  grantedCapabilities,
  requestCapabilities,
  removeCapabilities,
} from '../../platform/permissions'

const GROUP_ORDER: ToolGroup[] = [
  'reading',
  'control',
  'navigation',
  'memory',
  'insights',
  'skills',
]

const GROUP_LABELS: Record<ToolGroup, string> = {
  reading: 'Page reading',
  control: 'Page control',
  navigation: 'Navigation',
  memory: 'Long-term memory',
  insights: 'Browsing insights',
  skills: 'Skills',
}

const POLICIES: ToolPolicy[] = ['never', 'ask', 'always']
const POLICY_LABELS: Record<ToolPolicy, string> = {
  never: 'Never',
  ask: 'Ask',
  always: 'Always',
}

/**
 * Permissions tab: tab visibility, browsing insights, and the per-tool
 * Never/Ask/Always matrix. Tab visibility and tool policies live in Settings and
 * commit instantly; browsing insights are Chrome optional permissions so they
 * act immediately on their own (and flash "Saved ✓" via onSaved).
 */
export default function PermissionsTab({
  draft,
  commit,
  onSaved,
}: {
  draft: Settings
  commit: (next: Settings) => void
  onSaved: () => void
}) {
  function setPolicy(name: string, policy: ToolPolicy) {
    commit({ ...draft, toolPolicies: { ...draft.toolPolicies, [name]: policy } })
  }

  return (
    <div className="settings-tabpane">
      <h2>Tab visibility</h2>
      <p className="hint">
        How much of your browsing the agent may see. Individual reads still ask for permission.
      </p>
      <label className={`access-option ${draft.tabAccess === 'active-tab' ? 'chosen' : ''}`}>
        <input
          type="radio"
          name="tabAccessSetting"
          checked={draft.tabAccess === 'active-tab'}
          onChange={() => commit({ ...draft, tabAccess: 'active-tab' })}
        />
        <div>
          <div className="access-title">Only my current tab</div>
          <div className="access-desc">
            The agent can only see the tab you're on; @mentions offer just the current tab.
          </div>
        </div>
      </label>
      <label className={`access-option ${draft.tabAccess === 'all-tabs' ? 'chosen' : ''}`}>
        <input
          type="radio"
          name="tabAccessSetting"
          checked={draft.tabAccess === 'all-tabs'}
          onChange={() => commit({ ...draft, tabAccess: 'all-tabs' })}
        />
        <div>
          <div className="access-title">All open tabs</div>
          <div className="access-desc">
            The agent can list and (with permission) read any open tab; @mention any of them.
          </div>
        </div>
      </label>

      <BrowsingInsightsSection onSaved={onSaved} />

      <h2>Tool permissions</h2>
      <p className="hint">
        Set how each agent tool is gated. <strong>Never</strong> hides it from the agent
        entirely; <strong>Ask</strong> shows an approval card each time; <strong>Always</strong>{' '}
        runs it without asking. Risky page-control steps (form submits, cross-site navigation,
        passwords) still confirm even on Always.
      </p>
      {GROUP_ORDER.map((group) => {
        const tools = TOOL_CATALOG.filter((t) => t.group === group)
        if (tools.length === 0) return null
        return (
          <div className="tool-group" key={group}>
            <div className="tool-group-title">{GROUP_LABELS[group]}</div>
            {tools.map((t) => {
              const current = toolPolicy(draft, t.name)
              return (
                <div className="tool-row" key={t.name}>
                  <span className="tool-label">{t.label}</span>
                  <div className="policy-seg" role="radiogroup" aria-label={t.label}>
                    {POLICIES.map((policy) => (
                      <button
                        key={policy}
                        role="radio"
                        aria-checked={current === policy}
                        className={`policy-opt ${policy} ${current === policy ? 'active' : ''}`}
                        onClick={() => setPolicy(t.name, policy)}
                      >
                        {POLICY_LABELS[policy]}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// Browsing-data capabilities are Chrome optional permissions, not part of
// Settings — so this section acts immediately (grant/revoke on toggle), not on
// commit, and reads its state live from chrome.permissions. It stays in sync
// when the user grants/revokes elsewhere (e.g. chrome://extensions).
const CAPABILITY_LABELS: Record<BrowsingCapability, string> = {
  history: 'Browsing history',
  bookmarks: 'Bookmarks',
  topSites: 'Top sites',
  downloads: 'Downloads',
}

function BrowsingInsightsSection({ onSaved }: { onSaved: () => void }) {
  const [granted, setGranted] = useState<Set<BrowsingCapability>>(new Set())

  useEffect(() => {
    const refresh = () => grantedCapabilities().then(setGranted).catch(() => {})
    refresh()
    chrome.permissions.onAdded.addListener(refresh)
    chrome.permissions.onRemoved.addListener(refresh)
    return () => {
      // @types/chrome 0.0.280 omits removeListener from these permission
      // events, though Chrome provides it at runtime.
      type PermEvent = { removeListener(cb: () => void): void }
      ;(chrome.permissions.onAdded as unknown as PermEvent).removeListener(refresh)
      ;(chrome.permissions.onRemoved as unknown as PermEvent).removeListener(refresh)
    }
  }, [])

  // request/remove must be called from this click handler (the user gesture).
  // We re-read afterward so a denied prompt reverts the checkbox from state.
  async function toggle(caps: BrowsingCapability[], on: boolean) {
    if (on) await requestCapabilities(caps)
    else await removeCapabilities(caps)
    setGranted(await grantedCapabilities())
    onSaved()
  }

  const allOn = BROWSING_CAPABILITIES.every((c) => granted.has(c))
  const missing = BROWSING_CAPABILITIES.filter((c) => !granted.has(c))

  return (
    <>
      <h2>Browsing insights</h2>
      <p className="hint">
        Let the agent look up your history, bookmarks, top sites and downloads to enrich answers.
        Each lookup still asks for permission. Granting happens here and can be revoked anytime.
      </p>
      <label className="toggle-row master">
        <div className="access-title">Enable all browsing insights</div>
        <input
          type="checkbox"
          checked={allOn}
          onChange={(e) =>
            void toggle(e.target.checked ? missing : BROWSING_CAPABILITIES, e.target.checked)
          }
        />
      </label>
      {BROWSING_CAPABILITIES.map((cap) => (
        <label className="toggle-row" key={cap}>
          <div className="access-desc">{CAPABILITY_LABELS[cap]}</div>
          <input
            type="checkbox"
            checked={granted.has(cap)}
            onChange={(e) => void toggle([cap], e.target.checked)}
          />
        </label>
      ))}
    </>
  )
}
