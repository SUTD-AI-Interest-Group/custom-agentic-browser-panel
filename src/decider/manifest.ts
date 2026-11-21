// The model-bundle manifest written by the Python exporter. Validated strictly: a worker that
// trusts a malformed manifest fails far from the cause.

export interface DeciderManifest {
  format: 1
  modelId: string
  revision: string
  hidden: number
  layers: number
  pleDim: number
  vocab: number
  temperature: number
  softcap: number
  maxLength: number
  controlTokenIds: Record<string, number>
  codeTokenIds: number[]
  tables: {
    blockSize: number
    embed: { file: string; blocks: number }
    ple: { file: string; blocks: number }
  }
  chunkBytes: number
  files: { name: string; bytes: number; sha256: string[] }[]
}

const fail = (field: string, why: string): never => {
  throw new Error(`manifest: ${field} ${why}`)
}
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (o: Record<string, unknown>, k: string, path = k): string =>
  typeof o[k] === 'string' ? (o[k] as string) : fail(path, 'must be a string')
const num = (o: Record<string, unknown>, k: string, path = k): number =>
  typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : fail(path, 'must be a finite number')
const int = (o: Record<string, unknown>, k: string, path = k): number => {
  const n = num(o, k, path)
  return Number.isInteger(n) && n >= 0 ? n : fail(path, 'must be a non-negative integer')
}
/** A chunk size of 0 would loop forever slicing nothing off the import stream (final review M9). */
const positive = (o: Record<string, unknown>, k: string, path = k): number => {
  const n = int(o, k, path)
  return n > 0 ? n : fail(path, 'must be a positive integer')
}
const obj = (o: Record<string, unknown>, k: string, path = k): Record<string, unknown> => {
  const v = o[k]
  return isObj(v) ? v : fail(path, 'must be an object')
}
const table = (o: Record<string, unknown>, k: string) => {
  const t = obj(o, k, `tables.${k}`)
  return { file: str(t, 'file', `tables.${k}.file`), blocks: int(t, 'blocks', `tables.${k}.blocks`) }
}

export function parseManifest(raw: unknown): DeciderManifest {
  if (!isObj(raw)) return fail('root', 'must be an object')
  if (raw.format !== 1) fail('format', 'must be 1')
  const control = obj(raw, 'controlTokenIds')
  const controlTokenIds: Record<string, number> = {}
  for (const [k, v] of Object.entries(control)) {
    if (typeof v !== 'number' || !Number.isInteger(v)) fail(`controlTokenIds.${k}`, 'must be an integer')
    controlTokenIds[k] = v as number
  }
  const codes = raw.codeTokenIds
  if (!Array.isArray(codes) || !codes.every((x) => Number.isInteger(x))) {
    fail('codeTokenIds', 'must be an array of integers')
  }
  const tables = obj(raw, 'tables')
  const files = raw.files
  if (!Array.isArray(files)) fail('files', 'must be an array')
  return {
    format: 1,
    modelId: str(raw, 'modelId'),
    revision: str(raw, 'revision'),
    hidden: int(raw, 'hidden'),
    layers: int(raw, 'layers'),
    pleDim: int(raw, 'pleDim'),
    vocab: int(raw, 'vocab'),
    temperature: num(raw, 'temperature'),
    softcap: num(raw, 'softcap'),
    maxLength: int(raw, 'maxLength'),
    controlTokenIds,
    codeTokenIds: [...(codes as number[])],
    tables: {
      blockSize: int(tables, 'blockSize', 'tables.blockSize'),
      embed: table(tables, 'embed'),
      ple: table(tables, 'ple'),
    },
    chunkBytes: positive(raw, 'chunkBytes'),
    files: (files as unknown[]).map((f, i) => {
      if (!isObj(f)) return fail(`files[${i}]`, 'must be an object')
      const sha = f.sha256
      if (!Array.isArray(sha) || !sha.every((s) => typeof s === 'string')) {
        fail(`files[${i}].sha256`, 'must be an array of strings')
      }
      return { name: str(f, 'name', `files[${i}].name`), bytes: int(f, 'bytes', `files[${i}].bytes`), sha256: [...(sha as string[])] }
    }),
  }
}
