#!/usr/bin/env node
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const [extensionId, browser = 'chrome'] = process.argv.slice(2)
if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('Usage: node install.mjs EXTENSION_ID [chrome|chromium|edge|brave]')
const locations = {
  darwin: { chrome: 'Library/Application Support/Google/Chrome/NativeMessagingHosts', chromium: 'Library/Application Support/Chromium/NativeMessagingHosts', edge: 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', brave: 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts' },
  linux: { chrome: '.config/google-chrome/NativeMessagingHosts', chromium: '.config/chromium/NativeMessagingHosts', edge: '.config/microsoft-edge/NativeMessagingHosts', brave: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts' },
}
const location = locations[process.platform]?.[browser]
if (!location) throw new Error('Supported: Chrome, Chromium, Edge or Brave on macOS/Linux.')
const root = dirname(fileURLToPath(import.meta.url))
await readFile(join(root, 'node_modules/jose/package.json')) // fail before registering if npm ci was skipped
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const launcher = join(root, 'launch.local')
await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, 'host.mjs'))}\n`, { mode: 0o700 })
await chmod(launcher, 0o700)
const target = join(homedir(), location)
await mkdir(target, { recursive: true })
await writeFile(join(target, 'app.lychee.chatgpt.json'), JSON.stringify({ name: 'app.lychee.chatgpt', description: 'Lychee AI ChatGPT sign-in and inference companion', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2), { mode: 0o600 })
console.log('Installed for this extension ID. Reload Lychee AI, then choose ChatGPT plan in Settings → Providers.')
