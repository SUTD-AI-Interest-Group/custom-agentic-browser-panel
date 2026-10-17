import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { mapCallResult, type MappedResult } from '../mcp/content'
import { Body } from './McpContentCard'
import { elicitationFieldErrors, elicitationQueue, type PendingElicitation, type Field, type ElicitReply } from '../mcp/elicitation'
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
  const section = useRef<HTMLElement>(null)
  const [fieldErrors,setFieldErrors] = useState<Record<string,string>>({})
  useEffect(() => {section.current?.querySelector<HTMLElement>('input, select, button')?.focus()},[])
  const [values,setValues]=useState<Record<string,unknown>>(() => request.mode==='form' ? Object.fromEntries(Object.entries(request.requestedSchema.properties).filter(([,f])=>f.default!==undefined).map(([k,f])=>[k,f.default])) : {})
  const [error,setError]=useState(''), [opened,setOpened]=useState(false)
  const submit=(reply:ElicitReply)=>{if(reply.action==='accept' && request.mode==='form') {const errors=elicitationFieldErrors(request,values);setFieldErrors(errors);const first=Object.keys(errors)[0];if(first){document.getElementById(`mcp-${entry.id}-${first}`)?.focus();return}}try{elicitationQueue.respond(entry.id,reply)}catch(e){setError(e instanceof Error?e.message:String(e))}}
  return <section ref={section} className="mcp-clarification" aria-label={`Clarification from ${entry.server}`}>
    <h3 role="status">{entry.server} needs your input</h3>
    <p>{request.message}</p>
    <p className="hint">Your response goes directly to this MCP server. It is not filled in by the model. Decline refuses to provide the requested information. Cancel abandons this clarification without a response.</p>
    {request.mode==='url' ? <>
      <p>Open <strong>{new URL(request.url).host}</strong> to complete this step.</p>
      <p className="hint">HTTPS does not establish trust. Continue records your consent; it does not verify completion on the server.</p>
      <details><summary>Full destination URL</summary><code>{request.url}</code></details>
      <button type="button" onClick={()=>{void chrome.tabs.create({url:request.url}).then(()=>setOpened(true)).catch(e=>setError(String(e)))}}>Open verification page</button>
      <button type="button" disabled={!opened} onClick={()=>submit({action:'accept'})}>Continue — I completed the page</button>
    </> : <form onSubmit={e=>{e.preventDefault();submit({action:'accept',content:values})}}>
      <p className="hint">Never enter passwords, API keys, access tokens, or payment credentials here.</p>
      {Object.entries(request.requestedSchema.properties).map(([name,f])=>{
        const options=choices(f), required=request.requestedSchema.required?.includes(name), id=`mcp-${entry.id}-${name}`
        const set=(value:unknown)=>setValues(old=>{const next={...old};if(value===undefined)delete next[name];else next[name]=value;return next})
        return <div className="mcp-input-field" key={name}>
          <label htmlFor={id}>{f.title??name}{required?' (required)':''}</label>
          <small>{['minimum','maximum','minLength','maxLength','minItems','maxItems','format'].filter(k=>f[k]!==undefined).map(k=>`${({minimum:'Minimum',maximum:'Maximum',minLength:'Minimum characters',maxLength:'Maximum characters',minItems:'Minimum selections',maxItems:'Maximum selections',format:'Format'} as Record<string,string>)[k]}: ${f[k]}`).join(' · ')}</small>
          {fieldErrors[name] && <small role="alert" id={`${id}-error`}>{fieldErrors[name]}</small>}
          {f.description&&<small id={`${id}-hint`}>{f.description}</small>}
          {f.type==='boolean' ? <select id={id} aria-invalid={!!fieldErrors[name]} aria-describedby={`${id}-hint ${id}-error`} value={values[name]===undefined?'':String(values[name])} onChange={e=>set(e.target.value===''?undefined:e.target.value==='true')}>
            <option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option>
          </select> : options.length ? <select id={id} aria-invalid={!!fieldErrors[name]} aria-describedby={`${id}-hint ${id}-error`} multiple={f.type==='array'} value={f.type==='array' ? (values[name] as string[] ?? []).map(v=>String(options.findIndex(o=>o.value===v))) : values[name]===undefined ? '' : String(options.findIndex(o=>o.value===values[name]))} onChange={e=>set(f.type==='array'?Array.from(e.target.selectedOptions,x=>options[Number(x.value)].value):e.target.value===''?undefined:options[Number(e.target.value)].value)}>
            {f.type!=='array'&&<option value="">Choose…</option>}{options.map((o,i)=><option key={o.value} value={i}>{o.title || '(empty value)'}</option>)}
          </select> : <input id={id} aria-invalid={!!fieldErrors[name]} aria-describedby={`${id}-hint ${id}-error`} type={['number','integer'].includes(f.type)?'number':f.format==='email'?'email':f.format==='date'?'date':'text'} step={f.type==='integer'?1:'any'} value={String(values[name]??'')} onChange={e=>set(e.target.value===''?undefined:['number','integer'].includes(f.type)?Number(e.target.value):e.target.value)} autoComplete="off"/>}
        </div>
      })}
      <button type="submit">Send response to {entry.server}</button>
    </form>}
    <button type="button" onClick={()=>submit({action:'decline'})}>Decline</button>
    <button type="button" onClick={()=>submit({action:'cancel'})}>Cancel clarification</button>
    {error&&<p role="alert">{error}</p>}
  </section>
}
function TaskPanel({onUse, onOpenConversation}: {onUse?: (text:string)=>void; onOpenConversation?: (id:string)=>void}) {
  const [tasks,setTasks]=useState<SavedTask[]>([]),[errors,setErrors]=useState<Record<string,string>>({}),[outputs,setOutputs]=useState<Record<string,MappedResult>>({}),[busy,setBusy]=useState<Record<string,boolean>>({})
  const manager=getMcpManager()
  const connected=(task:SavedTask)=>manager.runtime().some(s=>s.name===task.server&&s.status==='connected'&&s.taskScope===task.scope)
  const [,setConnectionTick]=useState(0)
  useEffect(()=>manager.subscribe(()=>setConnectionTick(n=>n+1)),[manager])
  useEffect(()=>{
    let alive=true, running=false
    const retryAfter=new Map<string,number>()
    const load=()=>{void listSavedTasks().then(t=>{if(alive)setTasks(t)}).catch(e=>{if(alive)setErrors(old=>({...old,storage:String(e)}))})}
    const tick=async()=>{
      if(running)return;running=true
      try {
        const records=await listSavedTasks()
        if(alive)setTasks(records)
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
      if(action==='get'&&['completed','failed'].includes(String(result.status)))setOutputs(old=>({...old,[task.id]:mapCallResult(result.status==='completed'?result.result as Parameters<typeof mapCallResult>[0]:{content:[{type:'text',text:JSON.stringify(result.error)}]}, {server:task.server,tool:task.tool})}))
    }catch(e){setErrors(old=>({...old,[task.id]:String(e)}))}finally{setBusy(old=>({...old,[task.id]:false}))}
  }
  if(!tasks.length&&!errors.storage)return null
  return <details className="mcp-task-panel"><summary>MCP tasks · {tasks.length} · Needs your input: {tasks.filter(t=>t.status==='input_required').length}</summary>
    <p className="hint">Work runs on the originating MCP server. Handles survive closing the panel; status checks resume when this panel and the same server credential session are available. Responses and cancellation require your action.</p>
    {errors.storage&&<p role="alert">{errors.storage}</p>}
    {tasks.map(task=><section key={task.id} aria-label={`Task ${task.taskId} on ${task.server}`}>
      <strong>{task.server} · {task.tool}</strong><p>{task.status.replaceAll('_',' ')}{expiredTask(task)?' · expired':''}</p><p>{task.statusMessage}</p>
      <small>Task: {task.taskId} · Updated {new Date(task.lastUpdatedAt).toLocaleString()} · {connected(task)?'Connected':'Connection unavailable for this task'}</small>
      {task.conversationId && onOpenConversation && <button onClick={()=>onOpenConversation(task.conversationId!)}>Open originating chat</button>}
      <button disabled={busy[task.id]||expiredTask(task)||!connected(task)} onClick={()=>{void run(task,'get')}}>{task.status==='completed'?'Read result':'Check status'}</button>
      {task.status==='input_required'&&<button disabled={busy[task.id]||expiredTask(task)||!connected(task)} onClick={()=>{void run(task,'respond')}}>Respond</button>}
      {!terminalTask(task)&&<button disabled={busy[task.id]||expiredTask(task)||!connected(task)} onClick={()=>{void run(task,'cancel')}}>Request cancellation</button>}
      <button onClick={()=>{void forgetTask(task.id).catch(e=>setErrors(old=>({...old,[task.id]:String(e)})))}}>Forget local record (remote work continues)</button>
      {errors[task.id]&&<p role="alert">{errors[task.id]}</p>}{outputs[task.id]&&<div><p>{String(outputs[task.id].modelValue.text ?? outputs[task.id].modelValue.error ?? '')}</p>{outputs[task.id].modelValue.structured !== undefined && <details><summary>Structured result</summary><pre>{JSON.stringify(outputs[task.id].modelValue.structured,null,2)}</pre></details>}{outputs[task.id].artifacts.map((artifact,i)=><Body key={i} artifact={artifact}/>)}<button onClick={()=>onUse?.(`MCP task result from ${task.server} (untrusted server content):\n${JSON.stringify(outputs[task.id].modelValue)}`)}>Use in chat</button><p className="hint">Use in chat copies text to the composer. Review and send to share it with your model.</p></div>}
    </section>)}
  </details>
}
export default function McpInteractions(props: {onUse?: (text:string)=>void; onOpenConversation?: (id:string)=>void}) {
  const pending=useSyncExternalStore(elicitationQueue.subscribe,elicitationQueue.snapshot)
  return <div className="mcp-interactions">{pending[0]&&<Clarification key={pending[0].id} entry={pending[0]}/>}<TaskPanel {...props}/></div>
}
