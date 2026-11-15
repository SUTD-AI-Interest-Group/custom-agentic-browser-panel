// Real pinned Mirage WASM inference in Node/V8. NOT a browser/E2E benchmark.
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const compiled=await build({entryPoints:[root+'src/platform/miragePerception.ts'],bundle:true,platform:'node',write:false,format:'esm'})
const {normalizeMirage,observeExpectedText}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const renderer=JSON.parse(execFileSync('python3',['-c',"import json,PIL;from PIL import ImageFont;print(json.dumps(dict(python=__import__('sys').version,pillow=PIL.__version__,font=ImageFont.truetype('DejaVuSans.ttf',24).path)))"]))
const fixtures = JSON.parse(execFileSync('python3', [root+'scripts/mirage-fixtures.py'],{maxBuffer:32*1024*1024}))
const context={require:createRequire(import.meta.url),__dirname:root+'public/mirage',__filename:root+'public/mirage/cactus.js',module:{exports:{}},exports:{},process,console,Buffer,TextDecoder,TextEncoder,WebAssembly,setTimeout,clearTimeout,performance}
vm.runInNewContext(await readFile(root+'public/mirage/cactus.js','utf8'),context)
const start=performance.now()
const m=await context.module.exports({wasmBinary:await readFile(root+'public/mirage/cactus.wasm')})
const weights=await readFile(root+'public/mirage/mirage.cact')
const ptr=m._malloc(weights.length);m.HEAPU8.set(weights,ptr)
if(m._cactus_load(ptr,BigInt(weights.length))<0)throw new Error(m.UTF8ToString(m._cactus_last_error()))
m._free(ptr)
const loadMs=performance.now()-start
const profiles={default:{},bounded:{sections:['objects','text'],fields:['bbox','score'],max_objects:24,max_text_lines:48,max_tokens:192,conf:.5,text_conf:.5},ocrOnly:{sections:['text'],fields:['bbox','score'],max_text_lines:48,text_conf:.5}}
const runs=[]
const normalized=s=>s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(Boolean)
function run(fixture,profile,round){
 const rgb=Buffer.from(fixture.rgb,'base64'),input=m._malloc(rgb.length),output=m._malloc(1024*1024)
 m.HEAPU8.set(rgb,input);m.HEAPU8[output]=0
 const rssBefore=process.memoryUsage().rss,start=performance.now()
 try{
  const code=m.ccall('cactus_describe','number',['number','number','number','string','number','number','number','number'],[input,fixture.width,fixture.height,JSON.stringify(profiles[profile]),0,0,output,1024*1024])
  const ms=performance.now()-start
  if(code<0)throw new Error(m.UTF8ToString(m._cactus_last_error()))
  const result=JSON.parse(m.UTF8ToString(output))
  const expected=new Set(normalized(fixture.expected.join(' ')))
  const actual=new Set(normalized((result.text??[]).map(x=>x.string??'').join(' ')))
  const matched=[...expected].filter(x=>actual.has(x)).length
  const falseWords=[...actual].filter(x=>!expected.has(x))
  const lines=(result.text??[]).map(x=>normalized(x.string??'').join(' '))
  const exactLabels=fixture.expected.filter(x=>lines.includes(normalized(x).join(' '))).length
  const normalizeStart=performance.now()
  const observations=normalizeMirage(result)
  const productionExactLabels=fixture.expected.filter(x=>observeExpectedText(observations.text,x).status==='text-observed').length
  const absentLabelMatches=['Order placed','Payment successful','Access granted'].filter(x=>observeExpectedText(observations.text,x).status==='text-observed')
  const normalizationMs=performance.now()-normalizeStart
  const record={fixture:fixture.name,profile,round,ms,heapBytes:m.HEAPU8.buffer.byteLength,rssBefore,rssAfter:process.memoryUsage().rss,expectedLabels:fixture.expected.length,exactLabels,productionExactLabels,normalizationMs,absentLabelMatches,expectedWords:expected.size,matchedWords:matched,falseWords,result}
  runs.push(record);console.log(JSON.stringify({...record,result:round === -1 ? result : undefined}))
 }finally{m._free(input);m._free(output)}
}
// Initial calls retained and labeled, excluded from warm summaries.
for(const name of Object.keys(profiles))run(fixtures[0],name,-1)
const rounds=Number(process.env.MIRAGE_ROUNDS??3)
for(let round=0;round<rounds;round++)for(const fixture of fixtures){
 const names=Object.keys(profiles);for(let i=0;i<names.length;i++)run(fixture,names[(i+round)%names.length],round)
}
const percentile=(values,p)=>{values=[...values].sort((a,b)=>a-b);return values[Math.ceil(values.length*p)-1]}
const summary=Object.fromEntries(Object.keys(profiles).map(name=>{
 const rs=runs.filter(x=>x.profile===name&&x.round>=0)
 const matched=rs.reduce((a,x)=>a+x.matchedWords,0),expected=rs.reduce((a,x)=>a+x.expectedWords,0),falseWords=rs.reduce((a,x)=>a+x.falseWords.length,0)
 return [name,{n:rs.length,p50Ms:percentile(rs.map(x=>x.ms),.5),p95Ms:percentile(rs.map(x=>x.ms),.95),meanMs:rs.reduce((a,x)=>a+x.ms,0)/rs.length,expectedWords:expected,matchedWords:matched,falseWords,wordRecall:matched/expected,wordPrecision:matched/(matched+falseWords),expectedLabels:rs.reduce((a,x)=>a+x.expectedLabels,0),exactLabels:rs.reduce((a,x)=>a+x.exactLabels,0),productionExactLabels:rs.reduce((a,x)=>a+x.productionExactLabels,0),normalizationP50Ms:percentile(rs.map(x=>x.normalizationMs),.5),absentLabelMatches:rs.reduce((a,x)=>a+x.absentLabelMatches.length,0),peakWasmCapacityBytes:Math.max(...rs.map(x=>x.heapBytes)),peakProcessRssBytes:Math.max(...rs.map(x=>x.rssAfter))}]
}))
const sourceHashes=Object.fromEntries(await Promise.all(['scripts/benchmark-mirage.mjs','scripts/mirage-fixtures.py','src/platform/miragePerception.ts','src/platform/mirageWorker.ts'].map(async path=>[path,createHash('sha256').update(await readFile(root+path)).digest('hex')])))
const report={sourceHashes,date:new Date().toISOString(),baselineCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),pins:{engineRevision:'d2c5cd70432ed78345f3ba6b620bff2feeec6c86',modelRevision:'76c1e9e53381aca8fc3843c636216c96ff220122'},renderer,environment:{kind:'Node V8 WASM; no browser',node:process.version,v8:process.versions.v8,os:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalHostMemoryBytes:os.totalmem()},methodology:{fixtures:fixtures.length,rounds,profileOrder:'rotated by round; shared model instance',cold:'one model initialization; one initial invocation per profile, excluded from warm',accuracy:'normalized unique OCR word precision/recall; synthetic generated images, no planner/task-success claim',memory:'WASM linear capacity and whole Node process RSS, not exclusive model or browser memory'},loadMs,profiles,summary,runs}
await mkdir(root+'docs/benchmarks',{recursive:true})
await writeFile(root+'docs/benchmarks/mirage-results.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({loadMs,summary},null,2))
