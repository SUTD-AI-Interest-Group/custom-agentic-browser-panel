// Skills shipped with the extension. Seeded into the store on first load (see
// seedBuiltinSkills). `create-skill` is the meta-skill whose body is a distilled
// skill-authoring guide; the rest are useful browser-workflow examples that
// double as worked examples of good SKILL.md structure. All are source
// 'builtin' — read-only in the Library (duplicate to customize) and undeletable.

import { listSkills, saveSkill, type SaveSkillInput } from './skills'

const CREATE_SKILL_BODY = `# Creating a skill

You are helping the user build a new **agent skill** — a reusable set of instructions you will later follow when the skill is invoked. Work through the steps below with the user, then save the result with the \`SaveSkill\` tool.

Keep to **one skill = one capability**. If the user describes several unrelated jobs, make several skills.

## Step 1 — Interview the user

Ask briefly, and only for what you don't already know:
- **Task**: what should happen when this skill runs, and what's the end result?
- **Triggers**: what will the user say that means "use this"? Collect concrete phrases and keywords.
- **Inputs**: does it need the current page, a selection, a screenshot, or memory? You have \`ReadPage\`, \`ReadTabs\`, and \`SearchMemory\`.
- **Output**: format, length, tone, must-haves.
- **Strictness**: an exact sequence to follow, or room to improvise?

## Step 2 — Write the description (most important)

The description is the *only* thing that decides when this skill triggers, so make it earn its place:
- Write in the **third person**: "Summarizes the current page…", never "I can…" or "You can…".
- State **what it does and when to use it**, and include the trigger keywords the user gave you.
- Good: \`Extracts tables from the current web page into clean Markdown or CSV. Use when the user asks to pull a table, list, or structured data from a page.\`
- Weak: \`Helps with tables.\`

## Step 3 — Name it

- Prefer the **gerund form**: \`summarizing-pages\`, \`drafting-replies\`. A noun phrase like \`page-summary\` is fine too.
- Rules: lowercase letters, numbers and single hyphens; 1–64 characters; no leading/trailing hyphen; cannot contain "anthropic" or "claude".
- Avoid vague names like \`helper\` or \`utils\`.

## Step 4 — Write the body

- **Be concise — the context window is a public good.** Only add what you wouldn't already know; cut generic filler.
- Give **concrete steps**. If the task is fragile and must happen in an exact order, spell that order out. If several approaches are fine, give guidance rather than rigid steps.
- Refer to tools by their exact name (\`ReadPage\`, etc.).
- For style-sensitive output, include a short **example** of the desired result — it teaches shape better than description does.
- Avoid time-sensitive notes ("as of 2025…"). Keep terminology consistent throughout.

## Step 5 — Show, refine, save

1. Show the user the full draft: name, description, and body.
2. Refine together until it's right.
3. Call \`SaveSkill\` with the final \`name\`, \`description\`, \`body\`, and an \`icon\` emoji. The user will be asked to approve the save.
4. Confirm it's saved and remind them they can run it by typing \`/name\`, edit it in the Skills Library, or ask you to improve it later.`

const SUMMARIZING_PAGES_BODY = `# Summarizing pages

When the user asks for a summary, TL;DR, or recap of the page they're viewing:

1. If the page content isn't already in the conversation, call \`ReadPage\` (mode "text") to read it.
2. Write the summary as:
   - **Gist** — one sentence capturing what the page is.
   - **Key points** — 3–6 tight bullets, most important first.
   - **Actions** — any next steps or to-dos the page implies (omit if there are none).
3. Keep it skimmable and use the page's own terms. If the page couldn't be read, say so — never invent content.`

const EXTRACTING_TABLES_BODY = `# Extracting tables

When the user asks to pull a table, list, or other structured data out of the current page:

1. If you don't already have the page content, call \`ReadPage\` (mode "text") to read it.
2. Identify the structured data the user means (ask only if genuinely ambiguous).
3. Output a clean **Markdown table** by default. If the user asked for CSV, output CSV in a fenced code block instead.
4. Preserve column headers and units. Don't invent or reorder rows; leave a missing cell blank. If nothing tabular is present, say so.`

