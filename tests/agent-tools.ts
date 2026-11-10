/**
 * Verify the Agent's tools against the real Host: open, read, click, screenshot,
 * then exercise the human handover and the guard that blocks the Agent during it.
 *
 * Usage: node --experimental-strip-types tests/agent-tools.ts
 */
import { connect } from 'node:net'
import { launchBrowser, discoverExecutable } from '../src/host/launcher.ts'
import { connectCdp } from '../src/host/cdp.ts'
import { BrowserView } from '../src/host/view.ts'
import { ControlMachine } from '../src/shared/control.ts'
import { consoleLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

void connect

const page = `<!doctype html><meta charset="utf-8"><title>Tool fixture</title>
<h1 id="heading">A page the agent can drive</h1>
<button id="counter" onclick="document.getElementById('out').textContent = String(Number(document.getElementById('out').textContent) + 1)">Increment</button>
<output id="out">0</output>
<input id="name" aria-label="Your name">
`

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
})
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => { resolve((server.address() as { port: number }).port) })
})

const profile = mkdtempSync(join(tmpdir(), 'dsh-browser-tools-'))
const browser = await launchBrowser({
  executablePath: discoverExecutable()!,
  profileDir: join(profile, 'chromium'),
  headed: false,
  viewport: { width: 1024, height: 768 },
  startTimeoutMs: 20_000,
})
const { connection } = await connectCdp(browser.webSocketDebuggerUrl)
const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })

const control = new ControlMachine({ humanIdleMs: 5000 })
await control.claimAgent(0)
const view = new BrowserView({
  connection,
  targetId,
  sessionId,
  log: consoleLog,
  quality: 60,
  viewport: { width: 1024, height: 768 },
  sink: { onFrame() {}, onNavigation() {}, onCursor() {}, onClosed() {}, onError() {} },
})
await view.start(`http://127.0.0.1:${port}/`)

// --- read ---
const page1 = await view.readText(20_000)
assert.match(page1.text, /A page the agent can drive/)
assert.equal(page1.title, 'Tool fixture')
console.log('read ok:', page1.title)

// --- click a selector ---
await view.clickSelector('#counter')
await view.clickSelector('#counter')
const afterClicks = await view.readText(2000)
assert.match(afterClicks.text, /Increment\s*2/u, `counter did not increment: ${afterClicks.text}`)
console.log('click ok: counter is', afterClicks.text.match(/Increment\s*(\d+)/u)?.[1])

// --- type into a field ---
await view.clickSelector('#name')
await view.insertText('Ada Lovelace')
const typed = await connection.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
  expression: "document.getElementById('name').value",
  returnByValue: true,
}, sessionId)
assert.equal(typed.result.value, 'Ada Lovelace')
console.log('type ok:', typed.result.value)

// --- key events reach the page ---
await connection.send('Runtime.evaluate', {
  expression: "window.__keys = []; addEventListener('keydown', (e) => window.__keys.push(e.key))",
}, sessionId)
await view.key({ type: 'down', key: 'Enter', code: 'Enter', vk: 13, text: '\r', modifiers: 0 })
await view.key({ type: 'up', key: 'Enter', code: 'Enter', vk: 13, modifiers: 0 })
await new Promise((resolve) => setTimeout(resolve, 200))
const keys = await connection.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
  expression: 'window.__keys', returnByValue: true,
}, sessionId)
assert.deepEqual(keys.result.value, ['Enter'])
console.log('key ok:', JSON.stringify(keys.result.value))

// --- screenshot ---
const png = await view.screenshot()
assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
console.log('screenshot ok:', png.length, 'bytes')

// --- the handover blocks the agent ---
const takeover = control.claimHuman(Date.now())
assert.equal(takeover.after.state, 'human')
assert.equal(control.allowsAgent(Date.now()), false)
assert.equal(control.allowsHuman(Date.now()), true)
console.log('handover ok: agent blocked while the human drives')

control.release(Date.now())
assert.equal(control.allowsAgent(Date.now()), true)
console.log('handback ok: agent resumed')

await view.close()
connection.close()
await browser.close()
server.close()
rmSync(profile, { recursive: true, force: true })
console.log('all agent-tool checks passed')
process.exit(0)
