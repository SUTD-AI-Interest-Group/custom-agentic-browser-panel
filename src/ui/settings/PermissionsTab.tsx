import { useEffect, useState } from 'react'
import {
  TOOL_CATALOG,
  toolPolicy,
  groupPolicy,
  setGroupPolicy,
  GROUP_ORDER,
  GROUP_LABELS,
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
import { Section } from './primitives'

const POLICIES: ToolPolicy[] = ['never', 'ask', 'always']
const POLICY_LABELS: Record<ToolPolicy, string> = {
  never: 'Never',
  ask: 'Ask',
  always: 'Always',
}

/**
 * Plain-English state of one tool's gate.
 *
 * Tab visibility and Browsing insights used to *assert* that reads "still ask for
 * permission" — which was simply false whenever that tool's policy was `always`.
 * Rendering the sentence *from* the policy rather than alongside it is the actual
 * fix: the copy cannot drift from the behaviour, because it is the behaviour.
 */
function policySentence(policy: ToolPolicy, noun: string): string {
  if (policy === 'never') return `${noun} are turned off.`
  if (policy === 'always') return `${noun} run without asking.`
  return `${noun} ask for approval each time.`
}

/**
 * Permissions tab: tab visibility, browsing insights, and the tool-permission
 * accordion. Settings-backed controls commit instantly; browsing capabilities are
 * Chrome optional permissions and act on their own (flashing "Saved ✓" via onSaved).
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
  // Which groups are expanded. Local, never persisted: the matrix opens fully
  // collapsed every time, which is the whole point of the redesign.
  const [openGroups, setOpenGroups] = useState<Set<ToolGroup>>(new Set())

  function toggleGroup(group: ToolGroup) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  /** Open a group and scroll to it — the target of the "Change" links above. */
  function revealGroup(group: ToolGroup) {
    setOpenGroups((prev) => new Set(prev).add(group))
    requestAnimationFrame(() => {
      document.getElementById(`toolgroup-${group}`)?.scrollIntoView({ block: 'center' })
    })
  }

  function setToolPolicy(name: string, policy: ToolPolicy) {
    commit({ ...draft, toolPolicies: { ...draft.toolPolicies, [name]: policy } })
  }

  return (
    <div className="settings-tabpane">
      <Section title="Tab visibility" hint="How much of your browsing the agent may see.">
        <label className={`access-option ${draft.tabAccess === 'active-tab' ? 'chosen' : ''}`}>
          <input
            type="radio"
            name="tabAccessSetting"
            checked={draft.tabAccess === 'active-tab'}
            onChange={() => commit({ ...draft, tabAccess: 'active-tab' })}
          />
          <div>
            <div className="access-title">Only my current tab</div>
            <div className="access-desc">@mentions offer just the tab you're on.</div>
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
            <div className="access-desc">The agent can list and read any open tab.</div>
          </div>
        </label>
        <p className="derived-state">
          {policySentence(toolPolicy(draft, 'ReadPage'), 'Page reads')}{' '}
          <button className="link-btn" onClick={() => revealGroup('reading')}>
            Change
          </button>
        </p>
      </Section>

      <BrowsingInsightsSection
        draft={draft}
        onSaved={onSaved}
        onChangePolicy={() => revealGroup('insights')}
      />

      <Section title="Tool permissions">
        <ul className="policy-legend">
          <li>
            <strong>Never</strong> — the agent never sees the tool.
          </li>
          <li>
            <strong>Ask</strong> — approve each call, or allow it for the rest of the chat.
          </li>
          <li>
            <strong>Always</strong> — runs without asking.
          </li>
        </ul>

        {GROUP_ORDER.map((group) => {
          const tools = TOOL_CATALOG.filter((t) => t.group === group)
          if (tools.length === 0) return null
          const current = groupPolicy(draft, group)
          const expanded = openGroups.has(group)
          return (
            <div
              className={`tool-group ${expanded ? 'open' : ''}`}
              id={`toolgroup-${group}`}
              key={group}
            >
              <div className="tool-group-head">
                <button
                  className="tool-group-toggle"
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group)}
                >
                  <svg
                    className="disclosure-chevron"
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                  >
                    <path
                      d="M3 1l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="tool-group-title">{GROUP_LABELS[group]}</span>
                  <span className="tool-group-count">{tools.length}</span>
                </button>
                {current === 'mixed' ? (
                  <button className="mixed-pill" onClick={() => toggleGroup(group)}>
                    Mixed
                  </button>
                ) : (
                  <div className="policy-seg" role="radiogroup" aria-label={GROUP_LABELS[group]}>
                    {POLICIES.map((policy) => (
                      <button
                        key={policy}
                        role="radio"
                        aria-checked={current === policy}
                        className={`policy-opt ${policy} ${current === policy ? 'active' : ''}`}
                        onClick={() => commit(setGroupPolicy(draft, group, policy))}
                      >
                        {POLICY_LABELS[policy]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {expanded && (
                <div className="tool-group-body">
                  {group === 'control' && (
                    <p className="hint">
                      Form submits, cross-site navigation and password fields always confirm — even
                      on Always.
                    </p>
                  )}
                  {tools.map((t) => {
                    const toolCurrent = toolPolicy(draft, t.name)
                    return (
                      <div className="tool-row" key={t.name}>
                        <span className="tool-label">{t.label}</span>
                        <div className="policy-seg" role="radiogroup" aria-label={t.label}>
                          {POLICIES.map((policy) => (
                            <button
                              key={policy}
                              role="radio"
                              aria-checked={toolCurrent === policy}
                              className={`policy-opt ${policy} ${toolCurrent === policy ? 'active' : ''}`}
                              onClick={() => setToolPolicy(t.name, policy)}
                            >
                              {POLICY_LABELS[policy]}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </Section>
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

function BrowsingInsightsSection({
  draft,
  onSaved,
  onChangePolicy,
}: {
  draft: Settings
  onSaved: () => void
  onChangePolicy: () => void
}) {
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
    <Section
      title="Browsing insights"
      hint="Let the agent look up your history, bookmarks, top sites and downloads."
    >
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
      <p className="derived-state">
        {policySentence(toolPolicy(draft, 'QueryBrowserData'), 'Lookups')}{' '}
        <button className="link-btn" onClick={onChangePolicy}>
          Change
        </button>
      </p>
    </Section>
  )
}
