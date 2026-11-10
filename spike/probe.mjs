#!/usr/bin/env node
/**
 * M0 probe — pretends to be the sidebar view: connects to the spike websocket,
 * acknowledges frames, injects input, and reports the numbers we care about.
 * Also talks CDP directly to the target to prove the input actually landed.
 *
 * Usage: node spike/probe.mjs <ws-url> <cdp-port>
 */
import { WebSocket } from 'ws'

const [wsUrl, cdpPort] = process.argv.slice(2)
if (!wsUrl || !cdpPort) throw new Error('usage: probe.mjs <ws-url> <cdp-port>')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Talk to the page target so we can verify what the injected input did. */
async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let next = 1
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed')
        return r.result.value
      } catch (error) {
        // A navigation swaps the execution context; retry briefly instead of failing.
        if (attempt === 19) throw error
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
  }
  return { send, evaluate, close: () => ws.close() }
}

function connect(url) {
  const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 })
  ws.binaryType = 'nodebuffer'
  const stats = { frames: 0, bytes: 0, acked: 0, lastFrameAt: 0, sizes: [], t0: 0 }
  const seen = []
  ws.on('message', (data) => {
    if (typeof data === 'string' || !Buffer.isBuffer(data)) {
      const msg = JSON.parse(data.toString())
      if (msg.t === 'url') seen.push(msg)
      return
    }
    const frameId = data.readUInt32BE(1)
    const jpeg = data.subarray(5)
    stats.frames++
    stats.bytes += jpeg.length
    stats.sizes.push(jpeg.length)
    stats.lastFrameAt = performance.now()
    ws.send(JSON.stringify({ t: 'ack', frameId }))
    stats.acked++
  })
  return { ws, stats, seen }
}

const main = async () => {
  const page = await pageTarget()
  await page.send('Runtime.enable')
  console.log('[probe] target url before:', await page.evaluate('location.href'))

  const { ws, stats, seen } = connect(wsUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })

  // --- idle measurement: example.com is static, so this is the floor ---
  await sleep(1500)
  const before = { ...stats }
  await sleep(3000)
  const idleFrames = stats.frames - before.frames
  const idleBytes = stats.bytes - before.bytes
  console.log(`[probe] idle: ${(idleFrames / 3).toFixed(1)} fps, ${idleFrames ? (idleBytes / idleFrames / 1024).toFixed(0) : 0} KiB/frame average`)

  // --- input fidelity: click the "More information..." link on example.com ---
  const box = await page.evaluate(`(() => {
    const a = document.querySelector('a')
    if (!a) return null
    const r = a.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: a.textContent }
  })()`)
  console.log('[probe] link to click:', JSON.stringify(box))
  if (box) {
    const t0 = performance.now()
    ws.send(JSON.stringify({ t: 'mouse', type: 'move', x: box.x, y: box.y, button: 0 }))
    ws.send(JSON.stringify({ t: 'mouse', type: 'down', x: box.x, y: box.y, button: 0, clickCount: 1 }))
    ws.send(JSON.stringify({ t: 'mouse', type: 'up', x: box.x, y: box.y, button: 0, clickCount: 1 }))
    for (let i = 0; i < 50; i++) {
      await sleep(100)
      const href = await page.evaluate('location.href')
      if (href !== 'https://example.com/') { console.log(`[probe] click navigated to ${href} in ${(performance.now() - t0).toFixed(0)} ms`); break }
    }
    console.log('[probe] url after click:', await page.evaluate('location.href'))
  }

  // --- keyboard: focus a text field and type through CDP-style key events ---
  await page.evaluate(`(() => {
    const input = document.createElement('input')
    input.id = 'probe-input'
    input.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;width:220px'
    document.body.appendChild(input)
    input.focus()
  })()`)
  for (const ch of 'hello world') {
    ws.send(JSON.stringify({ t: 'key', type: 'down', key: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, vk: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0), text: ch }))
    ws.send(JSON.stringify({ t: 'key', type: 'up', key: ch, code: ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`, vk: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0) }))
    await sleep(25)
  }
  await sleep(300)
  console.log('[probe] typed into page:', JSON.stringify(await page.evaluate("document.getElementById('probe-input').value")))
  ws.send(JSON.stringify({ t: 'text', text: ' [insertText]' }))
  await sleep(300)
  console.log('[probe] after insertText:', JSON.stringify(await page.evaluate("document.getElementById('probe-input').value")))

  // --- scroll measurement: continuous repaint, the worst case ---
  const scrollBefore = stats.frames
  const scrollBytes = stats.bytes
  for (let i = 0; i < 90; i++) {
    ws.send(JSON.stringify({ t: 'wheel', x: 400, y: 400, dx: 0, dy: 120 }))
    await sleep(16)
  }
  await sleep(600)
  const scrollFrames = stats.frames - scrollBefore
  console.log(`[probe] during ~1.5 s of scrolling: ${(scrollFrames / 1.5).toFixed(1)} fps, ${((stats.bytes - scrollBytes) / Math.max(scrollFrames, 1) / 1024).toFixed(0)} KiB/frame`)

  const latencies = []
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    ws.send(JSON.stringify({ t: 'wheel', x: 400, y: 400, dx: 0, dy: 40 }))
    const target = stats.frames + 1
    for (let k = 0; k < 100; k++) { if (stats.frames >= target) break; await sleep(5) }
    latencies.push(performance.now() - t0)
    await sleep(120)
  }
  latencies.sort((a, b) => a - b)
  console.log(`[probe] input→frame latency: median ${latencies[2].toFixed(0)} ms, max ${latencies.at(-1).toFixed(0)} ms`)

  console.log(`[probe] totals: ${stats.frames} frames, ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB, acked ${stats.acked}`)
  console.log('[probe] url messages seen:', seen.length)
  ws.close()
  page.close()
  process.exit(0)
}

main().catch((error) => { console.error('[probe] failed:', error); process.exit(1) })
