#!/usr/bin/env node
/**
 * M0 micro-benchmark — raw CDP screencast throughput, no relay, no page.
 * Isolates "how fast can Chromium produce frames" from "how fast can we forward them".
 *
 * Usage: node spike/bench-screencast.mjs [headed|headless]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const mode = process.argv[2] ?? 'headless'
const executable = process.env.DSH_BROWSER_EXECUTABLE ?? '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
const profile = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
const args = [
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage',
  '--window-size=1440,900',
  ...(mode === 'headless' ? ['--headless=new'] : []),
  'about:blank',
]
const child = spawn(executable, args, { stdio: 'ignore' })
const portFile = join(profile, 'DevToolsActivePort')
const deadline = Date.now() + 20000
while (!existsSync(portFile)) {
  if (Date.now() > deadline) throw new Error('no DevToolsActivePort')
  await new Promise((r) => setTimeout(r, 100))
}
const [port] = readFileSync(portFile, 'utf8').trim().split('\n')
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })

let next = 1
const pending = new Map()
let onEvent = () => {}
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
  } else onEvent(msg)
})
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = next++
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId)

// A page that animates continuously: the upper bound on how many frames we could ever get.
await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(`<!doctype html>
<style>html{background:#111}div{position:absolute;top:40%;left:0;width:120px;height:120px;background:#4a7fd4;border-radius:16px}</style>
<div id=b></div><script>
let x=0;function tick(){x=(x+7)%1100;b.style.transform='translateX('+x+'px)';requestAnimationFrame(tick)}tick()
</script>`) }, sessionId)
await new Promise((r) => setTimeout(r, 1200))

let frames = 0
let bytes = 0
const times = []
onEvent = (msg) => {
  if (msg.method !== 'Page.screencastFrame' || msg.sessionId !== sessionId) return
  const jpeg = Buffer.from(msg.params.data, 'base64')
  frames++
  bytes += jpeg.length
  times.push(performance.now())
  // Ack immediately: measure Chromium's own ceiling, not our pipeline's.
  void send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, sessionId)
}

for (const quality of [40, 60, 80]) {
  frames = 0; bytes = 0; times.length = 0
  await send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }, sessionId)
  await new Promise((r) => setTimeout(r, 3000))
  await send('Page.stopScreencast', {}, sessionId)
  const span = times.length > 1 ? (times.at(-1) - times[0]) / 1000 : 0
  console.log(`[${mode}] quality ${quality}: ${frames} frames in ${span.toFixed(2)}s = ${(frames / Math.max(span, 0.001)).toFixed(1)} fps, ${(bytes / Math.max(frames, 1) / 1024).toFixed(0)} KiB/frame`)
}

await send('Browser.close').catch(() => {})
child.kill('SIGTERM')
rmSync(profile, { recursive: true, force: true })
process.exit(0)
