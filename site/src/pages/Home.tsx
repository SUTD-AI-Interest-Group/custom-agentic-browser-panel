import { useEffect, useState } from 'react'
import { Cta, Footer, useReveal } from '../App'
import { Play, X, Telescope, Wrench, Sparkles, Cursor, Moon, Activity } from '../components/icons'
import Features from '../components/Features'
import ModelMarquee from '../components/ModelMarquee'
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Lychee AI launch film" onClick={onClose}>
      <button className="lightbox__close" onClick={onClose} aria-label="Close video">
        <X />
      </button>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video src="./media/lychee-film.mp4" controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />
    </div>
  )
}

export default function Home() {
  const ref = useReveal()
  const [film, setFilm] = useState(false)

  return (
    <div ref={ref as React.RefObject<HTMLDivElement>} className="home">
      {/* ── Hero · H7, media deliberately clipped by the viewport edge ── */}
      <section className="shell hero">
        <div>
          <p className="hero__eyebrow">CHROME SIDE PANEL · BRING YOUR OWN MODEL</p>
          <h1>
            Ask the page.
            <br />
            Watch it work.
          </h1>
          <p className="hero__lead">
            An AI agent that reads what you're reading, acts on the page when you allow it, and runs on the model you
            choose. No backend. No account.
          </p>
          <div className="hero__ctas">
            <Cta />
            <button className="btn btn--ghost" onClick={() => setFilm(true)}>
              Watch the film
            </button>
          </div>
          <p className="hero__meta">
            Free and open source · Chrome 116+ · OpenAI, Anthropic, OpenRouter, Groq, or a local model
          </p>
        </div>

        {/* Caption sits below the frame, as drawn in the wireframe — it labels
            the loop rather than covering the product it's showing. */}
        <div className="hero__figure">
          <button className="hero__media" onClick={() => setFilm(true)} aria-label="Play the Lychee AI launch film">
            <video
              src="./media/hero-loop.mp4"
              poster="./media/hero-poster.jpg"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
            />
          </button>
          <p className="hero__caption">
            <Play /> 8s silent autoplay loop · click opens the 54s film
          </p>
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
            <p className="eyebrow">PRIVATE BY ARCHITECTURE</p>
            <h2>No backend. No cloud. No account.</h2>
            <p>
              There is no Lychee server. Your key, your conversations and your memories stay on your machine — and your
              page content goes straight to the model endpoint you configured, under your own account.
            </p>
          </div>

          <div className="flow">
            <div className="flow__node">
              <span className="flow__label">chrome.storage.local</span>
              <span className="flow__sub">your device</span>
            </div>
            <div className="flow__arrow" aria-hidden="true">
              <span className="flow__line" />
              <span className="flow__head" />
            </div>
            <div className="flow__node flow__node--live">
              <span className="flow__label">your model endpoint</span>
              <span className="flow__sub">OpenAI, Ollama, anything</span>
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

      {/* ── Models · the open-weight marquee drifts behind the copy, so the
             claim and the evidence for it share one frame ── */}
      <section className="band--models">
        <ModelMarquee />
        <div className="shell section reveal">
          <div className="section__head section__head--center">
            <h2>Your model. Your rules.</h2>
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
          <p className="chips__note">Green runs entirely on your machine — no key, no network.</p>
        </div>
      </section>

      {/* ── Permissions · scroll-scrubbed, see components/PermissionScrub ── */}
      <PermissionScrub />

      {/* ── The agent loop ── */}
      <section className="band--dark">
        <div className="shell section reveal">
          <div className="section__head">
            <p className="eyebrow">UNDER THE HOOD</p>
            <h2>One agent loop, six ways to use it.</h2>
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
          <h2>Give your browser an agent.</h2>
          <p>Free, open source, and private by architecture.</p>
          <Cta variant="invert" />
          <p className="cta__meta">Chrome 116+ · Requires your own model API key, or a local model</p>
        </div>
        <Footer />
      </section>

      {film && <Lightbox onClose={() => setFilm(false)} />}
    </div>
  )
}
