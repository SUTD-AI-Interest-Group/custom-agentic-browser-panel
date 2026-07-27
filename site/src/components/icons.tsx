/**
 * Hand-inlined SVGs rather than an icon dependency. Six icons do not justify a
 * package, and inlining keeps them themable through `currentColor`.
 */
type P = { size?: number }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
})

export const Check = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const ShieldCheck = ({ size = 20 }: P) => (
  <svg {...base(size)}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
)

export const Play = ({ size = 13 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M8 5v14l11-7z" />
  </svg>
)

export const X = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const ArrowLeft = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
)

export const Telescope = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44" />
    <path d="m13.56 11.747 4.332-.924" />
    <path d="m16 21-3.105-6.21" />
    <path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z" />
    <path d="m6.158 8.633 1.114 4.456" />
    <path d="m8 21 3.105-6.21" />
    <circle cx="12" cy="13" r="2" />
  </svg>
)

export const Wrench = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
)

export const Sparkles = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  </svg>
)

export const Cursor = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="M4.037 4.688a.5.5 0 0 1 .65-.651l16 6.5a.5.5 0 0 1-.51.858l-6.87-2.79 2.79 6.87a.5.5 0 0 1-.858.51z" />
  </svg>
)

export const Moon = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9" />
  </svg>
)

export const Activity = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  </svg>
)
