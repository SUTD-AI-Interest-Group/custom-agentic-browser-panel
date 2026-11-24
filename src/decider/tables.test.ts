import { expect, it } from 'vitest'
import { dequantRow, rowBytes, TableReader, type ReadAt } from './tables'

function block(scale: number, vals: number[]): Uint8Array {
  const b = new Uint8Array(4 + vals.length)
  new DataView(b.buffer).setFloat32(0, scale, true)
  new Int8Array(b.buffer, 4).set(vals)
  return b
}

it('rowBytes is blocks*(4+blockSize)', () => {
  expect(rowBytes(6, 256)).toBe(6 * 260)
})

it('dequantizes int8 x scale', () => {
  const out = new Float32Array(2)
  dequantRow(block(0.5, [-2, 4]), out, 0, 1, 2)
  expect([...out]).toEqual([-1, 2])
})

it('reads rows in the requested order, contiguously', () => {
  const r0 = block(1, [1, 2]), r1 = block(2, [3, 4])
  const file = new Uint8Array([...r0, ...r1])
  const fake: ReadAt = {
    read(buf, { at }) { buf.set(file.subarray(at, at + buf.length)); return buf.length },
  }
  const out = new Float32Array(4)
  new TableReader(fake, 1, 2).rows([1, 0], out)
  expect([...out]).toEqual([6, 8, 1, 2])
})

it('throws on a short read', () => {
  const fake: ReadAt = { read: () => 1 }
  expect(() => new TableReader(fake, 1, 2).rows([0], new Float32Array(2))).toThrow(/short read/)
})

it('reads each distinct row once per call, copying repeats', () => {
  const r0 = block(1, [1, 2]), r1 = block(2, [3, 4])
  const file = new Uint8Array([...r0, ...r1])
  const at: number[] = []
  const fake: ReadAt = {
    read(buf, opts) { at.push(opts.at); buf.set(file.subarray(opts.at, opts.at + buf.length)); return buf.length },
  }
  const out = new Float32Array(10)
  new TableReader(fake, 1, 2).rows([1, 0, 1, 1, 0], out)
  expect([...out]).toEqual([6, 8, 1, 2, 6, 8, 6, 8, 1, 2])
  expect(at).toEqual([6, 0])
})
