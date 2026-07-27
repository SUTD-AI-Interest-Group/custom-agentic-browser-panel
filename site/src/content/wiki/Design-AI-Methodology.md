# The Design-AI Methodology

This project was built inside SUTD's **Design-AI** frame, and we want to be
precise about what that meant in practice — because "we followed a methodology"
is the easiest sentence in engineering to write and the hardest to prove.

SUTD's position is that AI belongs in *every* stage of the design process — user
research, context analysis, synthesis, ideation, concept development,
prototyping — but that the result must be **"human-centred, as opposed to being
tech-centred."** The discipline it teaches is discernment: knowing when to *use
AI as a tool*, when to *collaborate with it as a teammate*, and when to **choose
not to use it at all** — grounded in an honest understanding of a model's
capabilities *and its limitations*.

That last clause is not decoration. It shows up three times in this codebase as
a load-bearing technical decision, and each time it made the system **less** AI
than the obvious design would have been.

---

## 1. Human-centred: the permission card *is* the security model

The tech-centred version of this product is obvious and we could have shipped it
in a day: give the model the tools, let it read and click, apologise later. We
built the opposite. **Every agent tool that touches a page, the network, or your
data suspends on a human approval card before its `execute()` proceeds.** That
isn't a feature layered on top of the agent; it is the architecture. The tool's
`execute()` literally awaits a promise that only a human click resolves.

The consequence is a system where the agent's power is bounded by attention
rather than by trust. And it forced work that a tech-centred design never
reaches:

- A **point-of-no-return classifier** (`isPointOfNoReturn()`), because a blanket
  "you may control this page" grant is not real consent for the *irreversible*
  step inside it. Form submits, cross-origin navigation, Enter keypresses,
  password and payment fields each re-confirm individually — **every time**, with
  no "allow this chat" escape hatch.
- An **on-page presence overlay** — a tint, a spotlight, and a cursor that glides
  to each element before the agent touches it. It is pure UX and buys the model
  nothing. It exists so a human can *watch* an agent act on their behalf, which
  is what makes the consent meaningful rather than nominal.

## 2. Choosing *not* to use AI

The most on-theme decisions we made were the ones where we declined to use a
model.

**The research browse gate is a pure function, not a judgement call.** When the
research agent drives a real browser tab, no human is present to approve
anything — the natural LLM-era instinct is to have the model decide whether an
action is safe. We didn't. `src/tools/browsePolicy.ts` is a deterministic,
exhaustively unit-tested classifier that permits reading, SSRF-guarded
navigation, and site-search, and refuses logins, purchases, and any non-search
form submit. Its own header comment states the reasoning plainly: *"No human is
at the gate here… so the rule here is 'only do things that cannot commit
anything'."* A model asked to police itself is a model that can be argued with.
A pure function cannot be prompt-injected.

**The point-of-no-return classifier is likewise pure.** Whether an action is
irreversible is a question with a right answer, and right answers belong in code
that can be tested, not in a prompt that can be persuaded.

The pattern generalises: **we used AI for judgement under ambiguity, and code for
judgement under adversarial pressure.**

## 3. Capabilities *and limitations*: measure, don't assume

An OpenAI-compatible endpoint will happily accept an image and tell you nothing
about whether the model behind it can actually see. Assuming capability is
tech-centred; the human pays for the assumption when the agent hallucinates a
screenshot it never perceived.

So the panel **probes**. `src/agent/vision.ts` sends a tiny canvas image
containing a random code, once per provider+model, and grants the model
vision-capable status **only if it echoes the code back**. The verdict is cached.
And the consequence respects the limit rather than papering over it: a model that
fails the probe still gets the screenshot tools, but `planShotDelivery` withholds the
*image* from it and says so in words — while the human, who can see, still gets the
picture. (The first cut simply **deleted** the tool from a blind model's toolset; that
killed the retry-forever loop but also threw away the user's screenshot — see
[Agent Perception](Agent-Perception#the-tool-split-and-stopped-vanishing).)

The same honesty about limits produced **progressive tool disclosure**: rather
than assume a model can pick correctly from twenty tool schemas, the panel ships
it three and lets it request the rest. Respecting a context window is respecting
a limitation.

---

## The process, and the evidence for it

SUTD's frame puts design *before* prototyping, and the commit history shows we
actually worked that way rather than merely claiming to:

| | |
| --- | --- |
| `feat` commits | 67 |
| `docs` commits (specs + plans) | 33 |
| `fix` / `harden` commits | 33 |

**A third of the work produced no running code.** Twenty design specs and nine
implementation plans survive in
[`docs/superpowers/`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/tree/main/docs/superpowers),
each pairing a *design* (what, why, and explicitly what we are **not** doing)
with an ordered, verifiable *plan* before any feature commit.

The strongest evidence that the design stage was real is that it sometimes said
**no**: `c0f77af — docs: drop abandoned LM Studio/SSE design spec`. A spec was
written, reviewed, and killed without a line of implementation. Design that
cannot reject an idea isn't design; it's paperwork.

And the studio principle — *real clients, real data* — has a direct analogue
here. Our nastiest bugs were not found in tests. They surfaced, in the words of
commit `1eaee6e`, "during real research runs" against live, hostile pages: a
search engine's bot wall that our retry logic silently failed to clear because
the `User-Agent` header we were setting is *forbidden* to browsers and was being
dropped; a Chrome API that returns `null` instead of rejecting when the extension
lacks incognito access. No amount of upfront design finds those. You have to go
outside and get hit by the real world.

---

## Where the methodology and the engineering disagreed

Honesty requires noting the friction. Human-centred design says *ask the human*.
Long-running autonomy says *don't interrupt them*. Those pull against each other,
and we resolved it differently in the two halves of the product:

- **Foreground (page control):** the human is present, so the human is the gate —
  twice over, at session grant and again at every irreversible step.
- **Background (research):** the human is *absent* by design (the whole point is
  that it survives closing the panel), so a card is not merely unhelpful, it is
  impossible. The gate becomes a pure policy, and the human's single decision
  moves to the launch.

The rule we ended on: **the human gates what the human can see. Everything else
gets a policy that cannot be talked out of its job.**
