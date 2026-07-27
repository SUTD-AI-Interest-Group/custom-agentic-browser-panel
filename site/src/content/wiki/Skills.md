# Skills

**Goal.** Reusable instruction bundles — single-file `SKILL.md` records
(frontmatter + Markdown body) — that a user can invoke by name (`/summarizing-pages`)
*or* that the agent can recognise and load on its own.

Spec: [`2026-07-10-agent-skills-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-10-agent-skills-design.md).

---

## The disclosure trick

A catalog of every skill's **name + description** (one line each) is appended to
the system prompt every turn. The full body is *not*. When a request matches, the
agent calls `ReadSkill` to load the body it needs.

That's the same progressive-disclosure idea as the toolset: cheap always-on index,
expensive payload on demand.

`ReadSkill` and `ListAllSkills` are the one **deliberate** exception to the
gate-every-tool rule. They read only your own local skills — as benign as
`SearchMemory` — so they auto-approve. The spec calls this out explicitly so that
it reads as *"an intentional decision, not an accident."* `SaveSkill` mutates the
store and always shows a card.

## Four bugs in one commit

`e893fb4` — *"fix: enforce modelInvocable on read tools, fix rename/duplicate,
guard description newline"* — is a nice cross-section of the ways a small CRUD
feature quietly goes wrong.

**1. `modelInvocable` wasn't actually enforced.** `ListAllSkills` listed
everything and `ReadSkill` checked nothing — so a skill deliberately marked
user-only could still be discovered and auto-loaded by the model. The victim was
our own `/create-skill`, which is user-only *precisely* so the agent doesn't
spontaneously start authoring skills at you. A flag that isn't checked isn't a
flag; it's a comment.

**2. Renaming a skill created an undeletable orphan.** `saveSkill` upserts **by
name**. So a rename wrote a *new* record under the new name and left the old one
sitting there forever. Fixed with an explicit rename path that deletes the
original after the save succeeds.

**3. "Duplicate" collided with itself.** The copy was unconditionally named
`${name}-copy`. Duplicating the same skill twice silently overwrote the first
copy. Now it counts: `-copy-2`, `-copy-3`.

**4. A newline in a description corrupted the catalog.** The catalog injected into
the system prompt is a single-line-per-skill format (`- name: description`). A
multi-line description broke it — a data-entry field quietly corrupting the
*prompt*. Now validated: *"Description must be a single line."*

The through-line: **three of these four are "upsert by name" biting back**, and
the fourth is a free-text field escaping into a structured format. Neither is
exotic. Both are the sort of thing a spec doesn't catch and a user finds in
minutes.

## The cost of naming tools in free text

Built-in skill bodies mention tools by name — *"use `ViewCurrentTab` to…"* — as
plain prose. When [Progressive Tool Disclosure](Progressive-Tool-Disclosure)
consolidated `ViewCurrentTab` / `GetActiveTabDOM` / `InspectPage` into `ReadPage`,
every one of those references became a lie pointing at a tool that no longer
existed.

`2cb5795` had to retarget `builtinSkills.ts` in lockstep with `tools.ts`. It
worked, but it's a real and permanent tax: **skill bodies reference tools as free
text, so the compiler cannot help you.** Rename a tool and nothing breaks at build
time — it breaks at *inference* time, in a prompt, on a user's machine. We accepted
this (skills are user-authored Markdown; a typed reference would defeat the
format's whole point), but it's the sharpest edge in the feature and worth knowing
before you rename a tool.

## Scope we said no to

From the spec's YAGNI list, and we still agree with all of it: no multi-file
skills, no bundled scripts or binary resources (*the extension is client-side with
no runtime or filesystem*), no cross-device sync, no marketplace.
