/**
 * A browser that dies under a live session must be replaceable.
 *
 * Closing Chromium from outside (a crash, a closed window, a kill) used to leave
 * the session reporting "ready" against a dead socket, so every tool failed with
 * "the browser connection closed" until the Host restarted. The session must
 * notice and start a new browser instead.
 * @module tests/connection-loss
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const profile = mkdtempSync(join(tmpdir(), 'dsh-browser-loss-'))
const session = new BrowserSession({
  log: silentLog,
  executablePath: discoverExecutable()!,
  profileRoot: profile,
  profileKind: 'ephemeral',
  headed: false,
  viewport: { width: 800, height: 600 },
  quality: 50,
  startTimeoutMs: 25_000,
  humanIdleMs: 60_000,
  idleTimeoutMs: 0,
  initialUrl: 'about:blank',
  sink: { onFrame() {}, onViews() {}, onLease() {}, onError() {} },
})

const cleanup = (): void => { rmSync(profile, { recursive: true, force: true }) }
process.on('exit', cleanup)

await session.attachViewer()
assert.equal(session.ready, true, 'the browser should start')
const firstUrl = session.snapshot().views[0]?.url
console.log('started, state:', session.snapshot().state)

// Kill Chromium from outside, the way a crash or an external close would.
const pids = execSync(`ps -eo pid,args | grep 'user-data-dir=${profile}' | grep -v grep | awk '{print $1}'`).toString().trim().split('\n').filter(Boolean)
assert.ok(pids.length > 0, 'the browser process should be findable')
for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL') } catch { /* gone */ } }
console.log('killed', pids.length, 'browser processes')

// Give the socket close time to propagate.
await new Promise((resolve) => setTimeout(resolve, 2500))

// The next call must relaunch instead of trusting the dead connection.
await session.claimAgent()
assert.equal(session.ready, true, 'the session should recover a live browser')
const secondUrl = session.snapshot().views[0]?.url
console.log('recovered, state:', session.snapshot().state, '| view:', secondUrl)
assert.notEqual(session.activeView, undefined, 'a view should exist after recovery')

// And a tool-level command must work again, not fail with "connection closed".
const activeView = session.activeView
assert.notEqual(activeView, undefined, 'a view should exist after recovery')
const page = await activeView!.readText(200)
assert.equal(typeof page.url, 'string')
console.log('commands work again:', page.url)
void firstUrl

await session.dispose('test')
cleanup()
console.log('a lost browser connection is recovered')
process.exit(0)