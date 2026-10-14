// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest'
import { McpManager } from './manager'
import { listSavedTasks,forgetTask,parseTask,saveTask,expiredTask,taskPollDelay } from './tasks'
import { elicitationQueue } from './elicitation'
import type { Settings } from '../data/settings'
vi.mock('./auth',()=>({ChromeOAuthProvider:class{async tokens(){return undefined}async sessionIdentity(){return undefined}},clearAuth:vi.fn(async()=>{})}))
const config={mcp:{servers:{srv:{url:'https://mcp.test/'}}}} as unknown as Settings
const base={taskId:'one',status:'working',createdAt:new Date().toISOString(),lastUpdatedAt:new Date().toISOString(),ttlMs:60000,pollIntervalMs:2000}
let state:Record<string,unknown>, calls:{method:string;params:Record<string,unknown>}[], managers:McpManager[]
async function connect(){const manager=new McpManager();managers.push(manager);await manager.refresh(config);await manager.ensureConnected('srv');return manager}
beforeEach(async()=>{
  for(const task of await listSavedTasks())await forgetTask(task.id)
  managers=[];calls=[];state={...base}
  vi.stubGlobal('chrome',{storage:{local:{get:async()=>({}),set:async()=>{}}}})
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
    const rpc=JSON.parse(init.body);calls.push(rpc)
    let data:Record<string,unknown>={}
    if(rpc.method==='server/discover')data={supportedVersions:['2026-07-28'],capabilities:{tools:{},extensions:{'io.modelcontextprotocol/tasks':{}}}}
    else if(rpc.method==='tools/list')data={tools:[]}
    else if(rpc.method==='tools/call')data={...base,resultType:'task'}
    else if(rpc.method==='tasks/get')data=state
    else if(rpc.method==='tasks/update') {state={...base,status:'completed',result:{content:[{type:'text',text:'done'}]}}}
    return Response.json({jsonrpc:'2.0',id:rpc.id,result:{resultType:'complete',...data}})
  }))
})
afterEach(()=>{for(const manager of managers)manager.disconnectAll();vi.unstubAllGlobals()})
describe('durable task manager',()=>{
  it('persists a handle and retrieves its result after manager recreation without replaying the tool',async()=>{
    const first=await connect();await first.callTool('srv','job',{}, {conversationId:'chat-a'})
    const saved=(await listSavedTasks())[0];expect(saved.conversationId).toBe('chat-a');expect(saved).not.toHaveProperty('result')
    first.disconnectAll();const second=await connect()
    state={...base,status:'completed',result:{content:[{type:'text',text:'done'}]}}
    expect((await second.taskOperation(saved.id,'get')).status).toBe('completed')
    expect(calls.filter(c=>c.method==='tools/call')).toHaveLength(1)
    expect((await listSavedTasks())[0]).not.toHaveProperty('result')
  })
  it('rejects a handle under a changed endpoint/session before fetching it',async()=>{
    const manager=await connect();await manager.callTool('srv','job',{})
    const saved=(await listSavedTasks())[0];await saveTask({...saved,scope:'different'})
    await expect(manager.taskOperation(saved.id,'get')).rejects.toThrow('different')
    expect(calls.some(c=>c.method==='tasks/get')).toBe(false)
  })
  it('does not mark cancellation acknowledged as cancelled',async()=>{
    const manager=await connect();await manager.callTool('srv','job',{})
    const saved=(await listSavedTasks())[0]
    expect((await manager.taskOperation(saved.id,'cancel')).status).toBe('working')
    expect((await listSavedTasks())[0].status).toBe('working')
  })
  it('requires actual user response for task input and never persists the answer',async()=>{
    const manager=await connect();await manager.callTool('srv','job',{})
    const saved=(await listSavedTasks())[0]
    state={...base,status:'input_required',inputRequests:{q:{method:'elicitation/create',params:{message:'Confirm',requestedSchema:{type:'object',properties:{yes:{type:'boolean'}},required:['yes']}}}}}
    await manager.taskOperation(saved.id,'get');expect(elicitationQueue.snapshot()).toHaveLength(0)
    const response=manager.taskOperation(saved.id,'respond')
    await vi.waitFor(()=>expect(elicitationQueue.snapshot()).toHaveLength(1))
    elicitationQueue.respond(elicitationQueue.snapshot()[0].id,{action:'accept',content:{yes:true}})
    expect((await response).status).toBe('completed')
    expect(calls.find(c=>c.method==='tasks/update')?.params.inputResponses).toEqual({q:{action:'accept',content:{yes:true}}})
    expect((await listSavedTasks())[0]).not.toHaveProperty('inputRequests')
  })
  it('rejects malformed/mismatched tasks and recognizes TTL',()=>{
    expect(()=>parseTask({...base,ttlMs:-1})).toThrow()
    expect(()=>parseTask(base,'other')).toThrow()
    expect(()=>parseTask({...base,status:'completed'},'one',true)).toThrow()
    expect(expiredTask({...parseTask(base),ttlMs:0})).toBe(true)
    expect(taskPollDelay({...parseTask(base),pollIntervalMs:50000})).toBe(50000)
  })
})

it('revoking task response policy while clarification is open prevents sending answers',async()=>{
  const manager=await connect();await manager.callTool('srv','job',{})
  const saved=(await listSavedTasks())[0]
  state={...base,status:'input_required',inputRequests:{q:{method:'elicitation/create',params:{message:'Confirm',requestedSchema:{type:'object',properties:{yes:{type:'boolean'}}}}}}}
  const response=manager.taskOperation(saved.id,'respond')
  const rejected=expect(response).rejects.toThrow()
  await vi.waitFor(()=>expect(elicitationQueue.snapshot()).toHaveLength(1))
  await manager.refresh({...config,mcp:{...config.mcp!,policies:{srv:{tools:{'tasks/update':'never'}}}}})
  await rejected
  expect(elicitationQueue.snapshot()).toHaveLength(0)
  expect(calls.some(c=>c.method==='tasks/update')).toBe(false)
})
it('expiry prevents task network operations',async()=>{
  const manager=await connect();await manager.callTool('srv','job',{})
  const saved=(await listSavedTasks())[0];await saveTask({...saved,ttlMs:0})
  await expect(manager.taskOperation(saved.id,'cancel')).rejects.toThrow('expired')
  expect(calls.some(c=>c.method.startsWith('tasks/'))).toBe(false)
})

it('does not send a clarification answer after task TTL expires',async()=>{
  const manager=await connect();await manager.callTool('srv','job',{})
  const saved=(await listSavedTasks())[0]
  state={...base,status:'input_required',inputRequests:{q:{method:'elicitation/create',params:{message:'Confirm',requestedSchema:{type:'object',properties:{yes:{type:'boolean'}}}}}}}
  const response=manager.taskOperation(saved.id,'respond')
  const rejected=expect(response).rejects.toThrow('expired')
  await vi.waitFor(()=>expect(elicitationQueue.snapshot()).toHaveLength(1))
  const now=vi.spyOn(Date,'now').mockReturnValue(Date.parse(saved.createdAt)+60001)
  try {
    elicitationQueue.respond(elicitationQueue.snapshot()[0].id,{action:'accept',content:{yes:true}})
    await rejected
    expect(calls.some(c=>c.method==='tasks/update')).toBe(false)
  } finally {now.mockRestore()}
})
