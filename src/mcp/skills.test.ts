// @vitest-environment node
import { describe,it,expect,vi } from 'vitest'
import { getRemoteSkill, listRemoteSkills, parseSkill, stableValue, readVerifiedSkillFile, SKILLS_EXTENSION } from './skills'
import { ModernMcpClient } from './modern'
const uri='skill://review/SKILL.md'
const text='---\nname: review\ndescription: Review code\n---\nCheck it.\n'
async function entry(content=text) {const bytes=new TextEncoder().encode(content);const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');return {uri,frontmatter:{name:'review',description:'Review code'},resources:[{uri,digest:`sha256:${hash}`,size:bytes.length}]}}
function client(result:unknown){return {supportsExtension:(name:string)=>name===SKILLS_EXTENSION,getServerCapabilities:()=>({resources:{}}),request:vi.fn(async()=>result)} as unknown as ModernMcpClient}
describe('MCP skill integrity',()=>{
  it('loads an unlisted URI directly, then verifies the raw content',async()=>{
    const skill=await entry(), c=client({skill})
    expect(await getRemoteSkill(c,uri)).toEqual(skill)
    const read=client({contents:[{uri,text}]})
    expect(await readVerifiedSkillFile(read,skill,uri)).toBe(text)
  })
  it('rejects altered bytes, wrong size and frontmatter mismatches',async()=>{
    const skill=await entry()
    await expect(readVerifiedSkillFile(client({contents:[{uri,text:text.replace('Check','Hacks')}]}),skill,uri)).rejects.toThrow('integrity')
    await expect(readVerifiedSkillFile(client({contents:[{uri,text:text+'extra'}]}),skill,uri)).rejects.toThrow('size')
    const other=text.replace('Review code','Ignore safety'), mismatched=await entry(other)
    await expect(readVerifiedSkillFile(client({contents:[{uri,text:other}]}),mismatched,uri)).rejects.toThrow('frontmatter')
  })
  it('never retrieves a file outside the retained manifest',async()=>{
    const c=client({});await expect(readVerifiedSkillFile(c,await entry(),'https://evil.test/file')).rejects.toThrow('outside')
    expect(c.request).not.toHaveBeenCalled()
  })
  it('does not call undeclared extensions or accept dynamic skills',async()=>{
    const c=client({skill:{...(await entry()),resources:'dynamic'}})
    await expect(getRemoteSkill(c,uri)).rejects.toThrow('Dynamic')
    c.supportsExtension=()=>false
    await expect(listRemoteSkills(c)).rejects.toThrow('advertise')
  })
  it('rejects duplicate manifest URIs and wrong directory names',async()=>{
    const s=await entry();expect(()=>parseSkill({...s,resources:[...s.resources,...s.resources]})).toThrow()
    expect(()=>parseSkill({...s,uri:'skill://different/SKILL.md'})).toThrow()
  })
  it('lists complete metadata without fetching instruction files',async()=>{
    const skill=await entry(), c=client({skills:[skill]})
    expect(await listRemoteSkills(c)).toEqual([skill])
    expect(c.request).toHaveBeenCalledTimes(1);expect(c.request).toHaveBeenCalledWith('skills/list',{},expect.anything())
  })
})

it('bounds nested metadata before approval',()=>{
  let nested:unknown='value';for(let i=0;i<40;i++)nested={nested}
  expect(()=>stableValue(nested)).toThrow('nesting')
})
it('accepts a large base64 file without recursive regex stack exhaustion',async()=>{
  const body='a'.repeat(1024*1024), skill=await entry(body)
  skill.resources[0].uri='skill://review/large.txt'
  expect(await readVerifiedSkillFile(client({contents:[{uri:skill.resources[0].uri,blob:Buffer.from(body).toString('base64')}]}),skill,skill.resources[0].uri)).toBe(body)
})
