import { useEffect, useState, useSyncExternalStore } from 'react'
import { elicitationQueue, type PendingElicitation, type Field, type ElicitReply } from '../mcp/elicitation'
import { getMcpManager } from '../mcp/manager'
import { expiredTask, forgetTask, listSavedTasks, subscribeTasks, terminalTask, type SavedTask } from '../mcp/tasks'
import './mcpInteractions.css'

function choices(field: Field): { value: string; title: string }[] {
  const schema = field.type === 'array' ? field.items : field
  if (!schema) return []
  if (schema.enum) return schema.enum.map(value => ({ value, title: value }))
  const variants = 'oneOf' in schema ? schema.oneOf : 'anyOf' in schema ? schema.anyOf : undefined
  return Array.isArray(variants) ? variants.map(x => ({ value: x.const, title: x.title ?? x.const })) : []
}
function Clarification({ entry }: { entry: PendingElicitation }) {
  const { request } = entry
  const [values,setValues]=useState<Record<string,unknown>>(() => request.mode==='form' ? Object.fromEntries(Object.entries(request.requestedSchema.properties).filter(([,f])=>f.default!==undefined).map(([k,f])=>[k,f.default])) : {})
  const [error,setError]=useState(''), [opened,setOpened]=useState(false)
  const submit=(reply:ElicitReply)=>{try{elicitationQueue.respond(entry.id,reply)}catch(e){setError(e instanceof Error?e.message:String(e))}}
  return <section className="mcp-clarification" aria-label={`Clarification from ${entry.server}`}>
    <h3>{entry.server} needs your input</h3>
    <p>{request.message}</p>
    <p className="hint">Your response goes directly to this MCP server. It is not filled in by the model. Decline or cancel if you do not trust this request.</p>
    {request.mode==='url' ? <>
      <p>Open <strong>{new URL(request.url).host}</strong> to complete this step.</p>
      <details><summary>Full destination URL</summary><code>{request.url}</code></details>
      <button type="button" onClick={()=>{void chrome.tabs.create({url:request.url}).then(()=>setOpened(true)).catch(e=>setError(String(e)))}}>Open secure page</button>
      <button type="button" disabled={!opened} onClick={()=>submit({action:'accept'})}>Continue after completing the page</button>
    </> : <form onSubmit={e=>{e.preventDefault();submit({action:'accept',content:values})}}>
      <p className="hint">Never enter passwords, API keys, access tokens, or payment credentials here.</p>
      {Object.entries(request.requestedSchema.properties).map(([name,f])=>{
        const options=choices(f), required=request.requestedSchema.required?.includes(name), id=`mcp-${entry.id}-${name}`
        const set=(value:unknown)=>setValues(old=>{const next={...old};if(value===undefined)delete next[name];else next[name]=value;return next})
        return <div className="mcp-input-field" key={name}>
          <label htmlFor={id}>{f.title??name}{required?' (required)':''}</label>
          {f.description&&<small id={`${id}-hint`}>{f.description}</small>}
          {f.type==='boolean' ? <select id={id} aria-describedby={`${id}-hint`} value={values[name]===undefined?'':String(values[name])} onChange={e=>set(e.target.value===''?undefined:e.target.value==='true')}>
            <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
          </select> : options.length ? <select id={id} aria-describedby={`${id}-hint`} multiple={f.type==='array'} value={(values[name]??(f.type==='array'?[]:'')) as string|string[]} onChange={e=>set(f.type==='array'?Array.from(e.target.selectedOptions,x=>x.value):e.target.value||undefined)}>
            {f.type!=='array'&&<option value="">Choose…</option>}{options.map(o=><option key={o.value} value={o.value}>{o.title}</option>)}
          </select> : <input id={id} aria-describedby={`${id}-hint`} type={['number','integer'].includes(f.type)?'number':f.format==='email'?'email':f.format==='date'?'date':'text'} step={f.type==='integer'?1:'any'} value={String(values[name]??'')} onChange={e=>set(e.target.value===''?undefined:['number','integer'].includes(f.type)?Number(e.target.value):e.target.value)} autoComplete="off"/>}
        </div>
      })}
      <button type="submit">Send response to {entry.server}</button>
    </form>}
    <button type="button" onClick={()=>submit({action:'decline'})}>Decline</button>
    <button type="button" onClick={()=>submit({action:'cancel'})}>Cancel clarification</button>
    {error&&<p role="alert">{error}</p>}
  </section>
}
function TaskPanel() {
  const [tasks,setTasks]=useState<SavedTask[]>([]),[errors,setErrors]=useState<Record<string,string>>({}),[outputs,setOutputs]=useState<Record<string,string>>({}),[busy,setBusy]=useState<Record<string,boolean>>({})
  const manager=getMcpManager()
  useEffect(()=>{
    let alive=true, running=false
    const retryAfter=new Map<string,number>()
    const load=()=>{void listSavedTasks().then(t=>{if(alive)setTasks(t)}).catch(e=>{if(alive)setErrors(old=>({...old,storage:String(e)}))})}
    const tick=async()=>{
      if(running)return;running=true
      try {
        const records=await listSavedTasks()
        for(const task of records) {
          if(!alive)break
          const server=manager.runtime().find(s=>s.name===task.server)
          if(manager.isTaskBusy(task.id)||terminalTask(task)||expiredTask(task)||server?.status!=='connected'||server.taskScope!==task.scope||task.nextPollAt>Date.now()||(retryAfter.get(task.id)??0)>Date.now())continue
          try { await manager.taskOperation(task.id,'get');retryAfter.delete(task.id);if(alive)setErrors(old=>({...old,[task.id]:''})) }
          catch(e){retryAfter.set(task.id,Date.now()+30_000);if(alive)setErrors(old=>({...old,[task.id]:String(e)}))}
        }
      }catch(e){if(alive)setErrors(old=>({...old,storage:String(e)}))}finally{running=false}
    }
    load(); const unsubscribe=subscribeTasks(load), timer=setInterval(()=>{void tick()},1000)
    return()=>{alive=false;clearInterval(timer);unsubscribe()}
  },[manager])
  const run=async(task:SavedTask,action:'get'|'cancel'|'respond')=>{
    setBusy(old=>({...old,[task.id]:true}));setErrors(old=>({...old,[task.id]:''}))
    try {
      const result=await manager.taskOperation(task.id,action)
      // Request data is never printed into the transcript or model context.
      if(action==='get'&&['completed','failed'].includes(String(result.status)))setOutputs(old=>({...old,[task.id]:JSON.stringify(result.status==='completed'?result.result:result.error,null,2).slice(0,32_000)}))
    }catch(e){setErrors(old=>({...old,[task.id]:String(e)}))}finally{setBusy(old=>({...old,[task.id]:false}))}
  }
  if(!tasks.length&&!errors.storage)return null
  return <details className="mcp-task-panel"><summary>MCP tasks · {tasks.length}</summary>
    <p className="hint">Work runs on the originating MCP server. Handles survive closing the panel; status checks resume when this panel and the same server credential session are available. Responses and cancellation require your action.</p>
    {errors.storage&&<p role="alert">{errors.storage}</p>}
    {tasks.map(task=><section key={task.id} aria-label={`Task ${task.taskId} on ${task.server}`}>
      <strong>{task.server} · {task.tool}</strong><p>{task.status}{expiredTask(task)?' · expired':''}</p><p>{task.statusMessage}</p>
      <small>Task: {task.taskId}</small>
      <button disabled={busy[task.id]||expiredTask(task)} onClick={()=>{void run(task,'get')}}>{task.status==='completed'?'Read result':'Check status'}</button>
      {task.status==='input_required'&&<button disabled={busy[task.id]||expiredTask(task)} onClick={()=>{void run(task,'respond')}}>Respond</button>}
      {!terminalTask(task)&&<button disabled={busy[task.id]||expiredTask(task)} onClick={()=>{void run(task,'cancel')}}>Request cancellation</button>}
      {(terminalTask(task)||expiredTask(task))&&<button onClick={()=>{void forgetTask(task.id).catch(e=>setErrors(old=>({...old,[task.id]:String(e)})))}}>Dismiss local record</button>}
      {errors[task.id]&&<p role="alert">{errors[task.id]}</p>}{outputs[task.id]&&<pre>{outputs[task.id]}</pre>}
    </section>)}
  </details>
}
export default function McpInteractions() {
  const pending=useSyncExternalStore(elicitationQueue.subscribe,elicitationQueue.snapshot)
  return <div className="mcp-interactions">{pending[0]&&<Clarification key={pending[0].id} entry={pending[0]}/>}<TaskPanel/></div>
}
