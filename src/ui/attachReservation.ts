// Tracks attachments "spoken for" by batches still being ingested (accepted for
// processing but not yet committed via setAttachments), so a concurrent second
// addFiles call's baseline count includes them.
//
// ingestFiles(files, existingCount) enforces MAX_ATTACHMENTS against whatever
// `existingCount` its caller passes — but Chat.tsx's only caller read a bare
// `attachments.length` snapshot BEFORE its own `await ingestFiles(...)`, which
// for a multi-file PDF/image batch can take real wall-clock time (arrayBuffer
// reads, pdf.js parsing). A second, overlapping addFiles call (a paste landing
// while an earlier drop's files are still being parsed) read that SAME
// pre-update count — React state hadn't committed yet — and could jointly
// exceed the cap. This module is the fix: reserve a batch's files the instant
// it's accepted, release them once it settles (success or error), and have
// Chat.tsx pass `attachments.length + pending` as ingestFiles's baseline
// instead of `attachments.length` alone.

export interface AttachReservation {
  /**
   * Reserve room for a new batch of `fileCount` files, given `committedCount`
   * already-settled attachments. Returns the baseline to pass to ingestFiles
   * as its `existingCount` — call once per batch, before its first await.
   */
  reserve(committedCount: number, fileCount: number): number
  /** Release a batch's reservation once it settles (success or error). */
  release(fileCount: number): void
}

export function createAttachReservation(): AttachReservation {
  let pending = 0
  return {
    reserve(committedCount, fileCount) {
      const existingCount = committedCount + pending
      pending += fileCount
      return existingCount
    },
    release(fileCount) {
      pending -= fileCount
    },
  }
}
