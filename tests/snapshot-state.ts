/**
 * A snapshot must report the state a form, not only its structure.
 *
 * An agent that cannot see which radio is checked takes a screenshot to find
 * out, which costs a turn and an image. The accessibility tree already records
 * checked, disabled, expanded and an input's value.
 * @module tests/snapshot-state
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const html = `<!doctype html><meta charset="utf-8"><title>State fixture</title>
<fieldset>
  <legend>Choose</legend>
  <label><input type="radio" name="r" checked> Option A</label>
  <label><input type="radio" name="r"> Option B</label>
  <label><input type="checkbox" checked> Agree</label>
  <label><input type="checkbox" disabled> Unavailable</label>
</fieldset>
<input type="text" value="hello" aria-label="Name" readonly>
<button aria-expanded="true">Expanded menu</button>
<button aria-expanded="false">Collapsed menu</button>`

const server = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(html) })
const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))

const profile = mkdtempSync(join(tmpdir(), 'snapstate-'))
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

const expectations: [RegExp, string][] = [
  [/radio "Option A"[^\n]*\(checked\)/u, 'the selected radio must say so'],
  [/radio "Option B"[^\n]*(?!checked)/u, 'the other radio must not claim to be checked'],
  [/checkbox "Agree"[^\n]*\(checked\)/u, 'a checked box must say so'],
  [/checkbox "Unavailable"[^\n]*\(disabled\)/u, 'a disabled control must say so'],
  [/textbox "Name"[^\n]*value="hello"/u, 'an input value must be visible'],
  [/button "Expanded menu"[^\n]*\(expanded\)/u, 'an expanded control must say so'],
  [/button "Collapsed menu"[^\n]*\(collapsed\)/u, 'a collapsed control must say so'],
]
const failures: string[] = []
for (const [pattern, label] of expectations) {
  if (!pattern.test(snap.text)) failures.push(label)
}

await session.dispose('test')
cleanup()
if (failures.length > 0) {
  console.error('MISSING:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log('every state is reported in the tree')
process.exit(0)