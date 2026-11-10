/**
 * The leak regression: a browser whose viewer disappears must close itself.
 *
 * This is the test that would have caught the pile-up of Chromium windows on a
 * developer's desktop, so it exercises the real launcher and the real watchdog
 * rather than a mock.
 * @module tests/idle-reclaim
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const IDLE_MS = 1500
const profile = mkdtempSync(join(tmpdir(), 'dsh-browser-idle-'))
const pidFile = join(profile, 'pid')

const session = new BrowserSession({
  log: silentLog,
  executablePath: discoverExecutable()!,
  profileRoot: profile,
  profileKind: 'ephemeral',
  headed: false,
  viewport: { width: 800, height: 600 },
  quality: 50,
  startTimeoutMs: 20_000,
  humanIdleMs: 60_000,
  idleTimeoutMs: IDLE_MS,
  initialUrl: 'about:blank',
  sink: {
    onFrame() {},
    onViews() {},
    onLease() {},
    onError(_session, error) { console.error('session error', error) },
  },
})

await session.attachViewer()
assert.equal(session.ready, true, 'the browser should be running')
console.log('started, viewer attached')

// With a viewer, the watchdog must not fire.
await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2))
assert.equal(session.ready, true, 'a watched browser must stay open')
console.log('watched browser survived the idle window')

// Drop the viewer and wait: it must close on its own.
session.detachViewer()
const deadline = Date.now() + IDLE_MS * 8
while (session.snapshot().state !== 'closed' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250))
}
assert.equal(session.snapshot().state, 'closed', 'an unwatched browser must close itself')
console.log('unwatched browser closed itself')

// The ephemeral profile directory is gone, so nothing is left on disk either.
const leftovers = (await import('node:fs')).readdirSync(profile)
assert.deepEqual(leftovers, [], `ephemeral profile left files behind: ${leftovers.join(', ')}`)
console.log('ephemeral profile removed')

rmSync(profile, { recursive: true, force: true })
void pidFile
console.log('idle reclamation works')
process.exit(0)
