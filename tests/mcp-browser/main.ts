// Real browser fetch/CSP smoke test; Chrome identity/storage are local fixtures.
import { mountInteractions } from './interactions'
import { McpManager } from '../../src/mcp/manager'
import { ChromeOAuthProvider } from '../../src/mcp/auth'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Settings } from '../../src/data/settings'

const output = document.querySelector('pre')!
const lines: string[] = []
const report = (line: string) => { lines.push(line); output.textContent = lines.join('\n') }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const store: Record<string, unknown> = {}
Object.assign(globalThis, { chrome: {
  runtime: {sendMessage:async(msg:{type:string})=>{if(msg.type==='research.clearTasks')delete store.researchTasks}},
  storage: { onChanged:{addListener:()=>{},removeListener:()=>{}}, local: {
    clear:async()=>{for(const key of Object.keys(store))delete store[key]},
    get: async (key: string) => ({ [key]: store[key] }),
    set: async (value: Record<string, unknown>) => { Object.assign(store, value) },
    remove: async (key: string) => { delete store[key] },
  } },
  identity: {
    getRedirectURL: () => `${location.origin}/callback`,
    launchWebAuthFlow: ({ url }: { url: string }, callback: (url: string) => void) => {
      void fetch(url).then(r => r.json()).then(r => callback(r.redirect))
    },
  },
} })
async function run() {
  const manager = new McpManager()
  try {
    const settings = { mcp: { servers: {
      modern: { url: `${location.origin}/modern` }, legacy: { url: `${location.origin}/legacy` },
    } } } as unknown as Settings
    await manager.refresh(settings)
    await Promise.all(['modern', 'legacy'].map(name => manager.ensureConnected(name)))
    check(manager.runtime().find(s => s.name === 'modern')?.protocol === '2026-07-28', 'Modern negotiation')
    check(manager.runtime().find(s => s.name === 'legacy')?.protocol === 'legacy', 'Legacy fallback')
    report('PASS: modern and legacy negotiation over real browser HTTP')
    for (const name of ['modern', 'legacy']) {
      const result = await manager.callTool(name, 'echo', { message: 'browser smoke' })
      check(JSON.stringify(result).includes('browser smoke'), `${name} tool call`)
    }
    report('PASS: tool calls and schema validation under CSP without unsafe-eval')
    const live = manager.runtime().find(s => s.name === 'modern')!
    settings.mcp!.updates = { modern: { enabled: true, scope: live.updateScope, resourceUris: ['fixture://one'] } }
    await manager.refresh(settings)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Subscription timeout')) }, 5000)
      const unsubscribe = manager.subscribe(() => {
        if (manager.runtime().find(s => s.name === 'modern')?.updates?.length) {
          clearTimeout(timeout); unsubscribe(); resolve()
        }
      })
    })
    report('PASS: subscription acknowledgement and URI-only resource update')
    let needsConsent = false
    try { await manager.callTool('modern', 'needs_scope', {}) } catch { needsConsent = true }
    check(needsConsent && manager.runtime().find(s => s.name === 'modern')?.status === 'needs-auth', 'Scope challenge')
    await manager.authorize('modern')
    const afterConsent = await manager.callTool('modern', 'needs_scope', {})
    check(JSON.stringify(afterConsent).includes('authorized'), 'Scope-authorized tool')
    report('PASS: insufficient scope requires explicit authorization before retry')
    const provider = new ChromeOAuthProvider('oauth-fixture', `${location.origin}/protected`, { interactive: true })
    const status = await auth(provider, { serverUrl: `${location.origin}/protected`, fetchFn: provider.fetch })
    check(status === 'REDIRECT', 'OAuth redirect')
    const code = provider.takeAuthorizationCode()
    check(code, 'Validated authorization code')
    await auth(provider, { serverUrl: `${location.origin}/protected`, authorizationCode: code, fetchFn: provider.fetch })
    check((await provider.tokens())?.access_token === 'fixture-access', 'Token exchange')
    report('PASS: OAuth discovery, DCR, PKCE, issuer-validated callback and token exchange')
    report('Identity popup is simulated; no external account or credentials used.')
    document.title = 'PASS — MCP browser smoke'
  } finally { manager.disconnectAll() }
}
run().then(mountInteractions).catch(error => { document.title = 'FAIL — MCP browser smoke'; report(`FAIL: ${error.stack ?? error}`) })
