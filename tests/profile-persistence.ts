/**
 * A login must survive a new Session.
 *
 * The profile was keyed on the session id, which changes with every new
 * conversation, so each Session got an empty browser: cookies gone, sign-in gone.
 * This writes a cookie in one Session's browser, closes it, and requires the next
 * Session's browser to still have it.
 * @module tests/profile-persistence
 */
import { BrowserSession } from '../src/host/session.ts'
import { createProfiles } from '../src/host/profiles.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const root = mkdtempSync(join(tmpdir(), 'profile-persist-'))
const profiles = createProfiles({ persistent: true, root })
const cleanup = (): void => { rmSync(root, { recursive: true, force: true }) }
process.on('exit', cleanup)

const base = {
  log: silentLog, executablePath: discoverExecutable()!,
  profileKind: 'persistent' as const, headed: false,
  viewport: { width: 800, height: 600 }, quality: 50,
  startTimeoutMs: 25_000, humanIdleMs: 60_000, idleTimeoutMs: 0,
  initialUrl: 'about:blank',
  sink: { onFrame() {}, onViews() {}, onLease() {}, onError() {} },
}

// Two Sessions with different ids but no workspace: the deployment cannot name
// one, which is exactly the case that was broken.
const firstDir = profiles.directoryFor({ id: 'session-aaa' })
const secondDir = profiles.directoryFor({ id: 'session-bbb' })
assert.equal(firstDir, secondDir, 'two Sessions without a workspace must share one profile')
console.log('both sessions map to the same profile:', firstDir === secondDir)

const first = new BrowserSession({ ...base, profileRoot: firstDir })
await first.attachViewer()
const view1 = first.activeView!
await view1.navigate('https://example.com')
await new Promise((r) => setTimeout(r, 1500))
await view1.setCookie({ name: 'dsh_persist_probe', value: 'kept', url: 'https://example.com/', expires: Math.floor(Date.now() / 1000) + 86_400 })
console.log('cookie written in session aaa')
await first.dispose('first session ends')

// A new Session, as a new conversation would start it.
const second = new BrowserSession({ ...base, profileRoot: secondDir })
await second.attachViewer()
const view2 = second.activeView!
await view2.navigate('https://example.com')
await new Promise((r) => setTimeout(r, 1500))
const found = await view2.getCookie('dsh_persist_probe')
console.log('cookie seen by the new session:', found === undefined ? 'MISSING' : found.value)

await second.dispose('second session ends')
cleanup()
assert.notEqual(found, undefined, 'a cookie must survive into a new Session')
console.log('a sign-in survives a new Session')
process.exit(0)