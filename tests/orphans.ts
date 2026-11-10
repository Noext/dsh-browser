/**
 * Adopting browsers a killed Host left behind.
 *
 * A Chromium outlives `kill -9` on its parent. Before adoption, restarting the
 * Host stacked new windows beside the orphans and then failed to launch, because
 * the dead browser still held the profile lock. This test builds that exact state
 * with a real browser and checks that one sweep reclaims it.
 * @module tests/orphans
 */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { adoptOrphans, lockOwner } from '../src/host/orphans.ts'
import { spawn } from 'node:child_process'
import { discoverExecutable } from '../src/host/launcher.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-browser-orphans-'))
const profile = join(root, 'abc123', 'chromium')
mkdirSync(profile, { recursive: true })

// A real Chromium, started the way the plugin starts one.
const child = spawn(discoverExecutable()!, [
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--no-sandbox',
  '--headless=new',
  'about:blank',
], { stdio: 'ignore' })

// A failing assertion must not leave the browser it spawned running.
const cleanup = (): void => {
  try { child.kill('SIGKILL') } catch { /* already gone */ }
  rmSync(root, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanup(); process.exit(130) })
}

const lock = join(profile, 'SingletonLock')
const deadline = Date.now() + 20_000
while (!present(lock) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
assert.equal(present(lock), true, 'Chromium should have written a lock')
assert.equal(lockOwner(profile), child.pid, 'the lock should name the browser pid')
console.log('lock names pid', child.pid)

const sweep = await adoptOrphans(root)
assert.equal(sweep.scanned, 1)
assert.deepEqual(sweep.killed, [child.pid])
console.log('swept:', sweep.killed.length, 'browser(s)')

// SIGTERM is asynchronous; give Chromium a moment to exit.
const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 8000)
  child.once('exit', () => { clearTimeout(timer); resolve(true) })
})
assert.equal(exited, true, 'the adopted browser should exit')
assert.equal(present(lock), false, 'the stale lock should be gone')
console.log('adopted browser exited and its lock was cleared')

// A lock naming a process that is not Chromium must be cleared, never signalled.
const stranger = join(root, 'def456', 'chromium')
mkdirSync(stranger, { recursive: true })
writeFileSync(join(stranger, 'SingletonCookie'), '')
symlinkSync(`${hostname()}-1`, join(stranger, 'SingletonLock'))
const second = await adoptOrphans(root)
assert.equal(second.killed.includes(1), false, 'pid 1 is not a browser and must not be signalled')
assert.equal(present(join(stranger, 'SingletonLock')), false, 'the foreign lock should be cleared')
console.log('a lock naming an unrelated pid was cleared without signalling it')

// A lock from another machine cannot be verified, so it is cleared, not adopted.
const foreign = join(root, 'ghi789', 'chromium')
mkdirSync(foreign, { recursive: true })
symlinkSync('some-other-host-4242', join(foreign, 'SingletonLock'))
const third = await adoptOrphans(root)
assert.deepEqual(third.killed, [])
assert.equal(present(join(foreign, 'SingletonLock')), false)
console.log('a foreign-host lock was cleared without adoption')

rmSync(root, { recursive: true, force: true })
console.log('orphan adoption works')
process.exit(0)

/**
 * Whether a directory entry exists, including a dangling symlink.
 * @param {string} path - path to test.
 * @returns {boolean} true when the entry is there.
 */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
