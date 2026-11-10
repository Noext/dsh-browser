#!/usr/bin/env node
/**
 * M0 spike — prove the screencast + input + auth loop before writing the plugin.
 *
 * What it does:
 *   1. launches a real Chromium with a random loopback CDP port and a throwaway profile
 *   2. serves one page that shows the screencast on a canvas and forwards input
 *   3. relays CDP Page.startScreencast <-> canvas, and canvas pointer/key events <-> CDP Input.*
 *   4. prints fps / frame size / input latency so we can judge feasibility
 *
 * Usage: node spike/host.mjs [url]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'

const PAGE_HTML = /* html */ `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>DSH browser spike</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; background:#141413; color:#e8e6e3; font:13px/1.4 system-ui,sans-serif;
         display:flex; flex-direction:column; height:100vh }
  header { display:flex; gap:8px; align-items:center; padding:8px 10px; border-bottom:1px solid #2a2a28 }
  input { flex:1; background:#1e1e1c; border:1px solid #333330; color:inherit; border-radius:6px; padding:5px 8px }
  button { background:#262624; border:1px solid #383835; color:inherit; border-radius:6px; padding:5px 10px; cursor:pointer }
  button:hover { background:#30302d }
  #stats { color:#8a8a84; font-variant-numeric:tabular-nums; white-space:nowrap }
  main { flex:1; overflow:hidden; display:flex; justify-content:center; align-items:center; background:#0f0f0e }
  canvas { max-width:100%; max-height:100%; outline:none; background:#000; cursor:default }
  canvas:focus { box-shadow:0 0 0 2px #4a7fd4 inset }
</style>
</head>
<body>
<header>
  <button id="back" title="Back">&#8592;</button>
  <button id="fwd" title="Forward">&#8594;</button>
  <button id="reload" title="Reload">&#8635;</button>
  <input id="url" placeholder="https://example.com" spellcheck="false">
  <button id="go">Go</button>
  <span id="stats">connecting…</span>
</header>
<main><canvas id="screen" tabindex="0" width="1280" height="800"></canvas></main>
<script>
const canvas = document.getElementById('screen')
const ctx2d = canvas.getContext('2d', { alpha: false })
const stats = document.getElementById('stats')
const urlInput = document.getElementById('url')
let ws, pending = new Map(), lastFrameAt = 0, frames = 0, fps = 0, windowStart = performance.now()
let lastAck = 0

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(proto + '//' + location.host + '/ws' + location.search)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data)
      if (msg.t === 'url') { urlInput.value = msg.url; document.title = msg.title || msg.url }
      else if (msg.t === 'stats') stats.textContent = msg.text
      else if (msg.t === 'size') { canvas.width = msg.width; canvas.height = msg.height }
      return
    }
    const view = new DataView(event.data)
    const frameId = view.getUint32(1)
    const blob = new Blob([new Uint8Array(event.data, 5)], { type: 'image/jpeg' })
    createImageBitmap(blob).then((bitmap) => {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      ctx2d.drawImage(bitmap, 0, 0)
      bitmap.close()
      frames++
      const now = performance.now()
      if (now - windowStart >= 1000) {
        fps = Math.round(frames * 1000 / (now - windowStart))
        windowStart = now; frames = 0
        stats.textContent = fps + ' fps · ' + canvas.width + '×' + canvas.height + ' · ack ' + lastAck + 'ms'
      }
      // ack every frame: this is the backpressure signal Chromium waits for
      ws.send(JSON.stringify({ t: 'ack', frameId }))
    })
  }
  ws.onclose = () => { stats.textContent = 'disconnected — retrying'; setTimeout(connect, 1000) }
  ws.onopen = () => { urlInput.value = '' }
}

// ---- coordinate mapping: canvas CSS pixels -> page device pixels ----
function map(event) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: Math.round((event.clientX - rect.left) * canvas.width / rect.width),
    y: Math.round((event.clientY - rect.top) * canvas.height / rect.height),
  }
}
function send(o) { if (ws?.readyState === 1) ws.send(JSON.stringify(o)) }

const buttonIndex = (e) => (e.button === 2 ? 2 : e.button === 1 ? 1 : 0)
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus(); canvas.setPointerCapture(e.pointerId)
  const p = map(e)
  send({ t: 'mouse', type: 'down', ...p, button: buttonIndex(e), clickCount: 1, modifiers: mods(e) })
})
canvas.addEventListener('pointerup', (e) => {
  const p = map(e)
  send({ t: 'mouse', type: 'up', ...p, button: buttonIndex(e), clickCount: 1, modifiers: mods(e) })
})
let lastMove = 0
canvas.addEventListener('pointermove', (e) => {
  const now = performance.now()
  if (now - lastMove < 16) return
  lastMove = now
  const p = map(e)
  send({ t: 'mouse', type: 'move', ...p, button: e.buttons === 2 ? 2 : e.buttons === 4 ? 1 : 0 })
})
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  const p = map(e)
  if (e.ctrlKey) send({ t: 'zoom', delta: -e.deltaY / 100 })
  else send({ t: 'wheel', ...p, dx: Math.round(-e.deltaX), dy: Math.round(-e.deltaY) })
}, { passive: false })
canvas.addEventListener('contextmenu', (e) => e.preventDefault())
canvas.addEventListener('input', () => {})
canvas.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text')
  if (text) { e.preventDefault(); send({ t: 'text', text }) }
})

function mods(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}
// Physical-code -> Windows virtual key code, the minimum Chromium needs to fire a real key event.
const VK = { Enter:13, Tab:9, Backspace:8, Escape:27, Delete:46, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40,
  Home:36, End:35, PageUp:33, PageDown:34, ' ': 32, Space:32 }
function vkOf(e) {
  if (VK[e.key] !== undefined) return VK[e.key]
  if (e.key.length === 1) { const c = e.key.toUpperCase().charCodeAt(0); return c }
  return e.keyCode ?? 0
}
canvas.addEventListener('keydown', (e) => {
  if (e.key === ' ' ) e.preventDefault()
  send({ t: 'key', type: 'down', key: e.key, code: e.code, vk: vkOf(e), text: e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : undefined, modifiers: mods(e) })
  if (['Enter','Tab','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault()
})
canvas.addEventListener('keyup', (e) => {
  send({ t: 'key', type: 'up', key: e.key, code: e.code, vk: vkOf(e), modifiers: mods(e) })
})

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { send({ t: 'navigate', url: urlInput.value }) ; canvas.focus() }
})
document.getElementById('go').onclick = () => { send({ t: 'navigate', url: urlInput.value }); canvas.focus() }
document.getElementById('back').onclick = () => send({ t: 'back' })
document.getElementById('fwd').onclick = () => send({ t: 'forward' })
document.getElementById('reload').onclick = () => send({ t: 'reload' })
canvas.addEventListener('focus', () => { stats.style.color = '#e8e6e3' })
window.addEventListener('resize', () => send({ t: 'resize' }))
connect()
</script>
</body>
</html>`

