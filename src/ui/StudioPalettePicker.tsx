import { useRef, useState } from 'react'
import {
  pairedPalette,
  wrapHue,
  type StudioPalette,
} from '../data/studioPalette'

export default function StudioPalettePicker({
  value,
  onChange,
}: {
  value: StudioPalette
  onChange: (value: StudioPalette) => void
}) {
  const [selected, setSelected] = useState<'background' | 'text'>('background')
  const dragging = useRef(selected)
  const pair = pairedPalette(value)
  const hue = selected === 'background' ? value.hue : pair.textHue
  const saturation =
    selected === 'background' ? value.saturation : pair.textSaturation
  function update(target: typeof selected, h: number, s: number) {
    onChange(
      target === 'background'
        ? { ...value, hue: wrapHue(h), saturation: s }
        : {
            ...value,
            textHueOffset: wrapHue(h - value.hue),
            textSaturation: s,
          },
    )
  }
  function point(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    const h = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 359
    const s = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) * 100
    update(dragging.current, Math.round(h), Math.round(s))
  }
  return (
    <div className="studio-palette">
      <div
        className="studio-trackpad"
        role="group"
        aria-label="Site color palette"
        onPointerDown={(e) => {
          const target = (e.target as HTMLElement)
            .closest('[data-tone]')
            ?.getAttribute('data-tone')
          dragging.current =
            target === 'text' || target === 'background' ? target : selected
          setSelected(dragging.current)
          e.currentTarget.setPointerCapture(e.pointerId)
          if (!target) point(e)
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) point(e)
        }}
      >
        <svg className="studio-palette-link" aria-hidden="true">
          <line
            x1={`${value.hue / 3.6}%`}
            y1={`${100 - value.saturation}%`}
            x2={`${pair.textHue / 3.6}%`}
            y2={`${100 - pair.textSaturation}%`}
          />
        </svg>
        {(['background', 'text'] as const).map((tone) => {
          const h = tone === 'background' ? value.hue : pair.textHue
          const s =
            tone === 'background' ? value.saturation : pair.textSaturation
          return (
            <button
              key={tone}
              type="button"
              className={`studio-palette-handle ${selected === tone ? 'selected' : ''}`}
              data-tone={tone}
              aria-label={`${tone === 'background' ? 'Background' : 'Text'} color selector`}
              title={
                tone === 'background' ? 'Background color' : 'Paired text color'
              }
              onFocus={() => setSelected(tone)}
              onKeyDown={(e) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                    e.key,
                  )
                )
                  return
                e.preventDefault()
                const step = e.shiftKey ? 10 : 2
                update(
                  tone,
                  h +
                    (e.key === 'ArrowLeft'
                      ? -step
                      : e.key === 'ArrowRight'
                        ? step
                        : 0),
                  Math.max(
                    0,
                    Math.min(
                      100,
                      s +
                        (e.key === 'ArrowDown'
                          ? -step
                          : e.key === 'ArrowUp'
                            ? step
                            : 0),
                    ),
                  ),
                )
              }}
              style={{
                left: `${h / 3.6}%`,
                top: `${100 - s}%`,
                background:
                  tone === 'background' ? pair.background : pair.foreground,
                color:
                  tone === 'background' ? pair.foreground : pair.background,
              }}
            >
              {tone === 'text' ? 'Aa' : <span aria-hidden="true">◯</span>}
            </button>
          )
        })}
      </div>
      <div className="studio-palette-toolbar">
        <button
          aria-pressed={selected === 'background'}
          onClick={() => setSelected('background')}
        >
          <i style={{ background: pair.background }} />
          Background
        </button>
        <button
          aria-pressed={selected === 'text'}
          onClick={() => setSelected('text')}
        >
          <i style={{ background: pair.foreground }} />
          Text
        </button>
        <button
          className="studio-pair-reset"
          title="Auto-pair text color"
          aria-label="Auto-pair text color"
          onClick={() =>
            onChange({
              ...value,
              textHueOffset: undefined,
              textSaturation: undefined,
            })
          }
        >
          ↺
        </button>
        <output
          title="Contrast of the generated background/text pair"
          aria-label="Palette contrast"
        >
          {pair.contrast.toFixed(1)}:1
        </output>
      </div>
      <div className="studio-sliders">
        <label>
          Hue
          <input
            aria-label="Hue"
            type="range"
            min="0"
            max="359"
            value={hue}
            onChange={(e) => update(selected, +e.target.value, saturation)}
          />
        </label>
        <label>
          Color
          <input
            aria-label="Saturation"
            type="range"
            min="0"
            max="100"
            value={saturation}
            onChange={(e) => update(selected, hue, +e.target.value)}
          />
        </label>
      </div>
    </div>
  )
}
