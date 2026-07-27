import { useEffect, useRef } from 'react'

/**
 * The launch film's product mock, ported from
 * publicity/lychee-launch/src/scenes/S2Product.tsx as live DOM.
 *
 * Why a port rather than the Remotion components themselves: those are built on
 * `useCurrentFrame` / `interpolate` / `AbsoluteFill` and need the Remotion
 * runtime to render at all. Pulling that into a landing page costs a large
 * dependency to draw a static composition. Instead the exact markup, colours,
 * radii, spacing and copy are reproduced with every animated value resolved to
 * its settled state — which is the frame the page wants anyway.
 *
 * It is laid out at the film's native 1220×830 and scaled to fit its container,
 * so proportions and type hierarchy stay identical to the video instead of
 * being re-guessed at web sizes. Text is real text: it stays crisp at any zoom,
 * is selectable, and costs ~2 KB instead of a 30 KB JPEG per step.
 */

const W = 1220
const H = 830

export type SceneVariant = 'read' | 'control' | 'skills' | 'memory' | 'local'

/* Palette lifted verbatim from publicity/lychee-launch/src/theme.ts. Exported
   because StepMock draws its own compositions and must not re-guess these. */
export const C = {
  surface: '#ffffff',
  page: '#fbfbfd',
  bg: '#f5f5f7',
  ink: '#1d1d1f',
  gray: '#6e6e73',
  faint: '#a1a1a6',
  hairline: 'rgba(0,0,0,0.10)',
  hairlineHi: 'rgba(0,0,0,0.18)',
  red: '#c9304a',
  leaf: '#3e9e52',
}

function Line({ w, h = 12, color = 'rgba(0,0,0,0.10)' }: { w: number | string; h?: number; color?: string }) {
  return <div style={{ width: w, height: h, borderRadius: h / 2, background: color, flexShrink: 0 }} />
}

/** The three pricing cards the film's page skeleton draws. */
function PricingCards({ spotlight }: { spotlight?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 20, marginTop: 38 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: 350,
            borderRadius: 14,
            border: `1px solid ${i === 1 ? C.hairlineHi : C.hairline}`,
            background: C.surface,
            boxShadow: '0 8px 24px rgba(0,0,0,0.05)',
            padding: 22,
            position: 'relative',
            // The page-control beat rings the card the agent is about to click.
            outline: spotlight && i === 1 ? `3px solid ${C.red}` : undefined,
            outlineOffset: spotlight && i === 1 ? 3 : undefined,
          }}
        >
          <Line w="52%" h={16} color="rgba(0,0,0,0.16)" />
          <div style={{ height: 18 }} />
          <Line w="42%" h={28} color={i === 1 ? 'rgba(201,48,74,0.5)' : 'rgba(0,0,0,0.22)'} />
          <div style={{ height: 22 }} />
          <Line w="85%" h={9} />
          <div style={{ height: 10 }} />
          <Line w="72%" h={9} />
          <div style={{ height: 10 }} />
          <Line w="80%" h={9} />
          {spotlight && i === 1 && (
            <div
              style={{
                position: 'absolute',
                right: 26,
                bottom: 26,
                width: 30,
                height: 30,
                borderRadius: '50%',
                border: `3px solid ${C.red}`,
                background: 'rgba(201,48,74,0.16)',
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function Chip({ label, tone = 'gray' }: { label: string; tone?: 'gray' | 'leaf' }) {
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        border: `1px solid ${C.hairlineHi}`,
        background: C.bg,
        borderRadius: 999,
        padding: '8px 16px',
        fontSize: 20,
        fontWeight: 600,
        color: C.gray,
      }}
    >
      <span style={{ color: tone === 'leaf' ? C.leaf : C.gray }}>✓</span> {label}
    </div>
  )
}

function Bubble({ text }: { text: string }) {
  return (
    <div
      style={{
        alignSelf: 'flex-end',
        maxWidth: 335,
        background: C.ink,
        color: '#fff',
        borderRadius: '18px 18px 4px 18px',
        padding: '13px 18px',
        fontSize: 23,
        fontWeight: 500,
        lineHeight: 1.4,
      }}
    >
      {text}
    </div>
  )
}

function Reply({ lines }: { lines: [string, boolean][] }) {
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: 370,
        background: C.bg,
        border: `1px solid ${C.hairline}`,
        borderRadius: '18px 18px 18px 4px',
        padding: '15px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 11,
      }}
    >
      {lines.map(([line, warn]) => (
        <div key={line} style={{ fontSize: 22, lineHeight: 1.4, color: warn ? C.red : C.ink, fontWeight: warn ? 600 : 400 }}>
          {line}
        </div>
      ))}
    </div>
  )
}

