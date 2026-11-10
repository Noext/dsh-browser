#!/usr/bin/env node
/** M0 scroll/latency probe — the realistic case: scroll a content-heavy page. */
import { WebSocket } from 'ws'
const [wsUrl, cdpPort] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const cmd = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1 << 28 })
await new Promise((r) => cmd.once('open', r))
let next = 1
const pending = new Map()
cmd.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); cmd.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result.value
}

await send('Page.navigate', { url: 'https://en.wikipedia.org/wiki/Chromium_(web_browser)' })
await sleep(3500)

const ws = new WebSocket(wsUrl, { maxPayload: 1 << 28 })
await new Promise((r) => ws.once('open', r))
let frames = 0
let bytes = 0
const arrivals = []
ws.on('message', (data) => {
  if (typeof data === 'string' || !Buffer.isBuffer(data)) return
  frames++; bytes += data.length - 5; arrivals.push(performance.now())
  ws.send(JSON.stringify({ t: 'ack', frameId: data.readUInt32BE(1) }))
})

await sleep(800)
console.log('[scroll] content height', await evaluate('document.body.scrollHeight'))

// --- scroll: 2 seconds of wheel events at 60 Hz ---
const f0 = frames, b0 = bytes
const t0 = performance.now()
for (let i = 0; i < 120; i++) { ws.send(JSON.stringify({ t: 'wheel', x: 640, y: 400, dx: 0, dy: 100 })); await sleep(16) }
const scrollMs = performance.now() - t0
await sleep(400)
console.log(`[scroll] ${frames - f0} frames in ${(scrollMs/1000).toFixed(1)}s = ${((frames-f0)/(scrollMs/1000)).toFixed(1)} fps, ${((bytes-b0)/Math.max(frames-f0,1)/1024).toFixed(0)} KiB/frame`)
console.log('[scroll] scrolled to y =', await evaluate('Math.round(scrollY)'))

// --- keystroke → visible frame latency ---
await evaluate("(() => { const i=document.createElement('input'); i.id='probe'; i.style.cssText='position:fixed;top:0;left:0;z-index:99999;width:300px;font-size:20px'; document.body.appendChild(i); i.focus(); return 1 })()")
await sleep(300)
const lat = []
for (const ch of 'latency-probe') {
  const before = frames
  const sentAt = performance.now()
  ws.send(JSON.stringify({ t: 'key', type: 'down', key: ch, code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: ch }))
  ws.send(JSON.stringify({ t: 'key', type: 'up', key: ch, code: 'Key' + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0) }))
  for (let k = 0; k < 200; k++) { if (frames > before) break; await sleep(2) }
  lat.push(performance.now() - sentAt)
  await sleep(120)
}
lat.sort((a, b) => a - b)
console.log(`[latency] keystroke→frame: p50 ${lat[Math.floor(lat.length/2)].toFixed(0)} ms, p90 ${lat[Math.floor(lat.length*0.9)].toFixed(0)} ms, max ${lat.at(-1).toFixed(0)} ms`)
console.log('[latency] typed value:', JSON.stringify(await evaluate("document.getElementById('probe').value")))
console.log(`[total] ${frames} frames, ${(bytes/1048576).toFixed(1)} MiB, ${(bytes/frames/1024).toFixed(0)} KiB/frame`)
ws.close(); cmd.close()
process.exit(0)
