import { useEffect, useRef, useState } from 'react'
import { Check, ShieldCheck } from './icons'

/**
 * The permission section as a scroll-scrubbed motion graphic.
 *
 * Shape: the section is 300svh tall with a 100svh stage pinned inside it, so
 * two screens of scroll travel drive the video's 10 seconds while the stage
 * stays put. The video is never played on the desktop path — its
 * `currentTime` is written directly from scroll position.
 *
 * Three modes, picked once on mount:
 *
 *   scrub   pointer-capable, motion allowed — the real thing.
 *   play    coarse pointer on a wide enough screen (tablets) — scrubbing a
 *           video by touch is jittery on iOS and burns battery decoding
 *           seeks, so the section collapses to a normal-height block and the
 *           clip plays through once when it comes into view.
 *   static  `prefers-reduced-motion`, or any narrow viewport. No video at
 *           all: the section renders the split layout as live DOM, which is
 *           what the page looked like before this component existed.
 *
 * The `<video>` is decorative: the heading and body copy live in the DOM as
 * real text (visually hidden on the video paths) so the document outline and
 * the copy survive for search engines and screen readers.
 */

const SRC = './media/permission-scrub.mp4'
const POSTER = './media/permission-scrub-poster.jpg'

/** Seconds. Must match `DURATION / FPS` in the Remotion composition. */
const CLIP_SECONDS = 10

/** How much of the gap to close per frame. Lower is heavier/smoother. */
const DAMPING = 0.14

/** Below this, the seek is imperceptible and not worth a decode. */
const SETTLED = 1 / 120

const HEADING = 'Nothing moves without you.'
const BODY =
  'Every action that touches a page, your data or the network asks first — and you set each capability to always allow, ask every time, or never. Steps you can’t take back stop and ask again, even mid-task.'

/**
 * Scroll progress through a pinned section, 0–1.
 *
 * `travel` is the section's height minus the pinned stage's, i.e. the
 * distance the page scrolls while the stage is stuck. Pure so the mapping
 * can be reasoned about without a browser.
 */
export function scrubProgress(top: number, height: number, stageHeight: number): number {
  const travel = height - stageHeight
  if (travel <= 0) return 0
  return Math.min(1, Math.max(0, -top / travel))
}

type Mode = 'scrub' | 'play' | 'static'

/**
 * Below this width the 16:9 frame is too short to read. A 390px phone gets a
 * 219px-tall stage, and the composition is a browser window with a side panel
 * and a six-field form — legible at 1440, illegible at 390. Narrow viewports
 * therefore get the live-DOM layout, which reflows and stays readable.
 */
const MIN_VIDEO_WIDTH = 700

function pickMode(): Mode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'static'
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'static'
  if (window.innerWidth < MIN_VIDEO_WIDTH) return 'static'
  if (window.matchMedia('(hover: none)').matches) return 'play'
  return 'scrub'
}

/** The original static section — the reduced-motion fallback, and the poster's subject. */
function StaticStage() {
  return (
    <div className="shell block block--flip">
      <div className="permscrub__card">
        <div className="card">
          <div className="card__head">
            <ShieldCheck />
            Lychee wants to control this page
          </div>
          <p className="card__body">
            It will fill the checkout form using your saved profile. It will not submit anything.
          </p>
          <ul className="card__scope">
            <li>
              <Check /> Read the form fields on this page
            </li>
            <li>
              <Check /> Type into 6 fields
            </li>
            <li>
              <Check /> Never submit — you stay in control
            </li>
          </ul>
          <div className="card__actions">
            <span className="btn btn--ghost btn--sm">Not now</span>
            <span className="btn btn--primary btn--sm">Allow</span>
          </div>
        </div>
      </div>
      <div>
        <h2>{HEADING}</h2>
        <p>{BODY}</p>
      </div>
    </div>
  )
}

export default function PermissionScrub() {
  const sectionRef = useRef<HTMLElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Resolved synchronously in the initializer, not in an effect: the two
  // modes have very different heights (300svh vs auto), and deciding after
  // first paint would resize the document under anyone already scrolled.
  // Safe to touch matchMedia here because the site is client-rendered.
  const [mode] = useState<Mode>(pickMode)
  const [armed, setArmed] = useState(false)

  /* Defer the fetch until the section is within a screen of the viewport —
     this is a multi-megabyte all-keyframe file and it sits well below the
     fold. `armed` is what puts a `src` on the element at all. */
  useEffect(() => {
    if (mode === 'static') return
    const el = sectionRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setArmed(true)
          io.disconnect()
        }
      },
      { rootMargin: '100% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [mode])

  /* Desktop: drive currentTime from scroll, damped. */
  useEffect(() => {
    if (mode !== 'scrub' || !armed) return
    const el = sectionRef.current
    const video = videoRef.current
    if (!el || !video) return

    let raf = 0
    let running = false
    // -1 marks "not yet positioned". Seeding from the first measured target
    // rather than 0 means arriving mid-section (a reload, a deep link) starts
    // at the right frame instead of racing there from the beginning.
    let current = -1

    const tick = () => {
      const rect = el.getBoundingClientRect()
      const stage = window.innerHeight
      const target = scrubProgress(rect.top, rect.height, stage) * CLIP_SECONDS
      current = current < 0 ? target : current + (target - current) * DAMPING

      if (video.readyState >= 2 && Math.abs(video.currentTime - current) > SETTLED) {
        video.currentTime = current
      }

      // Park the loop once the seek has caught up with the scroll; the
      // observer below restarts it on the next movement.
      if (Math.abs(target - current) > SETTLED) {
        raf = requestAnimationFrame(tick)
      } else {
        running = false
      }
    }

    const start = () => {
      if (running) return
      running = true
      raf = requestAnimationFrame(tick)
    }

    // Only listen while the section is anywhere near the viewport.
    let listening = false
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !listening) {
          listening = true
          window.addEventListener('scroll', start, { passive: true })
          window.addEventListener('resize', start)
          start()
        } else if (!e.isIntersecting && listening) {
          listening = false
          window.removeEventListener('scroll', start)
          window.removeEventListener('resize', start)
        }
      },
      { rootMargin: '10% 0px' },
    )
    io.observe(el)

    // The poster covers the element until there is a decoded frame to show.
    const onReady = () => start()
    video.addEventListener('loadeddata', onReady)
    video.pause()

    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', start)
      window.removeEventListener('resize', start)
      video.removeEventListener('loadeddata', onReady)
    }
  }, [mode, armed])

  /* Phones: play it through once when it comes into view. */
  useEffect(() => {
    if (mode !== 'play' || !armed) return
    const el = sectionRef.current
    const video = videoRef.current
    if (!el || !video) return

    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) void video.play().catch(() => {})
        else video.pause()
      },
      { threshold: 0.4 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [mode, armed])

  if (mode === 'static') {
    return (
      <section className="band--page" id="permissions">
        <StaticStage />
      </section>
    )
  }

  return (
    <section
      ref={sectionRef}
      className={`band--page permscrub permscrub--${mode}`}
      id="permissions"
      aria-labelledby="permscrub-heading"
    >
      <div className="permscrub__stage">
        <h2 id="permscrub-heading" className="visually-hidden">
          {HEADING}
        </h2>
        <p className="visually-hidden">{BODY}</p>
        <video
          ref={videoRef}
          className="permscrub__video"
          src={armed ? SRC : undefined}
          poster={POSTER}
          preload={armed ? 'auto' : 'none'}
          muted
          playsInline
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
    </section>
  )
}
