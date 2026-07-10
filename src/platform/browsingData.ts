// Read-only wrappers over Chrome's history, bookmarks, topSites and downloads
// APIs, each mapped to a compact, token-friendly shape for the agent tools.
// Follows the src/platform/tabs.ts pattern: thin, defensive, no UI. Callers are
// responsible for having the matching optional permission granted (see
// permissions.ts); these run only after the tool is exposed to the model.

export interface HistoryEntry {
  title: string
  url: string
  /** ISO 8601 timestamp of the most recent visit. */
  lastVisit: string
  visitCount: number
}

export interface BookmarkEntry {
  title: string
  url: string
  /** Best-effort parent folder name; '' when unknown. */
  folder: string
  /** ISO 8601 timestamp the bookmark was added. */
  dateAdded: string
}

export interface TopSiteEntry {
  title: string
  url: string
}

export interface DownloadEntry {
  /** Basename of the downloaded file (local directory path stripped). */
  filename: string
  url: string
  /** 'complete' | 'in_progress' | 'interrupted'. */
  state: string
  sizeBytes: number
  /** ISO 8601 timestamp the download started. */
  startTime: string
  mime: string
}

const DAY_MS = 86_400_000

const isoOrEmpty = (ms?: number): string => (ms ? new Date(ms).toISOString() : '')

export async function getBrowsingHistory(
  opts: { query?: string; sinceDays?: number; maxResults?: number } = {},
): Promise<HistoryEntry[]> {
  const sinceDays = opts.sinceDays ?? 7
  const maxResults = Math.min(opts.maxResults ?? 50, 200)
  const items = await chrome.history.search({
    text: opts.query ?? '',
    startTime: Date.now() - sinceDays * DAY_MS,
    maxResults,
  })
  return items
    .filter((i) => i.url)
    .map((i) => ({
      title: i.title || '(untitled)',
      url: i.url!,
      lastVisit: isoOrEmpty(i.lastVisitTime),
      visitCount: i.visitCount ?? 0,
    }))
}

export async function getBookmarks(
  opts: { query?: string; maxResults?: number } = {},
): Promise<BookmarkEntry[]> {
  const maxResults = Math.min(opts.maxResults ?? 50, 200)
  const nodes = opts.query
    ? await chrome.bookmarks.search(opts.query)
    : await chrome.bookmarks.getRecent(maxResults)
  const bookmarks = nodes.filter((n) => n.url).slice(0, maxResults)

  // Resolve parent-folder titles best-effort, caching lookups per folder id.
  const folderCache = new Map<string, string>()
  const folderTitle = async (parentId?: string): Promise<string> => {
    if (!parentId) return ''
    const cached = folderCache.get(parentId)
    if (cached !== undefined) return cached
    let title = ''
    try {
      const [parent] = await chrome.bookmarks.get(parentId)
      title = parent?.title ?? ''
    } catch {
      title = ''
    }
    folderCache.set(parentId, title)
    return title
  }

  return Promise.all(
    bookmarks.map(async (n) => ({
      title: n.title || '(untitled)',
      url: n.url!,
      folder: await folderTitle(n.parentId),
      dateAdded: isoOrEmpty(n.dateAdded),
    })),
  )
}

export async function getTopSites(): Promise<TopSiteEntry[]> {
  const sites = await chrome.topSites.get()
  return sites.map((s) => ({ title: s.title || s.url, url: s.url }))
}

export async function getDownloads(
  opts: { query?: string; state?: 'complete' | 'in_progress' | 'interrupted'; maxResults?: number } = {},
): Promise<DownloadEntry[]> {
  const limit = Math.min(opts.maxResults ?? 25, 100)
  const items = await chrome.downloads.search({
    query: opts.query ? [opts.query] : [],
    state: opts.state,
    orderBy: ['-startTime'],
    limit,
  })
  return items.map((d) => ({
    // chrome.downloads.filename is an absolute local path; keep only the name.
    filename: d.filename ? d.filename.replace(/^.*[\\/]/, '') : '(unknown)',
    url: d.finalUrl || d.url,
    state: d.state,
    sizeBytes: d.bytesReceived,
    // DownloadItem.startTime is already an ISO 8601 string.
    startTime: d.startTime ?? '',
    mime: d.mime ?? '',
  }))
}
