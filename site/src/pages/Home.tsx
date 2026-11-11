import { useEffect, useRef, useState } from 'react'
import { Cta, Footer, useReveal } from '../App'
import { Play, X, Telescope, Wrench, Sparkles, Cursor, Moon, Activity } from '../components/icons'
import Features from '../components/Features'
import PermissionScrub from '../components/PermissionScrub'
import QuickStart from '../components/QuickStart'

const CAPABILITIES = [
  [Telescope, 'Deep Research', 'Plans, searches, reads sources and writes a cited report in the background while you keep working.'],
  [Wrench, 'Tool Discovery', 'Loads only the tools a task actually needs, so the model stays focused instead of drowning in options.'],
  [Sparkles, 'Skills', 'Reusable instructions you write once and invoke by name for the work you repeat.'],
  [Cursor, 'Page Control', 'Clicks, types and fills forms while you watch — with a visible cursor and a spotlight on the page.'],
  [Moon, 'Memory & Dreaming', 'Conversations distil into durable memories overnight, so it remembers what actually matters.'],
  [Activity, 'Observability', 'Optional tracing of every turn — spans, tool calls and tokens — in your own dashboard.'],
] as const

const PROVIDERS = [
  ['OpenAI', false],
  ['Anthropic', false],
  ['OpenRouter', false],
  ['Groq', false],
  ['Ollama', true],
  ['LM Studio', true],
] as const

function Lightbox({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.current?.close()
      document.body.style.overflow = overflow
      if (opener?.isConnected) opener.focus()
    }
  }, [onClose])

  return (
    <dialog ref={dialog} className="lightbox" aria-label="Lychee AI launch film" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <button className="lightbox__close" onClick={onClose} aria-label="Close video">
        <X />
      </button>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video src="./media/lychee-film.mp4" controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />
    </dialog>
  )
}

export default function Home() {
  const ref = useReveal()
  const [film, setFilm] = useState(false)

  return (
    <div ref={ref as React.RefObject<HTMLDivElement>} className="home">
      {/* ── Hero ── */}
      <section className="shell hero">
        <div>
          <h1>Lychee AI</h1>
          <p className="hero__lead">
            Read pages and run browser tasks with your choice of model.
          </p>
          <div className="hero__ctas">
            <Cta />
            <button className="btn btn--ghost" onClick={() => setFilm(true)}>
              Watch the film
            </button>
          </div>
        </div>

        <div className="hero__figure">
          <button className="hero__media" onClick={() => setFilm(true)} aria-label="Play the Lychee AI launch film">
            <img src="./media/hero-poster.jpg" alt="Lychee browser side panel" />
            <span className="hero__play" aria-hidden="true"><Play /></span>
          </button>
        </div>
      </section>

      <div className="strip">
        <div className="shell strip__inner">
          <span>Works in</span>
          <strong>Chrome</strong>
          <strong>Edge</strong>
          <strong>Brave</strong>
          <strong>Arc</strong>
          <strong>Vivaldi</strong>
          <span>— any Chromium browser, version 116 or later</span>
        </div>
      </div>

      {/* ── Scroll-driven capability sequence · replaces the single reading
             block with five pinned steps ── */}
      <div id="how">
        <Features />
      </div>

      {/* ── Privacy · dark band, the film's drama beat ── */}
      <section className="band--dark" id="privacy-band">
        <div className="shell section">
          <div className="section__head section__head--center">
            <h2>Data stays on your device</h2>
            <p>
              There is no Lychee server. Your key, your conversations and your memories stay on your machine — and your
              page content goes straight to the model endpoint you configured, under your own account.
            </p>
          </div>

          <div className="flow">
            <div className="flow__node">
              <span className="flow__label">Your browser</span>
            </div>
            <div className="flow__arrow" aria-hidden="true">
              <span className="flow__line" />
              <span className="flow__head" />
            </div>
            <div className="flow__node flow__node--live">
              <span className="flow__label">your model endpoint</span>
            </div>
          </div>
          <p className="flow__caption">
            Nothing in between. No telemetry, no analytics, and nothing synced to Google's servers.{' '}
            <a href="#/privacy" style={{ textDecoration: 'underline' }}>
              Read the privacy policy
            </a>
            .
          </p>
        </div>
      </section>

      {/* ── Models ── */}
      <section className="band--models">
        <div className="shell section reveal">
          <div className="section__head section__head--center">
            <h2>Providers</h2>
            <p>
              Connect a hosted provider with your own API key, or point Lychee at a model running on your own machine
              and let nothing leave it at all.
            </p>
          </div>
          <div className="chips">
            {PROVIDERS.map(([name, local]) => (
              <span key={name} className={`chip${local ? ' chip--local' : ''}`}>
                <span className="chip__dot" aria-hidden="true" />
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Permissions · scroll-scrubbed, see components/PermissionScrub ── */}
      <PermissionScrub />

      {/* ── The agent loop ── */}
      <section className="band--dark">
        <div className="shell section reveal">
          <div className="section__head">
            <h2>Features</h2>
          </div>
          <div className="grid">
            {CAPABILITIES.map(([Icon, title, body]) => (
              <article className="cap" key={title}>
                <Icon />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Quick start · see components/QuickStart ── */}
      <QuickStart />

      {/* ── Final CTA · one button, per the CTA-strip rule. The footer is
             nested here so the page closes on a single black frame rather than
             a CTA followed by a separate slab of the same colour. ── */}
      <section className="band--dark closing">
        <div className="shell cta reveal">
          <h2>Install Lychee AI</h2>
          <Cta variant="invert" />
          <p className="cta__meta">Chrome 116+ · Requires your own model API key, or a local model</p>
        </div>
        <Footer />
      </section>

      {film && <Lightbox onClose={() => setFilm(false)} />}
    </div>
  )
}
