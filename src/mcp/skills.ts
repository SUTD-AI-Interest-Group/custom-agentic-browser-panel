import { parseDocument } from 'yaml'
import { isObject, type JsonObject, type ModernMcpClient } from './modern'
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
const MAX_SKILL_BYTES = 16 * 1024 * 1024
export interface SkillFile { uri: string; digest: string; size: number }
export interface RemoteSkill { uri: string; frontmatter: JsonObject & { name: string; description: string }; resources: SkillFile[] | 'dynamic' }
function resourceUrl(uri: string): URL {
  const url = new URL(uri)
  if (url.username || url.password || url.hash) throw Error('Invalid skill resource URI.')
  return url
}
export function parseSkill(value: unknown): RemoteSkill {
  if (!isObject(value) || typeof value.uri !== 'string' || !isObject(value.frontmatter) || typeof value.frontmatter.name !== 'string' || typeof value.frontmatter.description !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.frontmatter.name) || value.frontmatter.name.length > 64 || !value.frontmatter.description || value.frontmatter.description.length > 1024) throw Error('Invalid MCP skill metadata.')
  const url = resourceUrl(value.uri)
  const path = url.pathname.split('/').filter(Boolean)
  if (path.pop() !== 'SKILL.md' || (path.pop() ?? url.hostname) !== value.frontmatter.name) throw Error('Skill directory must match its name.')
  if (value.resources !== 'dynamic') {
    if (!Array.isArray(value.resources) || !value.resources.length || value.resources.length > 512) throw Error('Invalid skill manifest.')
    const seen = new Set<string>(); let total = 0
    for (const file of value.resources) {
      if (!isObject(file) || typeof file.uri !== 'string' || typeof file.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || seen.has(file.uri)) throw Error('Invalid skill manifest file.')
      resourceUrl(file.uri); seen.add(file.uri); total += file.size as number
    }
    if (!seen.has(value.uri) || total > MAX_SKILL_BYTES) throw Error('Incomplete or oversized skill manifest.')
  }
  return structuredClone(value) as unknown as RemoteSkill
}
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stableValue(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export async function listRemoteSkills(client: ModernMcpClient, signal?: AbortSignal): Promise<RemoteSkill[]> {
  requireSkills(client)
  const items: RemoteSkill[] = [], cursors = new Set<string>(), uris = new Set<string>()
  let cursor: string | undefined
  for(let page=0;page<100;page++) {
    const result=await client.request('skills/list',cursor?{cursor}:{},{signal})
    if(!Array.isArray(result.skills))throw Error('Invalid skills catalog.')
    for(const raw of result.skills) { const skill=parseSkill(raw);if(uris.has(skill.uri))throw Error('Duplicate skill identity.');uris.add(skill.uri);items.push(skill) }
    if(items.length>10_000)throw Error('Skill catalog exceeds limits.')
    if(result.nextCursor===undefined)return items
    if(typeof result.nextCursor!=='string'||!result.nextCursor||cursors.has(result.nextCursor))throw Error('Invalid skill pagination.')
    cursor=result.nextCursor;cursors.add(cursor)
  }
  throw Error('Skill pagination limit exceeded.')
}
function requireSkills(client: ModernMcpClient) {
  if(!client.supportsExtension(SKILLS_EXTENSION)||!client.getServerCapabilities().resources)throw Error('Server does not advertise Skills and Resources support.')
}
export async function getRemoteSkill(client: ModernMcpClient, uri: string, signal?: AbortSignal): Promise<RemoteSkill> {
  requireSkills(client)
  const result=await client.request('skills/get',{uri},{signal})
  const skill=parseSkill(result.skill)
  if(skill.uri!==uri)throw Error('Server returned a different skill identity.')
  if(skill.resources==='dynamic')throw Error('Dynamic skills are not supported: this client requires an integrity manifest.')
  return skill
}
export async function readVerifiedSkillFile(client: ModernMcpClient, skill: RemoteSkill, uri: string, signal?: AbortSignal): Promise<string> {
  requireSkills(client)
  if(skill.resources==='dynamic')throw Error('An integrity manifest is required.')
  const file=skill.resources.find(x=>x.uri===uri)
  if(!file)throw Error('Resource is outside the approved skill manifest. Refresh and approve the skill to add files.')
  // Always use originating MCP transport, never fetch a URI directly. No prefetch.
  const result=await client.request('resources/read',{uri},{signal,maxResponseBytes:128*1024*1024})
  if(!Array.isArray(result.contents)||result.contents.length!==1||!isObject(result.contents[0])||result.contents[0].uri!==uri)throw Error('Unexpected skill resource content.')
  const content=result.contents[0]
  let bytes: Uint8Array
  if(typeof content.text==='string' && content.blob===undefined) bytes=new TextEncoder().encode(content.text)
  else if(typeof content.blob==='string' && content.text===undefined && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.blob)) bytes=Uint8Array.from(atob(content.blob),x=>x.charCodeAt(0))
  else throw Error('Invalid skill file encoding.')
  if(bytes.byteLength!==file.size||bytes.byteLength>MAX_SKILL_BYTES)throw Error('Skill file size changed. Refresh the skill and obtain new approval.')
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),x=>x.toString(16).padStart(2,'0')).join('')
  if(`sha256:${digest}`!==file.digest)throw Error('Skill integrity verification failed. Refresh the skill and obtain new approval.')
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
  if(uri===skill.uri) {
    const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    if(!match||match[1].length>64_000)throw Error('Missing or oversized skill frontmatter.')
    const doc=parseDocument(match[1],{uniqueKeys:true, schema:'core'})
    if(doc.errors.length)throw Error('Invalid skill YAML frontmatter.')
    const parsed: unknown=doc.toJS({maxAliasCount:0})
    if(stableValue(parsed)!==stableValue(skill.frontmatter))throw Error('Skill frontmatter differs from approved metadata.')
  }
  return text
}
