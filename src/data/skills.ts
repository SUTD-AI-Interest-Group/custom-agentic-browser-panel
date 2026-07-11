// Agent skills, housed in their own IndexedDB database (extension origin, so
// the side panel and background worker share them). A "skill" is a single-file
// SKILL.md-style record: YAML-ish frontmatter (name + description + metadata)
// plus a Markdown instruction body the agent follows when the skill is invoked.
// Kept in its own DB (not the memory/conversation DBs) so schema versions stay
// independent.

export type SkillSource = 'builtin' | 'user'

export interface Skill {
  id: string
  /** Unique slug; this is the /invocation name. */
  name: string
  /** Third-person "what + when" sentence — the sole trigger signal. */
  description: string
  /** Markdown instructions the agent follows when the skill runs (no frontmatter). */
  body: string
  source: SkillSource
  /** Appears in the composer "/" menu. */
  userInvocable: boolean
  /** Included in the always-on system-prompt catalog (agent may auto-load). */
  modelInvocable: boolean
  /**
   * User on/off switch (Settings → Skills). When false the skill is hidden from
   * the agent catalog, the "/" menu and ReadSkill, regardless of the invocable
   * flags. Absent on older records → treated as enabled.
   */
  enabled: boolean
  /** Emoji shown on the Library card. */
  icon?: string
  /** Accent hex; auto-derived from name when absent. */
  color?: string
  createdAt: number
  updatedAt: number
}

/** Compact form for the system-prompt catalog and ListAllSkills. */
export interface SkillMeta {
  name: string
  description: string
  source: SkillSource
}

export interface SaveSkillInput {
  name: string
  description: string
  body: string
  icon?: string
  color?: string
  userInvocable?: boolean
  modelInvocable?: boolean
  /** Only the seeder passes 'builtin'; agent/UI saves are always 'user'. */
  source?: SkillSource
}

// ---------------------------------------------------------------------------
// IndexedDB (mirrors src/data/conversations.ts single-store shape)
// ---------------------------------------------------------------------------

const DB_NAME = 'agent-chat-skills'
const DB_VERSION = 1
const STORE = 'skills'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close()
          dbPromise = null
        }
        resolve(req.result)
      }
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function requestOf<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const RESERVED_WORDS = ['anthropic', 'claude']

/** Returns a human-readable error, or null when the name is valid. */
export function validateSkillName(name: string): string | null {
  if (!name) return 'Name is required.'
  if (name.length > 64) return 'Name must be 64 characters or fewer.'
  // lowercase alphanumeric segments joined by single hyphens: no leading/
  // trailing hyphen, no consecutive hyphens.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
    return 'Use lowercase letters, numbers and single hyphens, e.g. summarizing-pages.'
  if (RESERVED_WORDS.some((w) => name.includes(w)))
    return 'Name cannot contain “anthropic” or “claude”.'
  return null
}

/** Returns a human-readable error, or null when the skill is savable. */
export function validateSkill(input: { name: string; description: string; body: string }): string | null {
  const nameErr = validateSkillName(input.name)
  if (nameErr) return nameErr
  if (!input.description.trim()) return 'Description is required.'
  if (input.description.length > 1024) return 'Description must be 1024 characters or fewer.'
  if (/[\r\n]/.test(input.description)) return 'Description must be a single line.'
  if (!input.body.trim()) return 'Instructions cannot be empty.'
  return null
}

// ---------------------------------------------------------------------------
// SKILL.md serialization — a tiny hand-rolled frontmatter reader/writer so we
// avoid a YAML dependency. Only the fields we own are supported.
// ---------------------------------------------------------------------------

export interface ParsedSkill {
  name: string
  description: string
  icon?: string
  color?: string
  userInvocable: boolean
  modelInvocable: boolean
  body: string
}

export function serializeSkill(skill: Skill): string {
  const meta: string[] = []
  if (skill.icon) meta.push(`  icon: ${JSON.stringify(skill.icon)}`)
  if (skill.color) meta.push(`  color: ${JSON.stringify(skill.color)}`)
  meta.push(`  userInvocable: ${skill.userInvocable}`)
  meta.push(`  modelInvocable: ${skill.modelInvocable}`)
  const frontmatter = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    'metadata:',
    ...meta,
    '---',
  ].join('\n')
  return `${frontmatter}\n\n${skill.body.trim()}\n`
}

