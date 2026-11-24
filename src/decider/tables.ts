// Block-int8 table reader. Each block is a little-endian f32 scale followed by `blockSize` int8
// values; a row is `blocks` consecutive blocks. Rows are pre-scaled by the exporter.

export function rowBytes(blocks: number, blockSize: number): number {
  return blocks * (4 + blockSize)
}

export function dequantRow(
  src: Uint8Array,
  out: Float32Array,
  outOffset: number,
  blocks: number,
  blockSize: number,
): void {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const ints = new Int8Array(src.buffer, src.byteOffset, src.byteLength)
  const stride = 4 + blockSize
  for (let b = 0; b < blocks; b++) {
    const base = b * stride
    const scale = view.getFloat32(base, true)
    const o = outOffset + b * blockSize
    for (let i = 0; i < blockSize; i++) out[o + i] = ints[base + 4 + i] * scale
  }
}

/** The slice of FileSystemSyncAccessHandle the reader needs. */
export interface ReadAt {
  read(buf: Uint8Array, opts: { at: number }): number
}

export class TableReader {
  private readonly buf: Uint8Array
  readonly valuesPerRow: number
  constructor(
    private readonly file: ReadAt,
    private readonly blocks: number,
    private readonly blockSize: number,
  ) {
    this.buf = new Uint8Array(rowBytes(blocks, blockSize))
    this.valuesPerRow = blocks * blockSize
  }

  /**
   * Writes the dequantized rows for `ids` back to back into `out`. Token sequences repeat ids
   * heavily (common words, punctuation, the fixed instruction tokens every request re-emits), so
   * each distinct id is read and dequantized once per call and later occurrences copy the row
   * already written to `out`.
   */
  rows(ids: number[], out: Float32Array): void {
    const n = this.buf.length
    const w = this.valuesPerRow
    const first = new Map<number, number>()
    ids.forEach((id, i) => {
      const seen = first.get(id)
      if (seen !== undefined) {
        out.copyWithin(i * w, seen * w, (seen + 1) * w)
        return
      }
      const got = this.file.read(this.buf, { at: id * n })
      if (got !== n) throw new Error(`table: short read for row ${id} (${got}/${n})`)
      dequantRow(this.buf, out, i * w, this.blocks, this.blockSize)
      first.set(id, i)
    })
  }
}
