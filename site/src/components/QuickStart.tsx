import { useEffect, useRef, useState } from 'react'
import { Cta } from '../App'
import StepMock, { type StepVariant } from './StepMock'

/**
 * The quick-start section.
 *
 * It is the one section on the page that closes the loop from "here is what it
 * does" to "here is how you start", so it carries the only CTA between the hero
 * and the closing band. Deliberately *not* scroll-driven: the two sections
 * immediately before it already pin the viewport (Features, PermissionScrub),
 * and a third would be scroll fatigue rather than rhythm. Everything here
 * resolves in one screen, and the only motion is the seconds counting up.
 */

interface Step {
  n: number
  title: string
  body: string
  scene: StepVariant
  /** Seconds this step realistically takes. Summed for the headline claim. */
  seconds: number
}

const STEPS: Step[] = [
  {
    n: 1,
    title: 'Install',
    body: 'Add Lychee to Chrome from the Web Store and pin it to your toolbar.',
    scene: 'install',
    seconds: 20,
  },
  {
    n: 2,
    title: 'Connect a model',
    body: 'Paste an API key, or point it at Ollama or LM Studio on your own machine.',
    scene: 'connect',
    seconds: 20,
  },
  {
    n: 3,
    title: 'Say hello',
    body: 'Open any page, open the panel, and ask it something.',
    scene: 'ask',
    seconds: 7,
  },
]

/* Derived, never typed in twice: the headline claims under a minute and the
   eyebrow shows the total, so the two can't drift apart when a step changes. */
const TOTAL_SECONDS = STEPS.reduce((n, s) => n + s.seconds, 0)

const COUNT_MS = 1100

/**
 * Counts 0 → `to` once, the first time it is scrolled into view.
 *
 * Reduced motion gets the final value immediately — the number is the content,
 * the counting is the decoration.
 */
function useCountUp(to: number) {
  const ref = useRef<HTMLSpanElement>(null)
  const [n, setN] = useState(to)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    setN(0)
    let raf = 0
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return
        io.disconnect()
        const start = performance.now()
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / COUNT_MS)
          // Ease out: the last few seconds land slowly, which reads as settling
          // on a figure rather than stopping dead.
          setN(Math.round(to * (1 - Math.pow(1 - t, 3))))
          if (t < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      },
      { threshold: 0.6 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [to])

  return { ref, n }
}

export default function QuickStart() {
  const { ref, n } = useCountUp(TOTAL_SECONDS)

  return (
    <section className="band--page" id="quickstart">
      <div className="shell section quickstart reveal">
        <div className="section__head section__head--center">
          <p className="eyebrow">
            QUICK START ·{' '}
            <span className="quickstart__timer" ref={ref}>
              {n}s
            </span>
          </p>
          <h2>Live in under a minute.</h2>
          <p>No account to create, no team to invite, no card to enter.</p>
        </div>

        <ol className="quicksteps">
          {STEPS.map((s) => (
            <li className="quickstep" key={s.title}>
              <div className="quickstep__mark">
                <span className="quickstep__n">{s.n}</span>
                <span className="quickstep__time">~{s.seconds}s</span>
              </div>
              <div className="quickstep__frame">
                <StepMock variant={s.scene} />
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="quickstart__cta">
          <Cta />
          <p className="quickstart__meta">Chrome 116+ · Works in Edge, Brave, Arc and Vivaldi too</p>
        </div>
      </div>
    </section>
  )
}
