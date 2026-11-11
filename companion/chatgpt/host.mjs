#!/usr/bin/env node
// Native messaging only: no HTTP proxy port, arbitrary URLs, headers, file paths,
// shell commands, or credentials are accepted from the extension.
import { spawn } from 'node:child_process'
import { status, signIn, signOut, accessToken, profilePath } from './auth.mjs'
import { request, visibleModels, CompletionReader } from './inference.mjs'

const controller = new AbortController()
const signal = controller.signal
let input = Buffer.alloc(0), started = false
function send(message) {
  const data = Buffer.from(JSON.stringify(message))
  if (data.length > 1024 * 1024) throw new Error('Native response exceeds the message size limit.')
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length)
  process.stdout.write(Buffer.concat([size, data]))
}
// Yield to stdout backpressure while streaming; avoid accumulating an entire answer.
async function sendChunk(text) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 32_768)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    send({ type: 'chunk', text: text.slice(offset, end) })
    offset = end
    if (process.stdout.writableNeedDrain) await new Promise(resolve => process.stdout.once('drain', resolve))
  }
}
async function openBrowser(url) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('The ChatGPT companion currently supports macOS and Linux.')
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' })
    child.once('error', () => reject(new Error('Could not open your browser.')))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not open your browser.')))
  })
}
async function handle(message) {
  profilePath(message.profileId)
  switch (message.method) {
    case 'status': return status(message.profileId)
    case 'signIn': return signIn(message.profileId, signal, openBrowser)
    case 'signOut': return signOut(message.profileId, signal)
    case 'models': {
      const token = await accessToken(message.profileId, signal)
      return visibleModels(await (await request('/models', token, AbortSignal.any([signal, AbortSignal.timeout(30_000)]))).json())
    }
    case 'responses': {
      const token = await accessToken(message.profileId, signal)
      const response = await request('/responses', token, AbortSignal.any([signal, AbortSignal.timeout(600_000)]), message.body)
      const reader = new CompletionReader()
      const decoder = new TextDecoder()
      const streaming = message.body.stream === true
      if (streaming) send({ type: 'headers' })
      for await (const chunk of response.body) {
        const text = decoder.decode(chunk, { stream: true })
        reader.push(text)
        if (streaming) await sendChunk(text)
      }
      const tail = decoder.decode()
      reader.push(tail)
      if (streaming && tail) await sendChunk(tail)
      const completed = reader.finish()
      if (!streaming) {
        send({ type: 'headers', json: true })
        await sendChunk(JSON.stringify(completed))
      }
      send({ type: 'end' })
      return undefined
    }
    default: throw new Error('Unsupported companion operation.')
  }
}
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk])
  if (input.length < 4) return
  const length = input.readUInt32LE(0)
  if (length > 60 * 1024 * 1024 || started) { controller.abort(); process.exit(1) }
  if (input.length < length + 4) return
  started = true
  let message
  try { message = JSON.parse(input.subarray(4, length + 4).toString('utf8')) }
  catch { send({ type: 'error', message: 'Invalid native request.' }); return }
  input = Buffer.alloc(0)
  handle(message).then(value => { if (value !== undefined) send({ type: 'result', value }) }).catch(error => {
    // Only application messages, never upstream bodies, tokens, or authorization URLs.
    const message = error instanceof Error ? error.message : 'ChatGPT operation failed.'
    send({ type: 'error', message: /https:\/\/auth\.|eyJ|access_token|refresh_token/.test(message) ? 'ChatGPT authorization failed. Please sign in again.' : message })
  })
})
process.stdin.on('end', () => { controller.abort(); process.exit(0) })
process.stdout.on('error', () => { controller.abort(); process.exit(0) })
