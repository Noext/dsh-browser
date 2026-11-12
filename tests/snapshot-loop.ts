/**
 * The snapshot-and-ref loop, on a real page.
 *
 * This is the loop the agent should use: read the tree, act on a ref, read
 * again. A test that only clicks coordinates would pass while the agent guessed
 * wrong every other step.
 * @module tests/snapshot-loop
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const page = `<!doctype html><meta charset="utf-8"><title>Snapshot fixture</title>
<h1>A page an agent can read</h1>
<label for="n">Your name</label><input id="n" aria-label="Your name">
<button id="go" onclick="document.getElementById('out').textContent = 'clicked'">Submit</button>
<output id="out">idle</output>
<p>Some prose the agent does not need to click.</p>`

const server = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(page) })
const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))

const profile = mkdtempSync(join(tmpdir(), 'snaploop-'))
const cleanup = (): void => { rmSync(profile, { recursive: true, force: true }); server.close() }
process.on('exit', cleanup)

const session = new BrowserSession({
  log: silentLog, executablePath: discoverExecutable()!, profileRoot: profile,
  profileKind: 'ephemeral', headed: false, viewport: { width: 1024, height: 768 }, quality: 50,
  startTimeoutMs: 25_000, humanIdleMs: 60_000, idleTimeoutMs: 0,
  initialUrl: `http://127.0.0.1:${port}/`,
  sink: { onFrame() {}, onViews() {}, onLease() {}, onError() {} },
})
await session.attachViewer()
const view = session.activeView!

const snap = await view.snapshot()
console.log('--- tree ---')
console.log(snap.text)
console.log('--- end ---')

assert.match(snap.text, /button "Submit"/u, 'the button should be a named ref')
assert.match(snap.text, /\[ref=e\d+\]/u, 'refs should be rendered')
assert.ok(snap.refs.size >= 3, `expected at least three refs, got ${snap.refs.size}`)

// Find the button ref by name and click it.
const buttonLine = snap.text.split('\n').find((line) => line.includes('button "Submit"'))
assert.ok(buttonLine, 'the button line should exist')
const buttonRef = /\[ref=(e\d+)\]/u.exec(buttonLine!)?.[1]
assert.ok(buttonRef, 'the button should carry a ref')

const clicked = await view.clickRef(buttonRef!)
console.log('clicked:', clicked.detail)

const after = await view.snapshot()
assert.match(after.text, /clicked/u, 'the page should show the click landed')

// A stale ref must be refused, not silently applied to whatever is there now.
await view.navigate(`http://127.0.0.1:${port}/?again`)
await new Promise((r) => setTimeout(r, 500))
let refused = false
try { await view.clickRef(buttonRef!) } catch (error) {
  refused = /unknown ref|cannot click/u.test(String(error))
}
console.log('stale ref refused:', refused)

await session.dispose('test')
cleanup()
assert.equal(refused, true, 'a ref from a previous page must be refused')
console.log('the snapshot and ref loop works')
process.exit(0)