function PanelBody({ variant }: { variant: SceneVariant }) {
  if (variant === 'control') {
    return (
      <>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            alignSelf: 'stretch',
            border: `1px solid ${C.leaf}`,
            background: 'rgba(62,158,82,0.08)',
            borderRadius: 12,
            padding: '10px 16px',
            fontSize: 19,
            fontWeight: 600,
            color: C.leaf,
          }}
        >
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: C.leaf }} />
          Page control · granted
        </div>
        <Bubble text="Pick the Pro plan and start checkout." />
        <Chip label="RequestPageControl" tone="leaf" />
        <Reply
          lines={[
            ['Clicking “Pro — $29/mo”.', false],
            ['⚠ Checkout is a point of no return — confirming first.', true],
          ]}
        />
      </>
    )
  }

  if (variant === 'skills') {
    return (
      <>
        <Bubble text="/compare-plans across these three tabs" />
        <Chip label="ReadSkill" tone="leaf" />
        <div
          style={{
            alignSelf: 'stretch',
            border: `1px solid ${C.hairlineHi}`,
            background: C.surface,
            borderRadius: 14,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.07)',
          }}
        >
          {[
            ['/compare-plans', 'Pull pricing from every open tab', true],
            ['/summarize-page', 'Three bullets and the catch', false],
            ['/extract-table', 'Any table → clean CSV', false],
          ].map(([name, desc, active]) => (
            <div
              key={name as string}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                padding: '11px 16px',
                background: active ? C.bg : 'transparent',
                borderLeft: `3px solid ${active ? C.red : 'transparent'}`,
              }}
            >
              <span style={{ fontSize: 20, fontWeight: 600, color: C.ink, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {name}
              </span>
              <span style={{ fontSize: 17, color: C.gray }}>{desc}</span>
            </div>
          ))}
        </div>
      </>
    )
  }

  if (variant === 'memory') {
    return (
      <>
        <Bubble text="Remember my plan preferences from this page." />
        <Chip label="SaveMemory" tone="leaf" />
        <div
          style={{
            alignSelf: 'stretch',
            border: `1px solid ${C.leaf}`,
            background: 'rgba(62,158,82,0.07)',
            borderRadius: 14,
            padding: '14px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '0.08em', color: C.leaf }}>MEMORY SAVED</span>
          <span style={{ fontSize: 21, lineHeight: 1.4, color: C.ink }}>
            Prefers annual billing, and always wants the per-seat price called out.
          </span>
        </div>
        <Reply lines={[['Saved. I’ll bring this up next time you compare plans.', false]]} />
      </>
    )
  }

  if (variant === 'local') {
    return (
      <>
        <div style={{ fontSize: 21, fontWeight: 600, color: C.ink }}>Connect a model</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9 }}>
          {[
            ['OpenAI', false],
            ['Anthropic', false],
            ['OpenRouter', false],
            ['Groq', false],
            ['Ollama', true],
            ['LM Studio', true],
          ].map(([name, local]) => (
            <span
              key={name as string}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                border: `1px solid ${local ? C.leaf : C.hairlineHi}`,
                background: local ? 'rgba(62,158,82,0.08)' : C.surface,
                color: local ? C.leaf : C.gray,
                borderRadius: 999,
                padding: '7px 14px',
                fontSize: 18,
                fontWeight: 600,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: local ? C.leaf : C.faint }} />
              {name}
            </span>
          ))}
        </div>
        <div
          style={{
            alignSelf: 'stretch',
            border: `1px solid ${C.leaf}`,
            background: 'rgba(62,158,82,0.07)',
            borderRadius: 12,
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          <span
            style={{ fontSize: 19, fontWeight: 600, color: C.ink, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          >
            http://localhost:11434
          </span>
          <span style={{ fontSize: 17, color: C.leaf, fontWeight: 600 }}>✓ Connected · runs entirely on your machine</span>
        </div>
      </>
    )
  }

  return (
    <>
      <Bubble text="Summarize this pricing page — flag anything unusual." />
      <Chip label="ReadPage" tone="leaf" />
      <Reply
        lines={[
          ['Three tiers. Pro is $29/month.', false],
          ['⚠ Annual billing is pre-selected.', true],
          ['I can compare every plan next.', false],
        ]}
      />
    </>
  )
}

export default function SceneMock({ variant }: { variant: SceneVariant }) {
  const box = useRef<HTMLDivElement>(null)

  // The mock is laid out at native film size and scaled down. CSS alone can't
  // express "scale to fit" without container-query maths that clamps badly at
  // small font sizes, so the ratio is measured and written to a variable.
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
    <div ref={box} className="mock" style={{ aspectRatio: `${W} / ${H}` }}>
      <div className="mock__inner" style={{ width: W, height: H }}>
        <div className="mock__window">
          <div className="mock__titlebar">
            {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
              <span key={c} style={{ width: 15, height: 15, borderRadius: '50%', background: c, flexShrink: 0 }} />
            ))}
            <div className="mock__url">acme.com/pricing</div>
          </div>

          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div style={{ flex: 1, padding: 34, background: C.page, minWidth: 0 }}>
              <Line w={290} h={24} color="rgba(0,0,0,0.16)" />
              <div style={{ height: 24 }} />
              <Line w={450} />
              <div style={{ height: 11 }} />
              <Line w={400} />
              <PricingCards spotlight={variant === 'control'} />
            </div>

            <div className="mock__panel">
              <div className="mock__panelhead">
                <span style={{ width: 16, height: 16, borderRadius: '50%', background: C.red }} />
                <span style={{ fontSize: 25, fontWeight: 700, color: C.ink }}>Lychee</span>
              </div>
              <div className="mock__panelbody">
                <PanelBody variant={variant} />
              </div>
              <div style={{ padding: 18, flexShrink: 0 }}>
                <div className="mock__composer">Message Lychee…</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
