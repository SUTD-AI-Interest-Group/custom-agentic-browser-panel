import { pairedPalette, type StudioPalette } from './studioPalette'

export interface StudioZap {
  selector: string
  label: string
  tag: string
  preview?: {
    text: string
    color: string
    background: string
    borderRadius: string
    fontFamily: string
  }
}
export const zapSelector = (zap: StudioZap | string) =>
  typeof zap === 'string' ? zap : zap.selector
export const zapDetails = (zap: StudioZap | string): StudioZap =>
  typeof zap === 'string'
    ? { selector: zap, label: 'Hidden element', tag: 'Element' }
    : zap

export interface StudioBoost {
  origin: string
  enabled: boolean
  palette: StudioPalette | null
  font: string
  css: string
  js: string
  zaps: (StudioZap | string)[]
}
export const STUDIO_PREFIX = 'studio:'
export const studioKey = (origin: string) => STUDIO_PREFIX + origin
export function siteOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.origin : null
  } catch {
    return null
  }
}
export function emptyBoost(origin: string): StudioBoost {
  return {
    origin,
    enabled: true,
    palette: null,
    font: '',
    css: '',
    js: '',
    zaps: [],
  }
}
export async function loadBoost(origin: string): Promise<StudioBoost> {
  const key = studioKey(origin)
  return (await chrome.storage.local.get(key))[key] ?? emptyBoost(origin)
}
export function boostCss(boost: StudioBoost): string {
  if (!boost.enabled) return ''
  const rules: string[] = []
  if (boost.palette) {
    const pair = pairedPalette(boost.palette)
    rules.push(`:root { --studio-background: ${pair.background}; --studio-foreground: ${pair.foreground}; --studio-accent: ${pair.foreground}; color-scheme: ${boost.palette.dark ? 'dark' : 'light'}; }
body, main, section, article, header, footer, nav, aside, div, input, textarea, select, [role="dialog"] { background-color: var(--studio-background) !important; }
:where(body, body *:not(svg):not(svg *)) { color: var(--studio-foreground) !important; }
button, [role="button"] { background-color: var(--studio-foreground) !important; color: var(--studio-background) !important; }
button *, [role="button"] * { color: inherit !important; background-color: transparent !important; }
a { text-decoration-color: currentColor !important; }
::selection { background: var(--studio-foreground); color: var(--studio-background); }`)
  }
  if (boost.font)
    rules.push(
      `body, body *:not(svg):not(path):not([class*="icon"]) { font-family: ${boost.font} !important; }`,
    )
  for (const selector of boost.zaps)
    rules.push(`${zapSelector(selector)} { display: none !important; }`)
  rules.push(boost.css)
  return rules.join('\n')
}
