import {createElement, act} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import type {Settings} from '../data/settings'
import {elicitationQueue} from '../mcp/elicitation'
vi.mock('../mcp/manager',()=>{const manager={runtime:()=>[],subscribe:()=>()=>{},isTaskBusy:()=>false};return {getMcpManager:()=>manager}})
vi.mock('../mcp/tasks',()=>({listSavedTasks:async()=>[],subscribeTasks:()=>()=>{},expiredTask:()=>false,terminalTask:()=>false}))
vi.mock('../data/storage',()=>({storageReport:async()=>({total:0,quota:null,stores:Object.fromEntries(['conversations','screenshots','attachments','mcp','mcpTasks','artifacts','memory','skills','research','traces'].map(k=>[k,{count:1,bytes:1}]))}),clearStore:vi.fn(),eraseAllData:vi.fn()}))
vi.mock('./settings/SealedChip',()=>({SealedChip:()=>null}))
import McpInteractions from './McpInteractions'
import DataTab from './settings/DataTab'
import {eraseAllData, clearStore} from '../data/storage'
let root:Root,host:HTMLDivElement,controller:AbortController
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);controller=new AbortController()})
afterEach(async()=>{await act(async()=>{controller.abort();root.unmount()});host.remove();vi.unstubAllGlobals()})
const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!
it('focuses missing fields and submits an explicitly selected empty-string enum',async()=>{
  let response:unknown
  const pending=elicitationQueue.ask('test',{message:'Choose a label',requestedSchema:{type:'object',properties:{label:{type:'string',enum:['','a']}},required:['label']}},controller.signal).then(r=>{response=r}).catch(()=>{})
  await act(async()=>root.render(createElement(McpInteractions)))
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(host.textContent).toContain('This field is required')
  const select=host.querySelector('select')!;expect(document.activeElement).toBe(select)
  await act(async()=>{select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}))})
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(elicitationQueue.snapshot()).toHaveLength(0);await pending;expect(response).toEqual({action:'accept',content:{label:''}})
})
it('does not report successful erasure or leave Data when storage fails',async()=>{
  vi.mocked(eraseAllData).mockRejectedValueOnce(Error('blocked'))
  const onErased=vi.fn()
  await act(async()=>root.render(createElement(DataTab,{draft:{} as Settings,commit:vi.fn(),onErased})))
  // Dispatch using the native setter so React sees an actual edit.
  const input=host.querySelector('input')!
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'erase');input.dispatchEvent(new Event('input',{bubbles:true}))})
  await act(async()=>button('Erase').click())
  expect(onErased).not.toHaveBeenCalled();expect(host.textContent).toContain('Erasure did not finish')
  expect(button('Erase').disabled).toBe(false)
})
it('keeps a clear failure visible and allows retry',async()=>{
  vi.mocked(clearStore).mockRejectedValueOnce(Error('blocked'))
  await act(async()=>root.render(createElement(DataTab,{draft:{} as Settings,commit:vi.fn(),onErased:vi.fn()})))
  await act(async()=>button('Clear').click());await act(async()=>button('Sure?').click())
  expect(host.textContent).toContain('Could not clear all selected data')
})