/** Launch Chromium and return its CDP HTTP endpoint. */
async function launch() {
  const executable = process.env.DSH_BROWSER_EXECUTABLE
    ?? '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
  if (!existsSync(executable)) throw new Error(`chromium not found: ${executable}`)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-browser-spike-'))
  const child = spawn(executable, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1440,900',
    '--headless=new',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const portFile = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('Chromium did not publish DevToolsActivePort')
    await new Promise((r) => setTimeout(r, 100))
  }
  const [port, browserPath] = readFileSync(portFile, 'utf8').trim().split('\n')
  return {
    child, profile, port: Number(port), browserPath,
    close() { child.kill('SIGTERM'); rmSync(profile, { recursive: true, force: true }) },
  }
}

/** Minimal CDP client bound to one page target. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    this.listeners = new Set()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
      } else {
        for (const l of this.listeners) l(msg)
      }
    })
  }
  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

function modifiersOf(bits = 0) {
  return (bits & 1 ? 1 : 0) | (bits & 2 ? 2 : 0) | (bits & 4 ? 4 : 0) | (bits & 8 ? 8 : 0)
}

async function main() {
  const targetUrl = process.argv[2] ?? 'https://example.com'
  const browser = await launch()
  console.log('[spike] chromium pid', browser.child.pid, 'cdp port', browser.port)

  const version = await (await fetch(`http://127.0.0.1:${browser.port}/json/version`)).json()
  console.log('[spike] browser', version.Browser)

  const wsBrowser = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((resolve, reject) => { wsBrowser.once('open', resolve); wsBrowser.once('error', reject) })
  const browserCdp = new Cdp(wsBrowser)

  const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId, flatten: true })

  // Session-scoped command channel: reuse the same socket with sessionId.
  const sessionSend = (method, params = {}) => {
    const id = browserCdp.next++
    return new Promise((resolve, reject) => {
      browserCdp.pending.set(id, { resolve, reject })
      wsBrowser.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  const sessionOn = (fn) => {
    const wrapped = (msg) => { if (msg.sessionId === sessionId) fn(msg) }
    return browserCdp.on(wrapped)
  }

  await sessionSend('Page.enable')
  await sessionSend('Runtime.enable')
  await sessionSend('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  })

  // ---- web server: the demo page + one authenticated-ish websocket ----
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
      return
    }
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  let viewer
  let frames = 0
  let frameBytes = 0
  let startedAt = Date.now()
  let lastAckAt = 0
  let inFlightFrame

  wss.on('connection', (ws) => {
    if (viewer !== undefined) { ws.close(4001, 'viewer taken'); return }
    viewer = ws
    console.log('[spike] viewer connected')
    ws.on('close', () => { viewer = undefined; startedAt = Date.now(); frames = 0; frameBytes = 0 })

    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw.toString())
      try {
        switch (msg.t) {
          case 'ack':
            lastAckAt = Date.now()
            if (inFlightFrame === msg.frameId) {
              inFlightFrame = undefined
              await sessionSend('Page.screencastFrameAck', { sessionId: screencastSessionId })
            }
            break
          case 'mouse':
            await sessionSend('Input.dispatchMouseEvent', {
              type: msg.type === 'down' ? 'mousePressed' : msg.type === 'up' ? 'mouseReleased' : 'mouseMoved',
              x: msg.x, y: msg.y, button: ['left', 'middle', 'right'][msg.button ?? 0] ?? 'left',
              buttons: msg.type === 'down' ? 1 : 0,
              clickCount: msg.type === 'move' ? 0 : (msg.clickCount ?? 1),
              modifiers: modifiersOf(msg.modifiers),
              ...(msg.type === 'down' ? { pointerType: 'mouse' } : {}),
            })
            break
          case 'wheel':
            await sessionSend('Input.dispatchMouseEvent', {
              type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.dx, deltaY: msg.dy,
            })
            break
          case 'key':
            await sessionSend('Input.dispatchKeyEvent', {
              type: msg.type === 'down' ? (msg.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
              key: msg.key, code: msg.code,
              windowsVirtualKeyCode: msg.vk, nativeVirtualKeyCode: msg.vk,
              text: msg.text, unmodifiedText: msg.text,
              modifiers: modifiersOf(msg.modifiers),
            })
            break
          case 'text':
            await sessionSend('Input.insertText', { text: msg.text })
            break
          case 'navigate': {
            const url = /^https?:\/\//.test(msg.url) ? msg.url : `https://${msg.url}`
            await sessionSend('Page.navigate', { url })
            break
          }
          case 'back':
            await sessionSend('Runtime.evaluate', { expression: 'history.back()' })
            break
          case 'forward':
            await sessionSend('Runtime.evaluate', { expression: 'history.forward()' })
            break
          case 'reload':
            await sessionSend('Page.reload', {})
            break
        }
      } catch (error) {
        console.error('[spike] command failed', msg.t, error.message)
      }
    })

    void sessionSend('Page.startScreencast', {
      format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1,
    }).catch((error) => console.error('[spike] startScreencast', error.message))
  })

  let screencastSessionId
  sessionOn((msg) => {
    if (msg.method === 'Page.screencastFrame') {
      const { data, sessionId: frameSession, metadata } = msg.params
      screencastSessionId = frameSession
      const jpeg = Buffer.from(data, 'base64')
      frames++
      frameBytes += jpeg.length
      if (viewer?.readyState === 1) {
        const header = Buffer.alloc(5)
        header.writeUInt8(1, 0)
        header.writeUInt32BE(screencastSessionId, 1)
        viewer.send(Buffer.concat([header, jpeg]), { binary: true })
        inFlightFrame = screencastSessionId
      } else {
        // nobody watching: still ack so Chromium keeps the pump warm but idle
        void sessionSend('Page.screencastFrameAck', { sessionId: frameSession })
      }
      if (Date.now() - startedAt > 1000 && frames % 30 === 0) {
        const seconds = (Date.now() - startedAt) / 1000
        console.log(`[spike] ${(frames / seconds).toFixed(1)} fps, ${(frameBytes / frames / 1024).toFixed(0)} KiB/frame`)
      }
    }
    if (msg.method === 'Page.frameNavigated' && msg.params.frame.parentId === undefined) {
      const url = msg.params.frame.url
      viewer?.send(JSON.stringify({ t: 'url', url, title: msg.params.frame.name ?? '' }))
    }
    if (msg.method === 'Page.loadEventFired') {
      void sessionSend('Runtime.evaluate', { expression: 'document.title' }).then((r) => {
        viewer?.send(JSON.stringify({ t: 'url', url: 'about:blank', title: r.result?.value ?? '' }))
      })
    }
  })

  const wantedPort = Number(process.env.SPIKE_PORT ?? 0)
  const port = await new Promise((resolve) => server.listen(wantedPort, '127.0.0.1', () => resolve(server.address().port)))
  console.log(`[spike] SPIKE_URL=http://127.0.0.1:${port}/`)
  console.log(`[spike] open http://127.0.0.1:${port}/ in the right-sidebar-shaped window`)
  console.log('[spike] the screencast mirrors the real browser; input goes back through CDP')

  await sessionSend('Page.navigate', { url: targetUrl }).catch(() => {})

  const shutdown = async () => {
    console.log('[spike] shutting down')
    try { await browserCdp.send('Browser.close') } catch {}
    browser.close()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => { console.error('[spike] failed:', error); process.exit(1) })
