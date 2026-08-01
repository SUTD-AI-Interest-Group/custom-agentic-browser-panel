# Prompt attachments: drag-and-drop / paste / picker for images, PDFs, and text files

**Date:** 2026-08-02 · **Status:** Approved (types: images+PDF+text-like; PDF delivery: hybrid native/page-screenshots; persistence: capped store; architecture: pure planner)

## Summary

Users can attach files to a chat message three ways — drag-and-drop onto the side panel, paste
into the composer, or a paperclip file-picker — and the attachments travel with the prompt.
Images ride the existing camera-capture pipeline (downscaled data URL → `file` part in the user
message). Documents have **no provider-agnostic wire format**, so a new pure planner
(`planAttachmentDelivery`) routes each attachment per provider capability and model vision:
native PDF parts on Anthropic/OpenAI, rendered page screenshots on vision-capable models behind
the OpenAI-compatible adapter, budgeted pdf.js text extraction for blind models, and inline
fenced text for text-like files. Attachment bytes persist once in a new capped IndexedDB store
(modeled on the screenshots DB); the conversation record and model history hold only references,
rehydrated at the save/load boundary.

## Why not "just attach the file"

Established by adapter-source inspection and provider docs (2026-08-02):

| Provider path | Native doc support | Notes |
|---|---|---|
| Anthropic (native adapter) | ✅ PDF `document` block | 32MB/request (base64-inflated), 100–600 pages |
| OpenAI (native Responses adapter) | ✅ `input_file` | PDF/Office/sheets, 50MB per file and request |
| Groq / Ollama / LM Studio / custom (`@ai-sdk/openai-compatible`) | ❌ | Adapter converts only `image/*`, `audio/*`, `application/pdf` (as chat-completions `file`, which these backends reject) and auto-inlines `text/*`; other types **throw `UnsupportedFunctionalityError`**, 400ing the whole request. Backends themselves accept only `image_url`. |
| OpenRouter | ⚠️ proprietary `plugins`/`file` extension only | Needs custom body injection; **out of scope** |

Every comparable no-backend client (LibreChat "Upload as Text", Jan.ai, Page Assist — a
side-panel extension architecturally identical to Lychee) defaults to client-side extraction and
inline injection; none default to local RAG. Lychee already ships the extraction machinery:
pdf.js behind `src/platform/pdf.ts` (lazy-loaded, budgeted, LRU-cached).

## Accepted types & limits

| Kind | Types | Per-file limit | Notes |
|---|---|---|---|
| Image | png, jpeg, webp, gif | downscaled to ≤1400px long edge (same `MAX_SIDE` as camera captures) | rides existing pipeline |
| PDF | `application/pdf` (magic-byte sniffed) | 50MB (matches `MAX_PDF_BYTES`) | password-protected → per-file error |
| Text-like | `text/*`, plus extension allowlist (md, csv, json, ts, py, …) with binary sniff | 2MB raw; ~48k chars into the prompt with truncation notice | decoded via `file.text()` |

Max 10 attachments per message. Every violation is a **per-file error chip** (existing
`.capture-error` styling) — never a silent drop, and never a constructed part that could 400 the
whole request on the compat adapter.

## UX

- **Drag-and-drop.** Window-level `dragover`/`drop` `preventDefault()` guards so a stray drop
  can never navigate the panel to the file (the panel has no back-button recovery). Guards fire
  only when `DataTransfer.types` includes `Files`, so plain text/URL drags into the textarea
  keep working. A file-drag entering the panel shows a full-panel "Drop to attach" overlay
  (dragenter/dragleave counter); dropping anywhere attaches.
- **Paste.** `onPaste` on the composer textarea: when `clipboardData` carries files (screenshot
  paste, Finder copy), attach them and suppress the text insertion; otherwise untouched.
- **Picker.** Paperclip button in `.composer-btns` beside the camera button, backed by a hidden
  `<input type="file" multiple>` with the accept list — the exact pattern already used in
  `SkillEditor.tsx` and `McpSection.tsx` (including the `value = ''` reset).
- **Chips.** One `.attachment-row` for everything: images keep the current `.attachment-thumb`
  thumbnail; PDFs/text files get a file chip (type icon + filename + size/page count +
  hover-reveal ×) styled from the existing pill tokens. A PDF chip shows a brief loading state
  while pdf.js reads the page count at attach time (which also validates the file early).
- **Bubbles.** Sent messages render attachment chips/thumbnails from `UIMessage.attachments`
  metadata (thumbnail data URL for images, icon+name for docs).

Camera captures (`capture()` in Chat.tsx) and the right-click "Ask Lychee about this image" path
are **unified into the same attachment model** — one composer state array, one send path, one
persistence story. `MessageSpec.images: CapturedImage[]` becomes
`MessageSpec.attachments: ComposerAttachment[]`.

## Data model & persistence

### Composer state

```ts
type ComposerAttachment =
  | { kind: 'image'; id: string; name: string; dataUrl: string; width: number; height: number }
  | { kind: 'pdf'; id: string; name: string; bytes: Uint8Array; byteSize: number; pageCount: number }
  | { kind: 'text'; id: string; name: string; text: string; byteSize: number }
```

### Capped attachments store — `src/data/attachments.ts`

New IndexedDB `lychee-attachments`, modeled directly on `src/data/screenshots.ts`: one record
per attachment (`{ id, meta, bytes: Blob, thumb?: string }`), total-size cap (100MB) and 30-day
age pruning on write, JPEG thumbnails for images. Written **at send time only** — an abandoned
draft costs nothing. Records stay retrievable by id so a future `ReadAttachment` tool can bolt
on without rework.

