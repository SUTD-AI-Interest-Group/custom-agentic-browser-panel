import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function rpc(message) {
  const directory = await mkdtemp(join(tmpdir(), 'lychee-native-test-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./host.mjs', import.meta.url))], { env: { ...process.env, LYCHEE_CHATGPT_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native host did not reply')), 5000)
      let data = Buffer.alloc(0)
      child.on('error', reject)
      child.stdout.on('data', chunk => {
        data = Buffer.concat([data, chunk])
        if (data.length < 4 || data.length < data.readUInt32LE(0) + 4) return
        clearTimeout(timeout)
        resolve(JSON.parse(data.subarray(4, 4 + data.readUInt32LE(0)).toString('utf8')))
      })
      const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4)
      header.writeUInt32LE(body.length)
      // Fragmented framing, as Chrome may deliver it.
      child.stdin.write(header.subarray(0, 2))
      child.stdin.write(Buffer.concat([header.subarray(2), body]))
    })
  } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await rm(directory, { recursive: true, force: true }) }
}
test('real native process decodes fragmented length-prefixed messages and returns metadata only', async () => {
  assert.deepEqual(await rpc({ method: 'status', profileId: 'test-profile' }), { type: 'result', value: { connected: false, sharing: false, email: '' } })
})
test('native boundary rejects arbitrary operations and path traversal', async () => {
  assert.equal((await rpc({ method: 'exec', profileId: 'test-profile' })).type, 'error')
  assert.equal((await rpc({ method: 'status', profileId: '../../other' })).type, 'error')
  assert.match((await rpc({ method: 'models', profileId: 'test-profile' })).message, /Sign in with ChatGPT/)
})
