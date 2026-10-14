// @vitest-environment node
import { describe,it,expect,vi } from 'vitest'
import { buildMcpExtensionTools } from './extensionTools'
import type { McpManager } from './manager'
import type { Settings } from '../data/settings'
function setup(approved:boolean) {
  const request=vi.fn(async()=>({skills:[]})),approve=vi.fn(async()=>approved)
  const manager={runtime:()=>[{name:'srv',protocol:'2026-07-28'}],modernClient:vi.fn(async()=>({scope:'scope',client:{supportsExtension:()=>true,getServerCapabilities:()=>({resources:{}}),request}}))} as unknown as McpManager
  const settings={mcp:{servers:{srv:{url:'https://mcp.test'}}}} as unknown as Settings
  return {manager,settings,request,approve,tools:buildMcpExtensionTools(manager,settings,approve)}
}
const invoke=async(t:unknown,input:unknown)=>(t as {execute:(input:unknown,opts:object)=>Promise<unknown>}).execute(input,{})
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
