/**
 * Fill a real form end to end: check, select, upload, wait.
 *
 * These are the controls a signup or submission form actually uses, and none of
 * them work by clicking at coordinates: a checkbox toggles, a select opens a
 * native popup, and a file input cannot be typed into at all.
 * @module tests/form-controls
 */
import { BrowserSession } from '../src/host/session.ts'
import { discoverExecutable } from '../src/host/launcher.ts'
import { silentLog } from '../src/host/log.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const html = `<!doctype html><meta charset="utf-8"><title>Form</title>
<form>
  <label><input type="checkbox" id="agree" aria-label="I agree"> I agree</label>
  <label><input type="radio" name="plan" value="pro" aria-label="Pro"> Pro</label>
  <label><input type="radio" name="plan" value="free" aria-label="Free"> Free</label>
  <select id="country" aria-label="Country">
    <option value="">Choose</option>
    <option value="fr">France</option>
    <option value="jp">Japan</option>
  </select>
  <input type="file" id="photo" aria-label="Photo" multiple>
  <output id="state">idle</output>
</form>
<script>
  const report = () => {
    const files = Array.from(document.getElementById('photo').files).map((f) => f.name)
    document.getElementById('state').textContent = JSON.stringify({
      agree: document.getElementById('agree').checked,
      plan: document.querySelector('input[name=plan]:checked')?.value ?? null,
      country: document.getElementById('country').value,
      files,
    })
  }
  document.addEventListener('change', report)
  document.addEventListener('input', report)
</script>`

const server = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(html) })
const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))

const profile = mkdtempSync(join(tmpdir(), 'formctl-'))
const cleanup = (): void => { rmSync(profile, { recursive: true, force: true }); server.close() }
process.on('exit', cleanup)

// A real file on disk, the way an agent would have written one.
const photo = join(profile, 'photo.png')
writeFileSync(photo, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'))

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
const refOf = (pattern: RegExp): string => {
  const line = snap.text.split('\n').find((entry) => pattern.test(entry))
  assert.ok(line, 'no line matched ' + pattern)
  return /\[ref=(e\d+)\]/u.exec(line!)?.[1] ?? ''
}

const agree = refOf(/checkbox "I agree"/u)
const pro = refOf(/radio "Pro"/u)
const country = refOf(/combobox "Country"/u)
const photoInput = refOf(/Photo/u)

// 1. Check explicitly, then check it is idempotent in the same direction.
assert.equal((await view.setChecked(agree, true)).checked, true)
assert.equal((await view.setChecked(agree, true)).checked, true, 'checking twice must not toggle')

// 2. Select a radio and a native select.
const radio = await view.setChecked(pro, true)
assert.equal(radio.checked, true)
const chosen = await view.selectOption(country, 'Japan')
assert.equal(chosen.selected, 'Japan')

// 3. Attach a file.
const uploaded = await view.setFiles(photoInput, [photo])
assert.deepEqual(uploaded.names, ['photo.png'], 'the input must report the attached file')

// 4. Wait for the page to reflect all of it.
const waited = await view.waitFor({ text: 'photo.png', timeoutMs: 5000 })
assert.equal(waited.met, true, 'the page should show the attached file')

const state = await view.readText(1000)
console.log('page state:', state.text.replace(/\s+/gu, ' ').slice(0, 200))

assert.match(state.text, /"agree":true/u)
assert.match(state.text, /"plan":"pro"/u)
assert.match(state.text, /"country":"jp"/u)
assert.match(state.text, /"files":\["photo\.png"\]/u)

await session.dispose('test')
cleanup()
console.log('every form control works')
process.exit(0)