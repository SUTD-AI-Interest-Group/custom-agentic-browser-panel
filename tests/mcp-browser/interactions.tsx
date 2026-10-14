import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import McpInteractions from '../../src/ui/McpInteractions'
import { getMcpManager } from '../../src/mcp/manager'
import { getRemoteSkill, readVerifiedSkillFile, SKILLS_EXTENSION } from '../../src/mcp/skills'
import { defaultSettings, type Settings } from '../../src/data/settings'
import Onboarding from '../../src/ui/Onboarding'
import DataTab from '../../src/ui/settings/DataTab'
import { listSavedTasks, clearMcpTasks, saveTask, taskStorageEpoch } from '../../src/mcp/tasks'
const manager=getMcpManager()
const settings={mcp:{servers:{interactive:{url:`${location.origin}/interactive`}}}} as unknown as Settings
function Fixture() {
  const [screen,setScreen]=useState<'checks'|'onboarding'|'data'>('checks')
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
  if(screen==='onboarding')return <main><Onboarding settings={defaultSettings()} onComplete={next=>{setStatus(`PASS onboarding: ${next.providers.at(-1)?.name}; ${next.selected?.modelId}`);setScreen('checks')}}/></main>
  if(screen==='data')return <main><p>Disposable fixture origin only. No extension profile data is accessible here.</p><DataTab draft={defaultSettings()} commit={()=>{}} onErased={()=>{void listSavedTasks().then(tasks=>{setStatus(tasks.length?'FAIL tasks survived erasure':'PASS full erasure: no task records remain');setScreen('checks')})}}/></main>
  return <main><h2>Interactive MCP fixture</h2>
    <button onClick={()=>setScreen('onboarding')}>Test fresh onboarding</button><button onClick={()=>setScreen('data')}>Open disposable Data settings</button>
    <button onClick={()=>{void (async()=>{const task=(await listSavedTasks())[0];if(!task){setStatus('Start a task first');return}const epoch=await taskStorageEpoch();await clearMcpTasks();try{await saveTask(task,epoch);setStatus('FAIL delayed write survived')}catch{setStatus((await listSavedTasks()).length?'FAIL erased tasks returned':'PASS delayed write rejected after erasure')}})()}}>Test erasure race</button>
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
