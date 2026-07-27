import { useEffect, useRef, useState } from 'react'
import SceneMock, { type SceneVariant } from './SceneMock'

/**
 * The scroll-driven capability sequence.
 *
 * Shape: the section is N × 100svh tall, and a single stage is `position:
 * sticky` inside it, so the stage stays pinned while the page scrolls through
 * the section's height. Invisible trigger elements sit at each 100svh boundary
 * and do two jobs at once — they are the IntersectionObserver targets that pick
 * the active step, and they are the `scroll-snap-align` targets, so snapping
 * stays one-stop-per-screen through this section exactly like every other one.
 *
 * Only the copy and the image cross-fade; nothing translates, so the whole
 * sequence degrades to a plain stack under `prefers-reduced-motion`.
 */

export interface Feature {
  key: string
  eyebrow: string
  title: string
  body: string
  /** Which live product mock this step shows. */
  scene: SceneVariant
}

export const FEATURES: Feature[] = [
  {
    key: 'read',
    scene: 'read',
    eyebrow: 'READ & ASK',
    title: 'Ask the page you’re on.',
    body: 'Point Lychee at an article, a pricing table, a dashboard — or a PDF — and ask. It reads the page you are on, and other open tabs when you ask it to compare.',
  },
  {
    key: 'control',
    scene: 'control',
    eyebrow: 'BROWSER USE',
    title: 'Let it drive, when you say so.',
    body: 'It clicks, types, scrolls and fills forms while you watch — a visible cursor and a spotlight show every step. Anything irreversible stops and asks again.',
  },
  {
    key: 'skills',
    scene: 'skills',
    eyebrow: 'SKILLS & MCP',
    title: 'Teach it your own moves.',
    body: 'Write reusable skills you invoke by name for the work you repeat, and connect Model Context Protocol servers to give it your own tools — each one behind its own permission.',
  },
  {
    key: 'memory',
    scene: 'memory',
    eyebrow: 'MEMORY & DREAMING',
    title: 'It remembers what mattered.',
    body: 'Conversations distil into durable memories while you are away, so the context you built yesterday is still there today. You can read, edit or wipe all of it.',
  },
  {
    key: 'local',
    scene: 'local',
    eyebrow: 'LOCAL FIRST',
    title: 'Run it entirely on your machine.',
    body: 'Bring a hosted provider with your own key, or point Lychee at Ollama or LM Studio on localhost and let nothing leave your computer at all.',
  },
]

export default function Features() {
  const sectionRef = useRef<HTMLElement>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const root = sectionRef.current
    if (!root) return
    const triggers = root.querySelectorAll<HTMLElement>('[data-step]')

    // A band across the middle of the viewport: whichever trigger is crossing
    // the centre line owns the stage. Cheaper and steadier than a scroll
    // handler doing its own maths on every frame.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step))
        }
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    )
    triggers.forEach((t) => io.observe(t))
    return () => io.disconnect()
  }, [])

  return (
    <section className="features" ref={sectionRef} aria-label="What Lychee can do">
      <div className="features__stage">
        <div className="shell features__inner">
          <div className="features__copy">
            <ol className="features__rail" aria-hidden="true">
              {FEATURES.map((f, i) => (
                <li key={f.key} className={i === active ? 'is-active' : undefined} />
              ))}
            </ol>

            {FEATURES.map((f, i) => (
              <div key={f.key} className={`features__text${i === active ? ' is-active' : ''}`} aria-hidden={i !== active}>
                <p className="eyebrow eyebrow--ink">{f.eyebrow}</p>
                <h2>{f.title}</h2>
                <p className="features__body">{f.body}</p>
              </div>
            ))}
          </div>

          <div className="features__media">
            {FEATURES.map((f, i) => (
              <div
                key={f.key}
                className={`features__scene${i === active ? ' is-active' : ''}`}
                aria-hidden={i !== active}
              >
                <SceneMock variant={f.scene} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Offsets are set here, not in CSS: `:nth-of-type` counts the sticky
          stage as the first div, so a stylesheet rule shifts every trigger by
          one and leaves the last one unpositioned. */}
      {FEATURES.map((f, i) => (
        <div
          className="features__trigger"
          data-step={i}
          key={f.key}
          style={{ top: `calc(${i} * 100svh)` }}
        />
      ))}
    </section>
  )
}
