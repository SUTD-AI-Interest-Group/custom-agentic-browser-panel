import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import McpInteractions from '../../src/ui/McpInteractions'
import { getMcpManager } from '../../src/mcp/manager'
import { getRemoteSkill, readVerifiedSkillFile, SKILLS_EXTENSION } from '../../src/mcp/skills'
import type { Settings } from '../../src/data/settings'
const manager=getMcpManager()
const settings={mcp:{servers:{interactive:{url:`${location.origin}/interactive`}}}} as unknown as Settings
function Fixture() {
  const [status,setStatus]=useState('Ready for interaction checks')
  async function call(name:string) {
    setStatus('Waiting for '+name)
    try{await manager.ensureConnected('interactive');const result=await manager.callTool('interactive',name,{});setStatus(JSON.stringify(result))}catch(e){setStatus(String(e))}
  }
  async function skill(tampered=false) {
    try {
      const {client}=await manager.modernClient('interactive',SKILLS_EXTENSION)
      const entry=await getRemoteSkill(client,tampered?'skill://changed/SKILL.md':'skill://review/SKILL.md')
      const text=await readVerifiedSkillFile(client,entry,entry.uri)
      setStatus('PASS verified skill: '+text)
    }catch(e){setStatus(tampered?'PASS rejected tampered skill: '+String(e):'FAIL '+String(e))}
  }
  return <main><h2>Interactive MCP fixture</h2>
    <button onClick={()=>{void call('clarify')}}>Request clarification</button>
    <button onClick={()=>{void call('job')}}>Start durable task</button>
    <button onClick={()=>{manager.disconnectAll();void manager.refresh(settings).then(()=>manager.ensureConnected('interactive')).then(()=>setStatus('Reconnected; saved tasks retained'))}}>Reconnect manager</button>
    <button onClick={()=>{void skill()}}>Verify skill</button><button onClick={()=>{void skill(true)}}>Reject tampered skill</button>
    <p role="status">{status}</p><McpInteractions/></main>
}
export async function mountInteractions() {
  await manager.refresh(settings);await manager.ensureConnected('interactive')
  const root=document.createElement('div');document.body.append(root);createRoot(root).render(<Fixture/>)
}