export function parseSkillMarkdown(md: string): ParsedSkill {
  const text = md.replace(/\r\n/g, '\n')
  const fallback: ParsedSkill = {
    name: '',
    description: '',
    userInvocable: true,
    modelInvocable: true,
    body: text.trim(),
  }
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return fallback

  const result: ParsedSkill = { ...fallback, body: text.slice(m[0].length).trim() }
  let inMeta = false
  for (const raw of m[1].split('\n')) {
    if (/^metadata:\s*$/.test(raw)) {
      inMeta = true
      continue
    }
    const indented = /^\s+\S/.test(raw)
    const trimmed = raw.trim()
    if (!trimmed) continue
    const ci = trimmed.indexOf(':')
    if (ci === -1) continue
    const key = trimmed.slice(0, ci).trim()
    let val = trimmed.slice(ci + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (inMeta && indented) {
      if (key === 'icon') result.icon = val
      else if (key === 'color') result.color = val
      else if (key === 'userInvocable') result.userInvocable = val !== 'false'
      else if (key === 'modelInvocable') result.modelInvocable = val !== 'false'
    } else {
      inMeta = false
      if (key === 'name') result.name = val
      else if (key === 'description') result.description = val
    }
  }
  return result
}

/** Deterministic accent so every card looks intentional without user effort. */
export function accentColor(skill: Pick<Skill, 'name' | 'color'>): string {
  if (skill.color) return skill.color
  let h = 0
  for (let i = 0; i < skill.name.length; i++) h = (h * 31 + skill.name.charCodeAt(i)) % 360
  return `hsl(${h} 62% 55%)`
}

// ---------------------------------------------------------------------------
// CRUD (the store is tiny — tens of skills — so we getAll + filter in memory,
// matching how memory.ts searches.)
// ---------------------------------------------------------------------------

export async function listSkills(): Promise<Skill[]> {
  const all = await requestOf<Skill[]>('readonly', (s) => s.getAll())
  // Built-ins first, then custom, each alphabetical — stable Library order.
  return all.sort((a, b) =>
    a.source !== b.source ? (a.source === 'builtin' ? -1 : 1) : a.name.localeCompare(b.name),
  )
}

export async function getSkill(name: string): Promise<Skill | null> {
  const all = await requestOf<Skill[]>('readonly', (s) => s.getAll())
  return all.find((sk) => sk.name === name) ?? null
}

export async function listSkillMetas(opts?: { modelInvocableOnly?: boolean }): Promise<SkillMeta[]> {
  const all = await listSkills()
  // Disabled skills are invisible to the agent everywhere this feeds (the
  // system-prompt catalog and ListAllSkills).
  const enabled = all.filter((s) => s.enabled !== false)
  const filtered = opts?.modelInvocableOnly ? enabled.filter((s) => s.modelInvocable) : enabled
  return filtered.map((s) => ({ name: s.name, description: s.description, source: s.source }))
}

/** Upsert by name. Preserves id/createdAt/source of an existing record. */
export async function saveSkill(input: SaveSkillInput): Promise<Skill> {
  const err = validateSkill(input)
  if (err) throw new Error(err)
  const existing = await getSkill(input.name)
  if (existing && existing.source === 'builtin' && input.source !== 'builtin') {
    throw new Error('Built-in skills cannot be overwritten. Duplicate it to customize.')
  }
  const now = Date.now()
  const record: Skill = {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name,
    description: input.description.trim(),
    body: input.body.trim(),
    source: input.source ?? existing?.source ?? 'user',
    userInvocable: input.userInvocable ?? existing?.userInvocable ?? true,
    modelInvocable: input.modelInvocable ?? existing?.modelInvocable ?? true,
    // Editing a skill preserves its on/off state; new skills start enabled.
    enabled: existing?.enabled ?? true,
    icon: input.icon ?? existing?.icon,
    color: input.color ?? existing?.color,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await requestOf('readwrite', (s) => s.put(record))
  return record
}

export async function deleteSkill(name: string): Promise<void> {
  const existing = await getSkill(name)
  if (!existing) return
  if (existing.source === 'builtin') throw new Error('Built-in skills cannot be deleted.')
  await requestOf('readwrite', (s) => s.delete(existing.id))
}

/**
 * Flip a skill's on/off switch. Unlike saveSkill this deliberately allows
 * toggling built-ins — the enabled flag is a local user preference, not an edit
 * to the skill's content, so the built-in-overwrite guard does not apply.
 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const existing = await getSkill(name)
  if (!existing) return
  await requestOf('readwrite', (s) => s.put({ ...existing, enabled, updatedAt: Date.now() }))
}
