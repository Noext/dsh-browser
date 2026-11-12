/**
 * Google sign-in through the session's real view, not a bare CDP page.
 *
 * The identity override lives in BrowserView, so this is the only test that
 * covers what a user actually gets: launch, view, navigation, form submission.
 * @module tests/google-signin
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = mkdtempSync(join(tmpdir(), 'gsign-'))
const session = new BrowserSession({
  log: silentLog, executablePath: discoverExecutable()!,
  profileRoot: profile, profileKind: 'ephemeral', headed: false,
  viewport: { width: 1280, height: 800 }, quality: 50,
  startTimeoutMs: 25_000, humanIdleMs: 60_000, idleTimeoutMs: 0,
  initialUrl: 'about:blank',
  sink: { onFrame() {}, onViews() {}, onLease() {}, onError() {} },
})
const cleanup = (): void => { rmSync(profile, { recursive: true, force: true }) }
process.on('exit', cleanup)

await session.attachViewer()
const view = session.activeView!
await view.navigate('https://accounts.google.com/ServiceLogin?hl=en')
await new Promise((r) => setTimeout(r, 6000))

const identity = await view.readText(0).then(() => undefined).catch(() => undefined)
void identity

// Submit a throwaway identifier and see whether Google answers with a refusal.
const connection = (view as unknown as { options: { connection: import('../src/host/cdp.ts').CdpConnection } }).options.connection
await connection.send('Runtime.evaluate', {
  expression: `(() => {
    const input = document.querySelector('input[type=email], input[name=identifier]')
    if (!input) return false
    input.focus(); input.value = 'dsh.probe.nonexistent@gmail.com'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#identifierNext, button[jsname]')?.click()
    return true
  })()`,
  returnByValue: true,
}, (view as unknown as { sessionId: string }).sessionId)
await new Promise((r) => setTimeout(r, 7000))

const page = await view.readText(4000)
const blocked = /couldn.t sign you in|may not be secure/iu.test(page.text)
console.log(JSON.stringify({ blocked, title: page.title, excerpt: page.text.replace(/\s+/gu, ' ').slice(0, 80) }))

await session.dispose('test')
cleanup()
if (blocked) { console.error('Google still refuses'); process.exit(1) }
console.log('Google accepts the sign-in through the real view')
process.exit(0)
