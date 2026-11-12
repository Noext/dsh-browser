/**
 * Google sign-in through the plugin's own launcher.
 *
 * The launcher is what a real Session uses, so this is the end-to-end check that
 * `headed: false` no longer trips the "browser may not be secure" refusal.
 * @module tests/google-signin
 */
import { launchBrowser, discoverExecutable } from '../src/host/launcher.ts'
import { connectCdp } from '../src/host/cdp.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SIGN_IN = 'https://accounts.google.com/ServiceLogin?hl=en'

async function attempt(headed) {
  const dir = mkdtempSync(join(tmpdir(), 'gsign-'))
  const browser = await launchBrowser({
    executablePath: discoverExecutable(), profileDir: join(dir, 'chromium'),
    headed, viewport: { width: 1280, height: 800 }, startTimeoutMs: 25_000,
  })
  const { connection } = await connectCdp(browser.webSocketDebuggerUrl)
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (m, p = {}) => connection.send(m, p, sessionId)
  await send('Page.enable')
  await send('Page.navigate', { url: SIGN_IN })
  await new Promise((r) => setTimeout(r, 5000))
  const read = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value
  const ua = await read('navigator.userAgent')
  await read(`(() => {
    const input = document.querySelector('input[type=email], input[name=identifier]')
    if (!input) return false
    input.focus(); input.value = 'dsh.probe.nonexistent@gmail.com'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#identifierNext, button[jsname]')?.click()
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 6000))
  const text = (await read('document.body.innerText')) ?? ''
  const blocked = /couldn.t sign you in|may not be secure/iu.test(text)
  connection.close(); await browser.close(); rmSync(dir, { recursive: true, force: true })
  return { headed, blocked, headlessUa: ua?.includes('HeadlessChrome') ?? false }
}

const modes = [false, true]
const failures = []
for (const headed of modes) {
  const result = await attempt(headed)
  console.log(JSON.stringify(result))
  if (result.blocked) failures.push(headed ? 'headed' : 'headless')
  if (!headed && result.headlessUa) failures.push('headless still advertises HeadlessChrome')
}

if (failures.length > 0) {
  console.error('REFUSED in:', failures.join(', '))
  process.exit(1)
}
console.log('Google accepts the sign-in page in both modes')
