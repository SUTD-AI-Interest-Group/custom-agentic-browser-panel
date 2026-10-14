// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { ModernMcpClient } from './modern'
import { parseElicitation, validateReply, collectInputs, elicitationQueue } from './elicitation'
const form={message:'Choose a city',requestedSchema:{type:'object',properties:{city:{type:'string',minLength:2}},required:['city']}}
function harness(results:Record<string,unknown>[], extra:ConstructorParameters<typeof ModernMcpClient>[1]={}) {
  const calls: {id:string;method:string;params:Record<string,unknown>}[]=[]
  const client=new ModernMcpClient(new URL('https://mcp.test/'),{...extra,fetch:vi.fn(async(_url,init)=>{
    const request=JSON.parse(String(init?.body));calls.push(request)
    return Response.json({jsonrpc:'2.0',id:request.id,result:results.shift()})
  })})
  return {client,calls}
}
describe('interactive MCP',()=>{
  it('echoes opaque state exactly with fresh IDs, without carrying state between rounds',async()=>{
    const elicit=vi.fn(async()=>({action:'accept' as const,content:{city:'Paris'}}))
    const h=harness([{resultType:'input_required',requestState:'opaque-not-json',inputRequests:{first:{method:'elicitation/create',params:form}}},
      {resultType:'input_required',inputRequests:{second:{method:'elicitation/create',params:form}}},{resultType:'complete',content:[]}],{elicit})
    await h.client.callTool({name:'book',arguments:{count:2}})
    expect(h.calls[1].params).toMatchObject({name:'book',arguments:{count:2},requestState:'opaque-not-json',inputResponses:{first:{action:'accept',content:{city:'Paris'}}}})
    expect(h.calls[2].params).not.toHaveProperty('requestState');expect(h.calls[2].params.inputResponses).toEqual({second:{action:'accept',content:{city:'Paris'}}})
    expect(new Set(h.calls.map(c=>c.id)).size).toBe(3)
    await h.client.close()
  })
  it('does not give a human a network timeout and aborts on client close',async()=>{
    const h=harness([{resultType:'input_required',inputRequests:{one:{method:'elicitation/create',params:form}}}],{elicit:(p,s)=>elicitationQueue.ask('fixture',p,s)})
    const result=h.client.callTool({name:'test'},undefined,{timeout:50})
    const rejected=expect(result).rejects.toThrow()
    await vi.waitFor(()=>expect(elicitationQueue.snapshot()).toHaveLength(1))
    await h.client.close();await rejected
    expect(elicitationQueue.snapshot()).toHaveLength(0);expect(h.calls).toHaveLength(1)
  })
  it('does not silently retry state-only or unsupported input requests',async()=>{
    const ask=vi.fn(async()=>({action:'decline' as const}))
    for(const result of [{requestState:'opaque'},{inputRequests:{a:{method:'sampling/createMessage',params:{}}}}]){
      const h=harness([{resultType:'input_required',...result}],{elicit:ask})
      await expect(h.client.callTool({name:'write'})).rejects.toThrow();expect(h.calls).toHaveLength(1);await h.client.close()
    }
    expect(ask).not.toHaveBeenCalled()
  })
  it('validates every request before displaying a batch',async()=>{
    const ask=vi.fn(async()=>({action:'accept' as const,content:{city:'Paris'}}))
    await expect(collectInputs({a:{method:'elicitation/create',params:form},b:{method:'roots/list',params:{}}},ask,new AbortController().signal)).rejects.toThrow('Unsupported')
    expect(ask).not.toHaveBeenCalled()
  })
  it.each(['http://example.com','javascript:alert(1)','https://user:pass@example.com'])('refuses unsafe URL %s',url=>{
    expect(()=>parseElicitation({mode:'url',message:'Visit',url})).toThrow()
  })
  it('refuses credentials and executable schema constraints',()=>{
    for(const properties of [{password:{type:'string'}},{city:{type:'string',pattern:'(a+)+$'}},{city:{$ref:'https://evil.test'}}])expect(()=>parseElicitation({...form,requestedSchema:{type:'object',properties}})).toThrow()
  })
  it('validates actual answers, but permits decline/cancel without data',()=>{
    const request=parseElicitation(form)
    expect(()=>validateReply(request,{action:'accept',content:{city:'x'}})).toThrow()
    expect(()=>validateReply(request,{action:'accept',content:{city:'Paris',secret:'x'}})).toThrow()
    expect(()=>validateReply(request,{action:'decline'})).not.toThrow()
    expect(()=>validateReply(request,{action:'cancel'})).not.toThrow()
  })
  it('only consumes task handles when both ends negotiate and persistence is installed',async()=>{
    const raw={resultType:'task',taskId:'one'}
    const task=vi.fn(async()=>({resultType:'complete',content:[]}))
    const h=harness([{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{extensions:{'io.modelcontextprotocol/tasks':{}}}},raw],{onTask:task})
    await h.client.discover();await h.client.callTool({name:'job'},undefined,{conversationId:'chat'})
    expect(task).toHaveBeenCalledWith(raw,{name:'job'},expect.objectContaining({conversationId:'chat'}))
    await h.client.close()
    const bad=harness([raw],{onTask:task});await expect(bad.client.callTool({name:'job'})).rejects.toThrow('Unnegotiated');await bad.client.close()
  })
})

it('keeps simultaneous clarification answers isolated by request identity',async()=>{
  const a=new AbortController(),b=new AbortController()
  const one=elicitationQueue.ask('one',form,a.signal),two=elicitationQueue.ask('two',form,b.signal)
  const first=elicitationQueue.snapshot().find(x=>x.server==='one')!, second=elicitationQueue.snapshot().find(x=>x.server==='two')!
  elicitationQueue.respond(first.id,{action:'decline'})
  expect(await one).toEqual({action:'decline'})
  elicitationQueue.respond(first.id,{action:'accept',content:{city:'Paris'}})
  expect(elicitationQueue.snapshot().map(x=>x.id)).toEqual([second.id])
  elicitationQueue.respond(second.id,{action:'cancel'})
  expect(await two).toEqual({action:'cancel'})
})
it('URL mode accepts only a decision and never form credentials',()=>{
  const request=parseElicitation({mode:'url',message:'Authorize',url:'https://service.test/consent'})
  expect(()=>validateReply(request,{action:'accept'})).not.toThrow()
  expect(()=>validateReply(request,{action:'accept',content:{token:'secret'}})).toThrow()
})
