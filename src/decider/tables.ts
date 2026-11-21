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

  /** Writes the dequantized rows for `ids` back to back into `out`. */
  rows(ids: number[], out: Float32Array): void {
    const n = this.buf.length
    ids.forEach((id, i) => {
      const got = this.file.read(this.buf, { at: id * n })
      if (got !== n) throw new Error(`table: short read for row ${id} (${got}/${n})`)
      dequantRow(this.buf, out, i * this.valuesPerRow, this.blocks, this.blockSize)
    })
  }
}
