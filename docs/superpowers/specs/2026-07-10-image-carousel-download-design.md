# Image carousel with click-to-download — design

**Date:** 2026-07-10
**Status:** Approved (design)

## Problem

When the agent surfaces images (e.g. via the user's `get-images` skill), the
image URLs render through `Markdown.tsx` as a plain bulleted list of `<a>`
links. There is no visual preview and no easy way to save an image — the user
must open each link and download it manually. The current experience is poor.

## Goal

Render grouped image URLs from an assistant reply as a **full-width,
horizontally side-scrollable carousel** of thumbnails. Hovering a thumbnail
tints it and shows a download icon; clicking it downloads that image via the
system Save As dialog.

## Scope decisions (confirmed)

- **Trigger — generic, not skill-specific.** Any assistant reply containing
  **2+ consecutive image URLs** becomes a carousel. No changes to the
  `get-images` skill (or any other) are required, and it beautifies any future
  case where the agent lists images. Isolated inline image URLs in prose do
  **not** trigger it (guards against false positives).
- **Download — `chrome.downloads` + Save As dialog.** Clicking a thumbnail calls
  `chrome.downloads.download({ url, saveAs: true, filename })`, which pops the OS
  Save File dialog. Cross-origin images (e.g. `miro.medium.com`) can't be saved
  by a plain `<a download>`, so this is the reliable path. `downloads` is already
  in `optional_permissions`; the permission is requested once, inside the click
  gesture.

## Image sizing

- Thumbnails cap at **`max-height: 180px`**, `width: auto` — aspect ratio
  preserved, smaller images keep their natural size.
- `object-fit: cover` within the tile, `loading="lazy"`.

## Architecture

New and touched files, each with one clear responsibility:

### `src/ui/imageBlocks.ts` (new, pure)

`splitImageBlocks(text: string)` → ordered array of segments:

```ts
type ImageBlockSegment =
  | { type: 'markdown'; text: string }
  | { type: 'images'; urls: string[] }
```

- Operates **line by line** on the raw assistant text.
- A line is an "image line" only if, after stripping a leading list marker
  (`- `, `* `, `1. `), it is **just** a bare image URL or a markdown link/image
  whose target is an image URL — so a prose sentence that merely mentions an
  image URL does not match.
- An image URL = URL whose path ends in `.png`, `.jpg`, `.jpeg`, `.gif`,
  `.webp`, `.avif`, `.bmp`, `.svg`, or `.ico`, optionally followed by `?query`
  or `#fragment`.
- Runs of **≥2 consecutive** image lines collapse into one `images` segment;
  everything else (including a lone image line) stays in `markdown` segments.
- Pure and dependency-free, so it can be reasoned about and hand-tested in
  isolation.

### `src/ui/ImageCarousel.tsx` (new)

- Props: `{ urls: string[] }`.
- Renders a flex row scroller (`.img-carousel`) of tiles.
- Each tile: `<img loading="lazy">` capped at 180px height + a hover overlay
  (tint + centered download SVG icon).
- `onError` hides the failed tile.
- Click → `downloadImage(url)`.

### `src/platform/download.ts` (new)

`downloadImage(url: string): Promise<void>`:

1. `chrome.permissions.contains({ permissions: ['downloads'] })`; if absent,
   `chrome.permissions.request(...)` — must run inside the click gesture.
2. If granted: `chrome.downloads.download({ url, saveAs: true, filename })`,
   where `filename` is the sanitized last path segment of the URL.
3. If denied / unavailable: fall back to `chrome.tabs.create({ url })` so the
   user still reaches the image.

### `src/ui/Chat.tsx` (touched)

In `MessageView`'s assistant branch, replace the direct
`<Markdown text={part.text} />` for text parts with a map over
`splitImageBlocks(part.text)`: `markdown` segments render `<Markdown>`,
`images` segments render `<ImageCarousel>`. Order preserved.

### `src/ui/styles.css` (touched)

`.img-carousel` (flex, `overflow-x: auto`, full message-body width, momentum
scroll, contained overscroll) + tile, hover-overlay, and download-icon rules.
Theme-consistent with existing `.msg-images` / `.markdown` styling.

### `manifest.json`

No change — `downloads` is already listed under `optional_permissions`.

## Data flow

```
assistant text part
  → splitImageBlocks(text)               // src/ui/imageBlocks.ts
  → [markdown | images] segments
      markdown → <Markdown>              // existing
      images   → <ImageCarousel urls>    // new
                   tile onClick → downloadImage(url)  // src/platform/download.ts
                                    → chrome.downloads.download({ saveAs:true })
```

## Error handling

- **Broken image**: `onError` hides the tile. If every tile fails, the carousel
  is empty (acceptable; no crash).
- **Permission denied**: fall back to opening the image in a new tab.
- **Streaming**: `splitImageBlocks` re-runs each render; a partially-arrived list
  briefly shows fewer tiles and settles on completion.

## Security / invariants

- The download is a **UI-initiated action from an explicit user click**, so it
  correctly does **not** route through the agent `requestApproval` gate — that
  gate governs agent tools, not direct user interactions.
- No new host permissions; cross-origin fetch is not used (Chrome performs the
  download). Rendered thumbnails are `<img src>` to external URLs, same as
  existing markdown image rendering.

## Verification

No test suite. Verify via the `/verify-extension` flow: `npm run build`, reload
the unpacked extension, run the `get-images` skill on a page with images, and
confirm: (1) the URLs render as a full-width side-scrolling carousel, (2) images
cap at 180px tall, (3) hover shows the tint + download icon, (4) clicking opens
the Save As dialog and saves the file, (5) surrounding prose still renders as
markdown.
