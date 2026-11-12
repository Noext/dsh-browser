/**
 * Clicking a file input must guide the caller, never open a native dialog.
 *
 * A file input click opens an OS file chooser on the Host display where nobody
 * can reach it, and it can block the window. The page reports the request
 * instead, and the click fails with a message naming browser_upload.
 * @module tests/file-chooser
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const html = '<!doctype html><meta charset="utf-8"><title>f</title><input type="file" id="p" aria-label="Photo">'
const server = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(html) })
const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))

const profile = mkdtempSync(join(tmpdir(), 'chooser-'))
const file = join(profile, 'a.png')
writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'))
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
console.log(snap.text)
const ref = /\[ref=(e\d+)\]/u.exec(snap.text)?.[1]
assert.ok(ref, 'the input should have a ref')

// A click must not open a chooser: it must tell the caller what to use instead.
let message = ''
try { await view.clickRef(ref!) } catch (error) { message = String(error) }
console.log('click said:', message)
assert.match(message, /browser_upload/u, 'the refusal should name browser_upload')

// And the real path works.
const attached = await view.setFiles(ref!, [file])
assert.deepEqual(attached.names, ['a.png'])

await session.dispose('test')
cleanup()
console.log('a file input click is explained, and upload works')
process.exit(0)
