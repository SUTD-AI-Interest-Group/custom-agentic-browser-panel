import {describe,it,expect,vi} from 'vitest'
import {prepareRequest,canAttachPage} from './requestPreparation'
describe('request preparation',()=>{
  it('bounds a stalled dependency and consumes late rejection',async()=>{
    vi.useFakeTimers()
    let reject!: (error:Error)=>void
    const work=new Promise<void>((_,r)=>{reject=r})
    const result=prepareRequest(work,new AbortController().signal,'page context',100)
    const assertion=expect(result).rejects.toThrow('page context')
    await vi.advanceTimersByTimeAsync(101);await assertion
    reject(Error('late failure'));await Promise.resolve();vi.useRealTimers()
  })
  it('aborts immediately and never adopts a late result',async()=>{
    const controller=new AbortController()
    const result=prepareRequest(new Promise(()=>{}),controller.signal,'skills')
    controller.abort();await expect(result).rejects.toThrow('cancelled')
  })
  it('does not autoattach restricted browser pages',()=>{
    for(const url of ['chrome://settings','chrome-extension://id/page','https://chromewebstore.google.com/detail/a'])expect(canAttachPage(url)).toBe(false)
    expect(canAttachPage('http://localhost:55626')).toBe(true)
  })
})

it('reports only the preparation stage when a dependency rejects',async()=>{
  const error=await prepareRequest(Promise.reject(Error('private dependency payload')),new AbortController().signal,'memory').catch(e=>e)
  expect(error.message).toContain('memory');expect(error.message).not.toContain('private dependency payload')
})