const DRAFTING_REPLIES_BODY = `# Drafting replies

When the user asks you to draft a reply to an email, comment, chat, or thread shown on the current page:

1. If you don't already have the content, call \`ReadPage\` (mode "text") to read the thread being replied to.
2. Match the tone of the surrounding conversation unless the user asks for a specific tone.
3. Draft a reply that acknowledges the key point, answers or acts on it, and ends with a clear next step or sign-off.
4. Keep it to the length the medium expects — a chat reply is short, an email can be longer. Offer one draft, then adjust on request. Never send anything; you only draft.`

const WRITING_MATH_BODY = String.raw`# Writing math

When answering a math, physics, statistics, or engineering question — or whenever your reply contains equations, formulas, derivations, or proofs — format the math as LaTeX so it renders in the panel.

## Delimiters
- Inline math: wrap it in single dollar signs, e.g. write $\pi r^2$ for the area of a circle.
- Display (block) math: put $$ on its own line, then the expression, then $$ on its own line:
$$
E = mc^2
$$
- To show a literal dollar sign in prose, escape it as \$ so it is not read as a math delimiter.

## Prefer LaTeX over Unicode
Write \alpha, \leq, \times, \to, \infty rather than the Unicode characters α, ≤, ×, →, ∞. Unicode math renders inconsistently; LaTeX commands always typeset.

## Common constructs
- Fractions and roots: \frac{a}{b}, \sqrt{x}, \sqrt[3]{x}.
- Sub/superscripts: x^{2}, a_{i}, x_{i}^{2}.
- Auto-sized brackets: \left( \frac{a}{b} \right).
- Multi-line or aligned steps: use an aligned environment inside $$ … $$, with & to align on a symbol and \\ to end each line.
- Matrices: \begin{bmatrix} a & b \\ c & d \end{bmatrix}. Piecewise functions: \begin{cases} … \end{cases}.
- Text and units inside math: \text{…}; use a thin space \, before units, e.g. 5\,\text{m/s}.

## Stay within KaTeX
Rendering uses KaTeX, which supports most standard LaTeX math but not every macro. Stick to standard commands; an unsupported command shows as a small inline error. Reference: https://katex.org/docs/supported.html

## Example
Inline: the solutions of ax^2 + bx + c = 0 are $x = \dfrac{-b \pm \sqrt{b^2 - 4ac}}{2a}$.

Display derivation:
$$
\begin{aligned}
(x + 1)^2 &= x^2 + 2x + 1 \\
          &= x(x + 2) + 1
\end{aligned}
$$`

/** Seed data. `create-skill` is user-only (the agent shouldn't spontaneously
 * author skills); the examples are invocable both ways. */
export const BUILTIN_SKILLS: SaveSkillInput[] = [
  {
    name: 'create-skill',
    description:
      'Guides the user through building a new agent skill from scratch and saves it. Use when the user wants to create, author, design, or build a custom skill for a workflow they repeat.',
    body: CREATE_SKILL_BODY,
    icon: '🛠️',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: false,
  },
  {
    name: 'summarizing-pages',
    description:
      'Summarizes the web page the user is viewing into a tight brief with a gist, key points, and next actions. Use when the user asks to summarize, TL;DR, digest, or recap the current page or an article.',
    body: SUMMARIZING_PAGES_BODY,
    icon: '📰',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
  {
    name: 'extracting-tables',
    description:
      'Extracts tabular or structured data from the current web page into clean Markdown or CSV. Use when the user asks to pull a table, list, prices, or structured data out of a page.',
    body: EXTRACTING_TABLES_BODY,
    icon: '📊',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
  {
    name: 'drafting-replies',
    description:
      "Drafts a reply to the email, comment, or message thread on the current page, matching the user's tone. Use when the user asks to reply, respond to, or write a message about what's on screen.",
    body: DRAFTING_REPLIES_BODY,
    icon: '✉️',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
  {
    name: 'writing-math',
    description:
      'Formats mathematical and scientific answers as LaTeX that renders in the panel. Use when the user asks a math, physics, statistics, or engineering question, or to write equations, formulas, derivations, or proofs.',
    body: WRITING_MATH_BODY,
    icon: '➗',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
  },
]

/** Idempotent: inserts any missing built-in by name. Leaves user edits and
 * existing built-ins untouched, so re-running on every startup is safe. */
export async function seedBuiltinSkills(): Promise<void> {
  const existing = new Set((await listSkills()).map((s) => s.name))
  for (const seed of BUILTIN_SKILLS) {
    if (!existing.has(seed.name)) await saveSkill(seed)
  }
}
