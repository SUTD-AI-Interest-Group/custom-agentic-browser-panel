import { describe, expect, it } from 'vitest'
import { RETIRED_TOOL_CONTEXT_GUIDANCE, TOOL_GUIDANCE, mcpServersNote, withoutRetiredGuidance } from './promptGuidance'

describe('mcpServersNote', () => {
  it('names each connected server and the exact tool names to load, from the MCP ToolSet itself', () => {
    const note = mcpServersNote({
      mcp_github_list_issues: { description: '[MCP · github] List issues in a repository.' },
      mcp_github_create_issue: { description: '[MCP · github] Create an issue.' },
      mcp_notion_search: { description: '[MCP · notion] Search the workspace.' },
    })
    expect(note.startsWith('\n\n## Connected MCP servers\n')).toBe(true)
    expect(note).toContain('- github (2 tools): mcp_github_list_issues, mcp_github_create_issue')
    expect(note).toContain('- notion (1 tool): mcp_notion_search')
  })

  it('is empty with no MCP tools, and ignores anything that is not one', () => {
    expect(mcpServersNote({})).toBe('')
    expect(mcpServersNote({ ReadPage: { description: 'Read the tab.' }, Weird: { description: undefined } })).toBe('')
  })

  it('caps the names listed per server and counts the rest', () => {
    const tools = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`mcp_big_t${i}`, { description: `[MCP · big] Tool ${i}` }]))
    const note = mcpServersNote(tools)
    expect(note).toContain('- big (15 tools): mcp_big_t0,')
    expect(note).toContain('mcp_big_t11, and 3 more')
    expect(note).not.toContain('mcp_big_t12')
  })
})

describe('withoutRetiredGuidance', () => {
  const retired = RETIRED_TOOL_CONTEXT_GUIDANCE[0]

  it('removes the retired paragraph and the blank line before it, leaving the rest exactly', () => {
    expect(withoutRetiredGuidance(`Intro.\n\n${retired}\n\nOutro.`)).toBe('Intro.\n\nOutro.')
    expect(withoutRetiredGuidance(`${retired}\n\nOnly this.`)).toBe('Only this.')
  })

  it('leaves a prompt without it untouched', () => {
    expect(withoutRetiredGuidance('Be brief.')).toBe('Be brief.')
  })
})

describe('TOOL_GUIDANCE', () => {
  it('routes known tools straight to GetTool, keeping ToolSearch for what the model cannot name', () => {
    expect(TOOL_GUIDANCE).toMatch(/call GetTool with it directly/)
    expect(TOOL_GUIDANCE).toMatch(/use ToolSearch to find tools you don't know by name/)
  })

  it('puts WebMCP before page control, and MCP servers before driving a website', () => {
    const at = (s: string) => TOOL_GUIDANCE.indexOf(s)
    expect(at('2. The user\'s connected MCP servers')).toBeLessThan(at('3. The page\'s own WebMCP actions'))
    expect(at('3. The page\'s own WebMCP actions')).toBeLessThan(at('5. Controlling the page'))
  })

  it('no longer sends the model to DiscoverWebMcp on every page request', () => {
    expect(TOOL_GUIDANCE).not.toContain('For a page-related request, call DiscoverWebMcp early')
    expect(TOOL_GUIDANCE).toContain("You don't need it just to read or summarize a page.")
  })
})
