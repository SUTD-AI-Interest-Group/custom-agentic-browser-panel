// Human-friendly relative timestamps ("just now", "2 days ago") for the chat
// history list.
export function relativeTime(ts: number, now = Date.now()): string {
  const sec = Math.round((now - ts) / 1000)
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min${min === 1 ? '' : 's'} ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`
  const wk = Math.round(day / 7)
  if (wk < 5) return `${wk} week${wk === 1 ? '' : 's'} ago`
  const mo = Math.round(day / 30)
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`
  const yr = Math.round(day / 365)
  return `${yr} year${yr === 1 ? '' : 's'} ago`
}
