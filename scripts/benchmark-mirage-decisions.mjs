// Real image-form inference; Node/V8 WASM. No browser, planner, or tool execution.
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import vm from 'node:vm'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
const root=fileURLToPath(new URL('../',import.meta.url))
const rounds=Number(process.env.MIRAGE_ROUNDS??3)
if(!Number.isInteger(rounds)||rounds<1)throw new Error('MIRAGE_ROUNDS must be a positive integer')
const compiled=await build({entryPoints:[root+'src/platform/miragePerception.ts'],bundle:true,platform:'node',write:false,format:'esm',plugins:[{name:'replay-real-results',setup(build){build.onLoad({filter:/mirageEngine\.ts$/},()=>({contents:'export async function describeMirage(){return globalThis.__mirageReplay.perception} export async function classifyMirage(){return globalThis.__mirageReplay.decision} export function disposeMirage(){}',loader:'js'}))}}]})
const {perceiveApprovedScreenshot}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))
let decisionMode='off'
globalThis.chrome={storage:{local:{get:async()=>({settings:{mirageMode:'assist',mirageDecisionMode:decisionMode}})}}}
const corpus=JSON.parse(execFileSync('python3',[root+'scripts/mirage-decision-fixtures.py'],{maxBuffer:40*1024*1024}))
const context={require:createRequire(import.meta.url),__dirname:root+'public/mirage',__filename:root+'public/mirage/cactus.js',module:{exports:{}},exports:{},process,console,Buffer,TextDecoder,TextEncoder,WebAssembly,setTimeout,clearTimeout,performance}
vm.runInNewContext(await readFile(root+'public/mirage/cactus.js','utf8'),context)
const start=performance.now(),m=await context.module.exports({wasmBinary:await readFile(root+'public/mirage/cactus.wasm')})
const weights=await readFile(root+'public/mirage/mirage.cact'),ptr=m._malloc(weights.length);m.HEAPU8.set(weights,ptr)
if(m._cactus_load(ptr,BigInt(weights.length))<0)throw new Error(m.UTF8ToString(m._cactus_last_error()))
m._free(ptr);const loadMs=performance.now()-start
const labels=['dialog','form','document','other']
const perceptionOptions={sections:['objects','text'],fields:['bbox','score'],max_objects:24,max_text_lines:48,max_tokens:192,conf:.5,text_conf:.5}
function infer(fixture,options){
 const rgb=Buffer.from(fixture.rgb,'base64'),input=m._malloc(rgb.length),out=m._malloc(1024*1024)
 m.HEAPU8.set(rgb,input);m.HEAPU8[out]=0
 const start=performance.now()
 try{
  const code=m.ccall('cactus_describe','number',['number','number','number','string','number','number','number','number'],[input,fixture.width,fixture.height,JSON.stringify(options),0,0,out,1024*1024])
  const ms=performance.now()-start
  if(code<0)throw new Error(m.UTF8ToString(m._cactus_last_error()))
  return {result:JSON.parse(m.UTF8ToString(out)),timing:{loadMs:0,inferenceMs:ms,totalMs:ms},heapBytes:m.HEAPU8.buffer.byteLength,rssBytes:process.memoryUsage().rss}
 }finally{m._free(input);m._free(out)}
}
const byteSize=x=>Buffer.byteLength(JSON.stringify(x))
const initial=infer(corpus.fixtures[0],{form:{screen_type:{enum:labels}}})
const baselines={}
for(const fixture of corpus.fixtures){baselines[fixture.name]=infer(fixture,perceptionOptions);console.log(JSON.stringify({stage:'perception-baseline',fixture:fixture.name,ms:baselines[fixture.name].timing.inferenceMs}))}
const runs=[]
for(let round=0;round<rounds;round++)for(const fixture of corpus.fixtures)for(const order of round%2?['reversed','production']:['production','reversed']){
 const choices=order==='production'?labels:[...labels].reverse()
 const output=infer(fixture,{form:{screen_type:{enum:choices}}})
 globalThis.__mirageReplay={perception:baselines[fixture.name],decision:output}
 decisionMode='off';const before=await perceiveApprovedScreenshot('data:image/png;base64,AA==')
 decisionMode='assist';const after=await perceiveApprovedScreenshot('data:image/png;base64,AA==')
 const policy=after.decisionExperiment
 const value=output.result.form?.screen_type?.value
 const record={fixture:fixture.name,expected:fixture.expected,order,round,ms:output.timing.inferenceMs,heapBytes:output.heapBytes,rssBytes:output.rssBytes,rawClass:value,rawCorrect:value===fixture.expected,advisory:policy.status==='advisory',advisoryCorrect:policy.status==='advisory'?policy.visualClass===fixture.expected:null,beforeEnvelopeBytes:byteSize(before),afterEnvelopeBytes:byteSize(after),policy,result:output.result}
 runs.push(record);console.log(JSON.stringify({...record,result:undefined,policy:undefined}))
}
const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1]
const summaries=Object.fromEntries(['production','reversed'].map(order=>{const rs=runs.filter(r=>r.order===order),accepted=rs.filter(r=>r.advisory),supported=rs.filter(r=>['dialog','form','document'].includes(r.expected));return[order,{calls:rs.length,p50Ms:percentile(rs.map(r=>r.ms),.5),p95Ms:percentile(rs.map(r=>r.ms),.95),meanMs:rs.reduce((s,r)=>s+r.ms,0)/rs.length,rawCorrect:rs.filter(r=>r.rawCorrect).length,advisoryAccepted:accepted.length,advisoryCorrect:accepted.filter(r=>r.advisoryCorrect).length,supportedCases:supported.length,supportedAdvisories:supported.filter(r=>r.advisory).length,wrongAdvisories:accepted.filter(r=>!r.advisoryCorrect).length,abstained:rs.length-accepted.length,packingApplied:rs.filter(r=>r.policy.packing?.applied).length,beforeEnvelopeBytes:rs.reduce((s,r)=>s+r.beforeEnvelopeBytes,0),afterEnvelopeBytes:rs.reduce((s,r)=>s+r.afterEnvelopeBytes,0),peakWasmCapacityBytes:Math.max(...rs.map(r=>r.heapBytes)),peakProcessRssBytes:Math.max(...rs.map(r=>r.rssBytes))}]}))
const pairs=runs.filter(r=>r.order==='production').map(a=>({fixture:a.fixture,round:a.round,production:a.rawClass,reversed:runs.find(b=>b.order==='reversed'&&b.fixture===a.fixture&&b.round===a.round).rawClass}))
const sourcePaths=['scripts/benchmark-mirage-decisions.mjs','scripts/mirage-decision-fixtures.py','src/platform/mirageDecisionRequest.ts','src/platform/mirageDecisions.ts','src/platform/miragePerception.ts','src/platform/mirageWorker.ts']
const sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(root+path)).digest('hex')])))
const report={date:new Date().toISOString(),baselineCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHashes,pins:{engineRevision:'d2c5cd70432ed78345f3ba6b620bff2feeec6c86',modelRevision:'3d03cee88c0acbe4e71b94b567ab14e6e55f40c9',weightSha256:createHash('sha256').update(weights).digest('hex')},environment:{kind:'Node V8 WASM; not browser',node:process.version,v8:process.versions.v8,os:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,memoryBytes:os.totalmem()},renderer:corpus.renderer,fixtures:corpus.fixtures.map(({rgb,...meta})=>({...meta,rgbSha256:createHash('sha256').update(Buffer.from(rgb,'base64')).digest('hex')})),methodology:{rounds,classification:'fixed image form enum; production and reversed order alternate by round',baseline:'one bounded perception per fixture; no classifier/advisory',replay:'actual perceiveApprovedScreenshot, engine stubbed with measured real outputs, settings off vs assist; exact visual-result envelope byte comparison incl decision metadata; no actual browser/action',timing:'synchronous C ABI only; worker decode/capture/transfer excluded; replay totalMs set to ABI ms; no chat tokens counted',accuracy:'synthetic layout annotations only; neither user-intent routing nor tool selection accuracy'},loadMs,initial,baselines,summaries,labelOrderChanged:pairs.filter(p=>p.production!==p.reversed).length,labelOrderPairs:pairs.length,pairs,runs}
await mkdir(root+'docs/benchmarks',{recursive:true});await writeFile(root+'docs/benchmarks/mirage-decision-results.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({loadMs,summaries,labelOrderChanged:report.labelOrderChanged},null,2))
