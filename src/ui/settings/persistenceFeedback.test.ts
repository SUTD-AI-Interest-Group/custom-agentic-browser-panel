import {createElement,act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {it,expect,vi,beforeEach,afterEach} from 'vitest'
import type {Settings} from '../../data/settings'
vi.mock('./GeneralTab',()=>({default:({commit,draft}:{commit:(s:Settings)=>void;draft:Settings})=>createElement('button',{onClick:()=>commit(draft)},'Change setting')}))
vi.mock('./ProvidersTab',()=>({default:()=>null}))
vi.mock('./PermissionsTab',()=>({default:()=>null}))
vi.mock('./MemoryTab',()=>({default:()=>null}))
vi.mock('./SkillsTab',()=>({default:()=>null}))
vi.mock('./DataTab',()=>({default:()=>null}))
vi.mock('./McpSection',()=>({default:()=>null}))
vi.mock('./normalizeSettings',()=>({normalizeSettings:(s:Settings)=>s}))
import SettingsView from './Settings'
let host:HTMLDivElement,root:Root
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('chrome',{runtime:{getManifest:()=>({version:'test'})}});host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()})
it('never flashes Saved while persistence is pending or rejected, and retry can succeed',async()=>{
  let reject!: (e:Error)=>void
  const onChange=vi.fn().mockImplementationOnce(()=>new Promise<void>((_,r)=>{reject=r})).mockResolvedValue(undefined)
  await act(async()=>root.render(createElement(SettingsView,{settings:{} as Settings,onChange,onOpenSkills:vi.fn(),onClose:vi.fn(),onErased:vi.fn()})))
  const change=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Change setting')!
  await act(async()=>change.click());expect(host.querySelector('.saved-pill.show')).toBeNull()
  await act(async()=>reject(Error('storage failed')))
  expect(host.querySelector('.saved-pill.show')).toBeNull();expect(host.textContent).toContain('Settings could not be saved')
  await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='Retry save')!.click())
  expect(host.querySelector('.saved-pill.show')).not.toBeNull()
})
it('moves tab focus with arrows and exposes the active tabpanel relationship',async()=>{
  await act(async()=>root.render(createElement(SettingsView,{settings:{} as Settings,onChange:vi.fn(),onOpenSkills:vi.fn(),onClose:vi.fn(),onErased:vi.fn()})))
  const tab=host.querySelector('[role=tab]')!;await act(async()=>tab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})))
  expect(document.activeElement?.textContent).toBe('Connections')
  expect(host.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(document.activeElement?.id)
})
