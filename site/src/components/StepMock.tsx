import { useEffect, useRef } from 'react'
import { C } from './SceneMock'

/**
 * The three quick-start frames — Web Store listing, model settings, first ask.
 *
 * A sibling of SceneMock rather than three more of its variants, and the reason
 * is legibility, not taste: SceneMock is one fixed 1220×830 composition (a
 * browser page beside the side panel) and a quick-start card is ~360px wide, so
 * reusing it would scale to 0.30 and render its 20px type at 6px. These are
 * drawn at 560×380 instead — scaled to ~0.64 in the same card — and each shows
 * only the one surface its step is about.
 *
 * Same technique and same palette as SceneMock otherwise: real DOM at a native
 * size, scaled to fit by a measured ratio, so the type hierarchy is the film's
 * rather than re-guessed at web sizes.
 */

const W = 560
const H = 380

export type StepVariant = 'install' | 'connect' | 'ask'

/** The window/panel chrome all three frames sit in, so they read as a set. */
function Frame({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="stepmock__window">
      <div className="stepmock__head">{head}</div>
      <div className="stepmock__body">{children}</div>
    </div>
  )
}

/** The extension's own mark — a rounded tile carrying the brand dot. */
function Mark({ size = 44 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: C.surface,
        border: `1px solid ${C.hairlineHi}`,
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      <span style={{ width: size * 0.4, height: size * 0.4, borderRadius: '50%', background: C.red }} />
    </div>
  )
}

function Install() {
  return (
    <Frame
      head={
        <>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <span key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c, flexShrink: 0 }} />
          ))}
          <div className="stepmock__url">chromewebstore.google.com</div>
          {/* The pinned extension, ringed — step one ends at the toolbar. */}
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              border: `2px solid ${C.red}`,
              background: 'rgba(201,48,74,0.1)',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: C.red }} />
          </div>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
        <Mark size={64} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 27, fontWeight: 700, color: C.ink, lineHeight: 1.1 }}>Lychee AI</span>
          {/* Facts only — a star rating here would be a review count invented
              for a mock, which is not a thing to put on a landing page. */}
          <span style={{ fontSize: 19, color: C.gray }}>Side-panel AI agent</span>
          <span style={{ fontSize: 18, color: C.faint }}>Free · Open source</span>
        </div>
      </div>

      <div
        style={{
          alignSelf: 'flex-start',
          background: C.ink,
          color: '#fff',
          borderRadius: 999,
          padding: '13px 26px',
          fontSize: 20,
          fontWeight: 600,
        }}
      >
        Add to Chrome
      </div>

      {/* The step's second half. It labels the ringed tile up in the titlebar
          rather than drawing a second toolbar inside the page, which is where
          a pinned extension does not live. */}
      <div
        style={{
          marginTop: 'auto',
          borderTop: `1px solid ${C.hairline}`,
          paddingTop: 15,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span style={{ fontSize: 17, color: C.gray }}>
          <span style={{ color: C.leaf, fontWeight: 700 }}>✓</span> No account · no card
        </span>
        <span style={{ fontSize: 17, color: C.red, fontWeight: 600 }}>Pinned ↗</span>
      </div>
    </Frame>
  )
}

function Connect() {
  return (
    <Frame
      head={
        <>
          <Mark size={22} />
          <span style={{ fontSize: 20, fontWeight: 700, color: C.ink }}>Settings</span>
          <span style={{ fontSize: 18, color: C.faint }}>· Model</span>
        </>
      }
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {[
          ['OpenAI', 'on'],
          ['Anthropic', ''],
          ['Groq', ''],
          ['Ollama', 'local'],
        ].map(([name, state]) => (
          <span
            key={name}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              border: `1px solid ${state === 'on' ? C.ink : state === 'local' ? C.leaf : C.hairlineHi}`,
              background: state === 'local' ? 'rgba(62,158,82,0.08)' : C.surface,
              color: state === 'on' ? C.ink : state === 'local' ? C.leaf : C.gray,
              borderRadius: 999,
              padding: '6px 13px',
              fontSize: 17,
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: state === 'local' ? C.leaf : state === 'on' ? C.ink : C.faint,
              }}
            />
            {name}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: C.gray }}>API key</span>
        <div
          style={{
            border: `1px solid ${C.hairlineHi}`,
            background: C.surface,
            borderRadius: 10,
            padding: '12px 15px',
            fontSize: 19,
            color: C.ink,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          sk-proj-••••••••••••••••
        </div>
      </div>

      <div
        style={{
          border: `1px solid ${C.leaf}`,
          background: 'rgba(62,158,82,0.07)',
          borderRadius: 10,
          padding: '11px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 600, color: C.leaf }}>✓ Connected</span>
        <span style={{ fontSize: 16, color: C.gray }}>
          or <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>localhost:11434</span> — never
          leaves your machine
        </span>
      </div>
    </Frame>
  )
}

function Ask() {
  return (
    <Frame
      head={
        <>
          <Mark size={22} />
          <span style={{ fontSize: 20, fontWeight: 700, color: C.ink }}>Lychee</span>
        </>
      }
    >
      <div
        style={{
          alignSelf: 'flex-end',
          maxWidth: '82%',
          background: C.ink,
          color: '#fff',
          borderRadius: '14px 14px 3px 14px',
          padding: '10px 14px',
          fontSize: 19,
          fontWeight: 500,
          lineHeight: 1.35,
        }}
      >
        What's the catch on this page?
      </div>

      <span
        style={{
          alignSelf: 'flex-start',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          border: `1px solid ${C.hairlineHi}`,
          background: C.bg,
          borderRadius: 999,
          padding: '6px 13px',
          fontSize: 16,
          fontWeight: 600,
          color: C.gray,
        }}
      >
        <span style={{ color: C.leaf }}>✓</span> ReadPage
      </span>

      <div
        style={{
          alignSelf: 'flex-start',
          maxWidth: '88%',
          background: C.bg,
          border: `1px solid ${C.hairline}`,
          borderRadius: '14px 14px 14px 3px',
          padding: '11px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          fontSize: 18,
          lineHeight: 1.35,
        }}
      >
        <span style={{ color: C.ink }}>Free for 14 days, then $29/mo.</span>
        <span style={{ color: C.red, fontWeight: 600 }}>⚠ Annual billing is pre-selected.</span>
      </div>

      <div
        style={{
          marginTop: 'auto',
          border: `1px solid ${C.hairlineHi}`,
          background: C.surface,
          borderRadius: 999,
          padding: '11px 16px',
          fontSize: 18,
          color: C.faint,
        }}
      >
        Message Lychee…
      </div>
    </Frame>
  )
}

const VARIANTS: Record<StepVariant, () => React.JSX.Element> = {
  install: Install,
  connect: Connect,
  ask: Ask,
}

export default function StepMock({ variant }: { variant: StepVariant }) {
  const box = useRef<HTMLDivElement>(null)
  const Body = VARIANTS[variant]

  // Same measured scale-to-fit as SceneMock — CSS alone can't express it
  // without container-query maths that clamps badly at small font sizes.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => el.style.setProperty('--mock-scale', String(el.clientWidth / W))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={box} className="mock stepmock" style={{ aspectRatio: `${W} / ${H}` }}>
      <div className="mock__inner" style={{ width: W, height: H }}>
        <Body />
      </div>
    </div>
  )
}
