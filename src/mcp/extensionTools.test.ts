// @vitest-environment node
import 'fake-indexeddb/auto'
import { saveTask,listSavedTasks,forgetTask } from './tasks'
import { describe,it,expect,vi,beforeEach } from 'vitest'
import { buildMcpExtensionTools } from './extensionTools'
import type { McpManager } from './manager'
import type { Settings } from '../data/settings'
function setup(approved:boolean) {
  const request=vi.fn(async(..._args:unknown[])=>({skills:[]})),approve=vi.fn(async()=>approved)
  const client={supportsExtension:()=>true,getServerCapabilities:()=>({resources:{}}),request}
  const manager={assertExtensionAccess:vi.fn(),runtime:()=>[{name:'srv',status:'connected',taskScope:'scope',protocol:'2026-07-28'}],modernClient:vi.fn(async()=>({scope:'scope',client}))} as unknown as McpManager
  const settings={mcp:{servers:{srv:{url:'https://mcp.test'}}}} as unknown as Settings
  return {manager,settings,request,approve,tools:buildMcpExtensionTools(manager,settings,approve)}
}
const invoke=async(t:unknown,input:unknown)=>(t as {execute:(input:unknown,opts:object)=>Promise<unknown>}).execute(input,{})
beforeEach(async()=>{for(const t of await listSavedTasks())await forgetTask(t.id)})
describe('MCP extension tool gates',()=>{
  it('denied approval prevents even metadata lookup',async()=>{
    const h=setup(false)
    expect(await invoke(h.tools.ListMcpSkills,{server:'srv'})).toMatchObject({error:expect.stringContaining('declined')})
    expect(h.request).not.toHaveBeenCalled();expect(h.manager.modernClient).not.toHaveBeenCalled()
    expect(h.approve).toHaveBeenCalledWith(expect.objectContaining({once:true}))
  })
  it('a disabled server cannot be read even if approval would succeed',async()=>{
    const h=setup(true);h.settings.mcp!.serverState={srv:{enabled:false}}
    const tools=buildMcpExtensionTools(h.manager,h.settings,h.approve)
    expect(await invoke(tools.ListMcpSkills,{server:'srv'})).toMatchObject({error:expect.stringContaining('disabled')})
    expect(h.request).not.toHaveBeenCalled();expect(h.approve).not.toHaveBeenCalled()
  })
  it('does not accept a model-invented loaded skill handle',async()=>{
    const h=setup(true)
    expect(await invoke(h.tools.ReadMcpSkillFile,{handle:'invented',path:'secret'})).toMatchObject({error:expect.stringContaining('approve')})
    expect(h.request).not.toHaveBeenCalled()
  })
  it('lists metadata only after explicit approval',async()=>{
    const h=setup(true)
    expect(await invoke(h.tools.ListMcpSkills,{server:'srv'})).toEqual({server:'srv',skills:[]})
    expect(h.request).toHaveBeenCalledWith('skills/list',{},expect.anything())
  })
})

it('filters task metadata from previous credential sessions before sending it to the model',async()=>{
  const h=setup(true)
  const record={id:'old',server:'srv',scope:'old-account',tool:'private-job',taskId:'secret-id',status:'working' as const,createdAt:new Date().toISOString(),lastUpdatedAt:new Date().toISOString(),ttlMs:null,nextPollAt:0}
  await saveTask(record);await saveTask({...record,id:'current',scope:'scope'})
  const result=await invoke(h.tools.ListMcpTasks,{}) as {tasks:{id:string}[]}
  expect(result.tasks.map(t=>t.id)).toEqual(['current'])
})
it('rechecks live policy after a catalog approval is pending',async()=>{
  const h=setup(true)
  h.approve.mockImplementation(async()=>{vi.mocked(h.manager.assertExtensionAccess).mockImplementation(()=>{throw Error('disabled')});return true})
  expect(await invoke(h.tools.ListMcpSkills,{server:'srv'})).toMatchObject({error:'disabled'})
  expect(h.request).not.toHaveBeenCalled()
})
it('never uses the skills policy for task operations',async()=>{
  const h=setup(true)
  await saveTask({id:'job',server:'srv',scope:'scope',tool:'job',taskId:'one',status:'working',createdAt:new Date().toISOString(),lastUpdatedAt:new Date().toISOString(),ttlMs:null,nextPollAt:0})
  vi.mocked(h.manager.assertExtensionAccess).mockImplementation((_server,method)=>{if(method==='tasks/get')throw Error('task access denied')})
  expect(await invoke(h.tools.GetMcpTask,{id:'job'})).toEqual({error:'task access denied'})
  expect(h.approve).not.toHaveBeenCalled()
})
it('rechecks the exact client after manifest approval, even with the same scope',async()=>{
  const h=setup(true)
  const uri='skill://demo/SKILL.md'
  h.request.mockResolvedValue({skill:{uri,frontmatter:{name:'demo',description:'Demo'},resources:[{uri,size:0,digest:'sha256:'+'0'.repeat(64)}]}} as never)
  h.approve.mockImplementation(async()=>{
    if(h.approve.mock.calls.length===2)vi.mocked(h.manager.modernClient).mockResolvedValue({scope:'scope',client:{} as never})
    return true
  })
  expect(await invoke(h.tools.ReadMcpSkill,{server:'srv',uri})).toMatchObject({error:expect.stringContaining('changed')})
  expect(h.request.mock.calls.map(c=>c[0])).toEqual(['skills/get'])
})

it('verifies skill bytes and blocks a supporting-file read when connection changes during approval',async()=>{
  const h=setup(true), uri='skill://demo/SKILL.md', file='skill://demo/notes.txt'
  const text='---\nname: demo\ndescription: Demo\n---\nInstructions'
  const digest='sha256:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex')
  h.request.mockImplementation(async(method,...args)=>{
    if(method==='skills/get')return {skill:{uri,frontmatter:{name:'demo',description:'Demo'},resources:[{uri,size:text.length,digest},{uri:file,size:0,digest:'sha256:'+'0'.repeat(64)}]}} as never
    if(method==='resources/read')return {contents:[{uri,text}]} as never
    throw Error('unexpected '+method+JSON.stringify(args))
  })
  const loaded=await invoke(h.tools.ReadMcpSkill,{server:'srv',uri}) as {handle:string,text:string}
  expect(loaded.text).toBe(text);expect(h.approve).toHaveBeenCalledTimes(2)
  h.request.mockClear()
  h.approve.mockImplementation(async()=>{vi.mocked(h.manager.modernClient).mockResolvedValue({scope:'scope',client:{} as never});return true})
  expect(await invoke(h.tools.ReadMcpSkillFile,{handle:loaded.handle,path:'notes.txt'})).toMatchObject({error:expect.stringContaining('changed')})
  expect(h.request).not.toHaveBeenCalled()
})

it('honors the user-visible skills/list policy before approval or network access',async()=>{
  const h=setup(true)
  h.settings.mcp!.policies={srv:{tools:{'skills/list':'never'}}}
  const tools=buildMcpExtensionTools(h.manager,h.settings,h.approve)
  expect(await invoke(tools.ListMcpSkills,{server:'srv'})).toMatchObject({error:expect.stringContaining('disabled')})
  expect(h.approve).not.toHaveBeenCalled();expect(h.request).not.toHaveBeenCalled()
})
