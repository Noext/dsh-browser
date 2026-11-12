/**
 * Two separate DSH boots must share one browser profile.
 *
 * This is the scenario that was broken: start the Host, sign in, stop the Host,
 * start it again. Two independent processes mean no shared in-memory state can
 * fake the result — only the profile on disk can carry the cookie across.
 * @module tests/boot-persistence
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

const repo = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(repo, 'src/host')

const server = createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'text/html' })
  s.end('<title>site</title>')
})
const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))
const origin = 'http://127.0.0.1:' + port + '/'

const DSH_HOME = mkdtempSync(join(tmpdir(), 'dshhome-'))
const cleanup = () => { rmSync(DSH_HOME, { recursive: true, force: true }); server.close() }
process.on('exit', cleanup)

// The child script is assembled with plain concatenation so nothing in this
// file's own template syntax is interpolated by accident.
function childScript(writeCookie: boolean): string {
  const profile = srcDir + '/profiles.ts'
  const sessionMod = srcDir + '/session.ts'
  const launcher = srcDir + '/launcher.ts'
  const log = srcDir + '/log.ts'
  return [
    "const { createProfiles } = await import('" + profile + "')",
    "const { BrowserSession } = await import('" + sessionMod + "')",
    "const { discoverExecutable } = await import('" + launcher + "')",
    "const { silentLog } = await import('" + log + "')",
    "const profiles = createProfiles({ persistent: true })",
    "// A different session id each boot, as two conversations would have.",
    "const dir = profiles.directoryFor({ id: 'session-' + Math.random().toString(36).slice(2) })",
    "const session = new BrowserSession({",
    "  log: silentLog, executablePath: discoverExecutable(), profileRoot: dir,",
    "  profileKind: 'persistent', headed: false, viewport: { width: 800, height: 600 },",
    "  quality: 50, startTimeoutMs: 25000, humanIdleMs: 60000, idleTimeoutMs: 0,",
    "  initialUrl: 'about:blank', sink: { onFrame(){}, onViews(){}, onLease(){}, onError(){} },",
    "})",
    "await session.attachViewer()",
    "const view = session.activeView",
    "await view.navigate('" + origin + "')",
    "await new Promise((r) => setTimeout(r, 1200))",
    writeCookie
      ? "await view.setCookie({ name: 'boot_probe', value: 'survived', url: '" + origin + "', expires: Math.floor(Date.now()/1000) + 86400 })"
      : "// read-only boot",
    "await new Promise((r) => setTimeout(r, 400))",
    "const found = await view.getCookie('boot_probe')",
    "await session.dispose('boot ends')",
    "process.stdout.write(found === undefined ? 'MISSING' : found.value)",
    "process.exit(0)",
  ].join('\n')
}

/**
 * Run one boot in a separate process.
 * @param writeCookie - whether to write the cookie first.
 * @returns the cookie value that boot could read.
 */
async function boot(writeCookie: boolean): Promise<string> {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childScript(writeCookie)], {
    env: { ...process.env, DSH_HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += String(c) })
  child.stderr.on('data', (c) => { err += String(c) })
  const code = await new Promise((r) => child.once('exit', (c) => r(c ?? 1)))
  if (code !== 0) throw new Error('boot failed: ' + err.slice(0, 400))
  return out.trim()
}

const first = await boot(true)
console.log('boot 1 wrote and read:', first)
const second = await boot(false)
console.log('boot 2 read:', second)

const profileRoot = join(DSH_HOME, 'browser-profiles')
const dirs = readdirSync(profileRoot)
console.log('profile directories:', dirs.join(','))

cleanup()
if (second !== 'survived') { console.error('the cookie did not survive a second boot'); process.exit(1) }
if (dirs.length !== 1) { console.error('expected one shared profile, got ' + dirs.length); process.exit(1) }
console.log('a login survives a Host restart')
process.exit(0)