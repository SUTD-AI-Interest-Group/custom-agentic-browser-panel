import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest'
class MockWorker {
  static instances: MockWorker[] = []
  onmessage?: (event: {data: unknown}) => void
  onerror?: () => void
  postMessage=vi.fn()
  terminate=vi.fn()
  constructor(){MockWorker.instances.push(this)}
}
let changed: (changes: any, area: string) => void
beforeEach(()=>{
 vi.resetModules();vi.useFakeTimers();MockWorker.instances=[]
 vi.stubGlobal('Worker',MockWorker)
 vi.stubGlobal('chrome',{runtime:{getURL:(x:string)=>`chrome-extension://test/${x}`},storage:{onChanged:{addListener:(fn:typeof changed)=>{changed=fn}}}})
})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
describe('Mirage worker lifecycle',()=>{
 it('is lazy, rejects concurrent work, reuses the worker and releases it when idle',async()=>{
  const {describeMirage}=await import('./mirageEngine')
  expect(MockWorker.instances).toHaveLength(0)
  const first=describeMirage('data:image/png;base64,AA==')
  await expect(describeMirage('data:image/png;base64,AA==')).rejects.toThrow('busy')
  const worker=MockWorker.instances[0], id=worker.postMessage.mock.calls[0][0].id
  worker.onmessage!({data:{id,value:{result:{text:[]}}}})
  await expect(first).resolves.toMatchObject({result:{text:[]}})
  const second=describeMirage('data:image/png;base64,AA==')
  expect(MockWorker.instances).toHaveLength(1)
  worker.onmessage!({data:{id:worker.postMessage.mock.calls[1][0].id,value:{result:{text:[]}}}})
  await second
  await vi.advanceTimersByTimeAsync(60_000)
  expect(worker.terminate).toHaveBeenCalledOnce()
 })
 it('terminates a wedged worker on deadline, then permits a fresh attempt',async()=>{
  const {describeMirage,disposeMirage}=await import('./mirageEngine')
  const failed=expect(describeMirage('data:image/png;base64,AA==')).rejects.toThrow('stopped')
  await vi.advanceTimersByTimeAsync(30_000);await failed
  expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce()
  const retry=expect(describeMirage('data:image/png;base64,AA==')).rejects.toThrow('stopped')
  expect(MockWorker.instances).toHaveLength(2)
  // A queued error from the terminated instance cannot cancel its replacement.
  MockWorker.instances[0].onerror!()
  expect(MockWorker.instances[1].terminate).not.toHaveBeenCalled()
  disposeMirage();await retry
 })
 it('rejects on worker errors and mode changes, ignoring stale replies',async()=>{
  const {describeMirage}=await import('./mirageEngine')
  const failed=expect(describeMirage('data:image/png;base64,AA==')).rejects.toThrow('stopped')
  MockWorker.instances[0].onerror!();await failed
  const revoked=expect(describeMirage('data:image/png;base64,AA==')).rejects.toThrow('stopped')
  changed({settings:{oldValue:{mirageMode:'assist'},newValue:{mirageMode:'off'}}},'local')
  await revoked
  expect(MockWorker.instances[1].terminate).toHaveBeenCalledOnce()
  MockWorker.instances[1].onmessage!({data:{id:2,value:{result:{text:['stale']}}}})
 })
 it('serializes perception and the separate fixed visual classifier on one worker',async()=>{
  const {describeMirage,classifyMirage,disposeMirage}=await import('./mirageEngine')
  const image='data:image/png;base64,AA=='
  const perception=describeMirage(image), worker=MockWorker.instances[0]
  expect(worker.postMessage.mock.calls[0][0]).toMatchObject({dataUrl:image,decision:false})
  await expect(classifyMirage(image)).rejects.toThrow('busy')
  worker.onmessage!({data:{id:worker.postMessage.mock.calls[0][0].id,value:{result:{text:[]}}}})
  await perception
  const decision=classifyMirage(image)
  expect(MockWorker.instances).toHaveLength(1)
  expect(worker.postMessage.mock.calls[1][0]).toMatchObject({dataUrl:image,decision:true})
  const result={form:{screen_type:{value:null,probabilities:{dialog:.1,form:.1,document:.1,other:.1,'-':.6}}}}
  worker.onmessage!({data:{id:worker.postMessage.mock.calls[1][0].id,value:{result}}})
  await expect(decision).resolves.toMatchObject({result})
  disposeMirage()
 })
 it('revokes in-flight classification when decision consent changes',async()=>{
  const {classifyMirage}=await import('./mirageEngine')
  const revoked=expect(classifyMirage('data:image/png;base64,AA==')).rejects.toThrow('stopped')
  changed({settings:{oldValue:{mirageMode:'assist',mirageDecisionMode:'assist'},newValue:{mirageMode:'assist',mirageDecisionMode:'off'}}},'local')
  await revoked
  expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce()
 })
 it('rejects remote or oversized images before creating a worker',async()=>{
  const {describeMirage}=await import('./mirageEngine')
  await expect(describeMirage('https://example.com/private.png')).rejects.toThrow('Unsupported')
  await expect(describeMirage('data:image/png;base64,'+'A'.repeat(24*1024*1024))).rejects.toThrow('Unsupported')
  expect(MockWorker.instances).toHaveLength(0)
 })
})
