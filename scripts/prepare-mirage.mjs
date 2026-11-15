// Downloads happen at build time only. Runtime executable code is extension-local.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
const engine = 'https://huggingface.co/Cactus-Compute/cactus/resolve/d2c5cd70432ed78345f3ba6b620bff2feeec6c86/releases/4.1.1/'
const model = 'https://huggingface.co/Cactus-Compute/mirage/resolve/3d03cee88c0acbe4e71b94b567ab14e6e55f40c9/'
// This revision explicitly declares Apache-2.0 and has the same weight SHA as
// the earlier evaluation pin. The legacy acknowledgment flag is harmless/optional.
const files = [
  ['MODEL_CARD.md', model + 'README.md', '9c69381d336583e6b4069663f4028aeee9c0512d5abc6781c63d96ff54554d4f'],
  ['LICENSE.model', engine + 'LICENSE', 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
  ['cactus.js', engine + 'wasm/cactus.js', '707341e44776ab0eb8dfc8f6a579ed5ac41e2ffc6419a18012f61619a6dfc70c'],
  ['cactus.wasm', engine + 'wasm/cactus.wasm', '2de0a4459ed427c258157fcb6128265f72f405e7464b25d713bbd336b15bcacf'],
  ['mirage.cact', model + 'mirage.cact', '4249a0f7515272ff76b9414bec17d7e7daf84b15b66c7fb4f17fce1e66f9f237'],
  ['LICENSE.runtime', engine + 'LICENSE', 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
]
await mkdir(new URL('../public/mirage/', import.meta.url), {recursive:true})
for (const [name, url, expected] of files) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`${name}: checksum mismatch`)
  await writeFile(new URL('../public/mirage/' + name, import.meta.url), bytes)
  // Deterministic ESM wrapper around the verified classic Emscripten factory.
  if (name === 'cactus.js') await writeFile(new URL('../public/mirage/cactus.mjs', import.meta.url), bytes.toString() + '\nexport default createCactus;\n')
  console.log(`${name}: verified ${bytes.length} bytes`)
}
