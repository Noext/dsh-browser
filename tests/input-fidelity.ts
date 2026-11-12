/**
 * Wheel direction and punctuation typing, measured on a real page.
 *
 * Both were reported from the panel: the scroll went the wrong way, and a period
 * could not be typed. They share a cause worth guarding — a value from the
 * browser being reinterpreted instead of passed through.
 * @module tests/input-fidelity
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const html = `<!doctype html><meta charset="utf-8"><title>Input</title>
<input id="i" aria-label="Field">
<div style="height:6000px">tall page</div>`
const server = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(html) })
const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))

const profile = mkdtempSync(join(tmpdir(), 'inputfid-'))
const cleanup = (): void => { rmSync(profile, { recursive: true, force: true }); server.close() }
process.on('exit', cleanup)

const session = new BrowserSession({
  log: silentLog, executablePath: discoverExecutable()!, profileRoot: profile,
  profileKind: 'ephemeral', headed: false, viewport: { width: 900, height: 700 }, quality: 50,
  startTimeoutMs: 25_000, humanIdleMs: 60_000, idleTimeoutMs: 0,
  initialUrl: `http://127.0.0.1:${port}/`,
  sink: { onFrame() {}, onViews() {}, onLease() {}, onError() {} },
})
await session.attachViewer()
const view = session.activeView!
await view.waitFor({ timeoutMs: 5000 })

const scrollY = async (): Promise<number> => {
  const snap = await view.snapshot({ interactiveOnly: false })
  void snap
  const state = await view.evaluateForTest('window.scrollY')
  return Number(state)
}

// 1. A positive deltaY must scroll down, the way the browser reports it.
await view.wheel({ x: 400, y: 300, dx: 0, dy: 120 })
await new Promise((r) => setTimeout(r, 500))
const down = await scrollY()
console.log('after dy=+120 scrollY:', down)
assert.ok(down > 0, 'a positive delta must scroll down')

await view.wheel({ x: 400, y: 300, dx: 0, dy: -120 })
await new Promise((r) => setTimeout(r, 500))
const up = await scrollY()
console.log('after dy=-120 scrollY:', up)
assert.ok(up < down, 'a negative delta must scroll back up')

// 2. Punctuation must reach a field, including the period whose char code is
// VK_DELETE.
const snap = await view.snapshot()
const fieldRef = /\[ref=(e\d+)\]/u.exec(snap.text)?.[1]
assert.ok(fieldRef, 'the field should have a ref')
await view.focusRef(fieldRef!)

const cases: [string, string, number][] = [
  ['a', 'KeyA', 65],
  ['1', 'Digit1', 49],
  ['.', 'Period', 190],
  [',', 'Comma', 188],
  ['-', 'Minus', 189],
  ['/', 'Slash', 191],
]
for (const [key, code, vk] of cases) {
  await view.key({ type: 'down', key, code, vk, text: key, modifiers: 0 })
  await view.key({ type: 'up', key, code, vk, modifiers: 0 })
}
await new Promise((r) => setTimeout(r, 300))
const typed = await view.evaluateForTest("document.getElementById('i').value")
console.log('typed:', JSON.stringify(typed))
assert.equal(typed, 'a1.,-/', 'every character must land, including the period')

await session.dispose('test')
cleanup()
console.log('wheel direction and punctuation typing are correct')
process.exit(0)