### Transcript

`UIMessage` gains `attachments?: AttachmentMeta[]`
(`{ id, kind, name, byteSize, pageCount?, thumbDataUrl? }`). The legacy inline `images?: string[]`
field remains readable so existing stored conversations render unchanged.

### Model history: dehydrate/hydrate boundary

`ModelMessage[]` history must carry the real bytes when sent, but must not balloon the
conversation record. `conversations.ts` gains a chokepoint pair (same shape as the vault's
seal/open):

- Parts built from attachments carry `providerOptions: { lychee: { attachmentId } }` — a
  namespace no adapter reads, so nothing leaks to the wire.
- **Dehydrate (at save):** any file part with a `lychee.attachmentId` has its `data` swapped for
  the sentinel string `attachment:<id>`.
- **Hydrate (at load):** sentinels resolve back to bytes from the attachments store. A pruned or
  missing attachment becomes a text part: `[attachment "report.pdf" is no longer available]` —
  never a broken file part.

Both functions are pure given a `resolve(id)` lookup and unit-tested, including the
missing-attachment case.

## Delivery planner — `src/agent/attachmentPlan.ts`

Pure module (no Chrome/AI-SDK imports) + `attachmentPlan.test.ts`, same species as
`planShotDelivery`/`planTabProbe`. Input: attachment descriptor + `{ nativeDocs: boolean,
nativeDocMaxBytes: number, visionCapable: boolean }`. Output: a routing decision the impure
executor turns into message parts.

| Attachment | nativeDocs | vision | Route |
|---|---|---|---|
| image | — | ✅ | image `file` part (`{type:'file', mediaType:'image', data}` — the existing shape) |
| image | — | ❌ | kept for the user in the bubble; model gets a text note naming the image it cannot see (closes the pre-existing blind-model gap for user images) |
| pdf ≤ cap | ✅ | — | native `application/pdf` file part (Anthropic `document` / OpenAI `input_file` via the adapters) |
| pdf | ❌ or oversize | ✅ | **page screenshots:** render pages 1–`PAGE_BUDGET` (20) via existing `renderPdfPage` (1400px long edge), one image part per page captioned `"name — page k of N"`, plus a "first 20 of N pages shown" note when truncated |
| pdf | ❌ or oversize | ❌ | budgeted text extraction via existing `assemblePagesText` + truncation note |
| text | — | — | fenced block appended to the model text: `--- attached file: name ---` header, 48k-char budget + truncation note |

An oversized PDF on a native provider degrades down the same ladder (screenshots → text).
`ensureVisionCapability` (cached per provider+model) is awaited during send assembly before
planning.

## Supporting changes

- **`src/data/providerProfiles.ts`** — per-kind `supportsNativeDocuments: boolean` (true:
  `anthropic`, `openai`; false: everything else) and `nativeDocMaxBytes` (Anthropic 20MB raw —
  clears the 32MB base64-inflated request ceiling with prompt headroom; OpenAI 45MB). Pure,
  tested alongside the existing profile fields.
- **`src/platform/pdf.ts`** — `loadPdfFromBytes(bytes: Uint8Array, cacheKey: string)`: shares
  `doLoad`/`getEntry`, skips `fetchPdfBytes`, keeps the `%PDF-` sniff and `MAX_EXTRACT_PAGES`
  caps; cache key derived from the attachment id. pdf.js stays a dynamic import — non-PDF users
  pay no bundle cost. All attachment parsing/rendering runs in the panel (a page-like context,
  per the pdf.ts invariant).
- **`buildUserTurn` (Chat.tsx)** — consumes the executed plan: image/PDF file parts into the
  user-message content array, extracted/inline text appended to the model text. `injectSteer`
  inherits everything because it shares `buildUserTurn`.

## Error handling

- Unsupported type, oversize file, >10 attachments, password-protected/corrupt PDF, empty text
  file → per-file error line under the composer; the rest of the batch still attaches.
- pdf.js load failure at attach time surfaces immediately (the page-count read doubles as
  validation) rather than at send.
- Vault/store write failure at send time: the message still sends (attachment parts already in
  memory); the transcript falls back to inline metadata without a thumbnail and a console warn —
  availability over bookkeeping.
- Hydration of a conversation whose attachments were pruned yields the explicit
  "no longer available" text part; the UI chip renders greyed with a tooltip.

## Testing

- `attachmentPlan.test.ts` — full routing matrix (image/pdf/text × nativeDocs × vision ×
  oversize), page-budget truncation, caption text.
- Text budgeting — truncation notice, fence header, char budget.
- Dehydrate/hydrate — round-trip identity, sentinel swap, missing-attachment note,
  non-attachment file parts untouched.
- `providerProfiles.test.ts` — new flags per kind.
- pdf byte-entry — magic-byte rejection of non-PDF bytes (pure part).
- End-to-end via `/verify-extension`: drop/paste/pick on each kind, send on an Anthropic and an
  OpenAI-compatible provider, reload a stored conversation, prune-and-reload.

## Out of scope (explicit)

- `.docx`/Office parsing (would need a new dependency; OpenAI-native users still get Office docs
  via `input_file` when dropped as PDFs — conversion is on the user for v1).
- OpenRouter's proprietary `file-parser` plugin (custom body injection for one provider).
- Local RAG / vector search (no comparable product defaults to it for composer attachments).
- `ReadAttachment` agentic-reading tool for oversized files — **v2**; the store's
  retrievable-by-id design is the only v1 concession to it.
- Pruning attachment parts out of *model history* after N turns (token-cost optimization;
  Anthropic prompt caching blunts the cost today).
