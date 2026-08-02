# Lychee AI — Engineering Log

An AI agent that lives in Chrome's side panel: it reads the page you're on,
controls it with your permission, and runs long web research in the background.
Manifest V3, React 18, TypeScript, built on the Vercel AI SDK. **No backend** —
the panel talks straight to whatever OpenAI-compatible endpoint you give it.

This wiki is the engineering log: what we set out to build, how each feature was
actually built, what broke, and why the code looks the way it does. It is
written against the commit history rather than from memory — where we claim a
bug, there's a commit, a comment, or a regression test behind it.

---

## The shape of the project

| | |
| --- | --- |
| **Span** | 10 July–2 August 2026 |
| **Commits** | 387 |
| **`feat`** | 165 |
| **`docs`** | 75 |
| **`fix` / `harden`** | 80 |

That ratio is the most honest summary of how this was built. **More than a third of
the commits produced no feature code at all** — the repository now contains 38 design
specs and 20 implementation plans, and another 80 fixes and hardening commits landed
*after* features already "worked." Almost every
capability in the codebase landed as the same three-beat sequence:

```
docs: design for X          ← the spec: what, why, what we are NOT doing
docs: implementation plan   ← the plan: ordered, verifiable steps
feat: X                     ← the build
fix: / harden: …            ← what the build taught us
```

Thirty-eight design specs and twenty implementation plans are still in the repo
under
[`docs/superpowers/`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/tree/main/docs/superpowers).
One of them — `docs: drop abandoned LM Studio/SSE design spec` (`c0f77af`) — was
deleted rather than built. Designing something and then *not* building it is a
result, not a waste.

## Recent milestones

The original feature log was written on 24 July. The later work extended the same
patterns rather than changing the architecture:

- **Sandboxed execution and artifacts (27 July)** — `RunCode` executes JavaScript in
  a memory- and time-bounded QuickJS sandbox; artifact HTML renders in a separate
  manifest-sandboxed page, with IndexedDB storage and per-conversation deletion.
- **Tab management and regeneration (28 July)** — semantic tab grouping/closing tools
  report verified results, and failed reply regeneration is fed back for self-correction.
- **Per-tab chats (1 August)** — chats are keyed by tab and origin, background turns stay
  mounted, and turns park safely when their tab is no longer frontmost.
- **Secrets at rest (1–2 August)** — provider keys, observability keys, MCP headers, and
  OAuth tokens use the IndexedDB-backed envelope-encryption vault, with automatic migration
  and erase-all key destruction.
- **Prompt attachments and hardening (2 August)** — provider-aware image/PDF/text delivery,
  capped attachment storage, and the adversarial-review fixes are now part of the shipped path.

The detailed, commit-linked release notes live in the repository [changelog](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/CHANGELOG.md).

## Start here

- **[The Design-AI Methodology](Design-AI-Methodology)** — the SUTD frame that
  shaped the whole project, and the three places it changed a technical decision.
- **[Origins and Goals](Origins-and-Goals)** — what we set out to make, and the
  two constraints that determined everything downstream.

## The features

| Page | What it covers |
| --- | --- |
| [The Agent Turn Loop](The-Agent-Turn-Loop) | One turn, the approval gate, and why the gate is the security model |
| [Providers and Reasoning](Providers-and-Reasoning) | One capability profile per provider — native vs compatible adapters, and the reasoning-effort dial |
| [Progressive Tool Disclosure](Progressive-Tool-Disclosure) | Shrinking the toolset the model sees — and the dead-end it created |
| [Page Control](Page-Control) | Clicking and typing on real pages behind two nested gates |
| [Agent Perception](Agent-Perception) | Making a model *see*: the vision probe, set-of-marks, screenshots |
| [Long-Horizon Turns](Long-Horizon-Turns) | Checkpoints, continuation chains, steering a live turn, and running out of steps gracefully |
| [Deep Research](Deep-Research) | A phased pipeline over a notebook, in an offscreen document |
| [Autonomous Browsing](Autonomous-Browsing) | Letting the research agent drive a real tab — and the policy that fences it |
| [Memory and Dreaming](Memory-and-Dreaming) | Two-tier memory, consolidated while you're away |
| [Skills](Skills) | Reusable instruction bundles the agent can load on its own |
| [Rich Rendering](Rich-Rendering) | Markdown, KaTeX, citations, link cards — and a sanitizer that ate our math |
| [Observability](Observability) | Optional Langfuse tracing, and failures that refuse to stay silent |
| [MCP Servers and Apps](MCP-Servers-and-Apps) | Third-party MCP servers — the standard JSON, OAuth via chrome.identity, rich results, and interactive apps in a sandboxed iframe |

## Cross-cutting

- **[Security and the Permission Model](Security-and-the-Permission-Model)** —
  every gate in the system, in one place: approval cards, the point-of-no-return
  classifier, the SSRF guard, and the pure browse policy.
- **[Lessons Learned](Lessons-Learned)** — what we'd tell the next team, including
  the things we got wrong twice.
