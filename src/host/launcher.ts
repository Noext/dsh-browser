/**
 * Launching and owning one Chromium process.
 *
 * The browser is a real, headed Chromium on a random loopback debugging port:
 * a headless browser would render a page the human cannot interact with the way
 * the site expects (extensions, media, some WebAuthn flows).
 * @module dsh-browser/host/launcher
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { browserEndpoint } from './cdp.ts'

/** One launched browser. */
export interface Launch {
  readonly pid: number | undefined
  readonly profileDir: string
  readonly port: number
  readonly webSocketDebuggerUrl: string
  readonly version: string
  /** Terminate the browser and wait for it to exit. */
  close(): Promise<void>
}

/** Launch settings resolved from plugin configuration. */
export interface LaunchOptions {
  /** Absolute path to a Chromium/Chrome executable. */
  executablePath: string
  /** Profile directory; the caller owns creation, locking and deletion. */
  profileDir: string
  /** Honour the host display; false forces the new headless mode. */
  headed: boolean
  /** Initial window size, matching the emulated viewport. */
  viewport: { width: number; height: number }
  /** Extra Chromium switches. */
  args?: readonly string[]
  /** Give up after this long. */
  startTimeoutMs: number
}

/** Why a launch failed in a way the user can act on. */
export class LaunchError extends Error {
  override readonly name = 'LaunchError'
  readonly hint: string

  constructor(message: string, hint: string, options?: { cause?: unknown }) {
    super(message, options)
    this.hint = hint
  }
}

/** Chromium exit codes that mean "the profile is already in use". */
const PROFILE_IN_USE = /SingletonLock|profile.*in use|cannot create.*lock/iu

/**
 * Launch Chromium with a random debugging port.
 *
 * The port is read back from `DevToolsActivePort` inside the profile: parsing
 * stderr for a chosen port races with Chromium's own startup logging and is not
 * reliable across versions.
 * @param options - executable, profile, and display settings.
 * @returns the running browser.
 */
export async function launchBrowser(options: LaunchOptions): Promise<Launch> {
  if (!existsSync(options.executablePath)) {
    throw new LaunchError(
      `Chromium was not found at "${options.executablePath}"`,
      'set dsh-browser\'s executablePath, or set DSH_BROWSER_EXECUTABLE, or run "npx playwright install chromium"',
    )
  }
  mkdirSync(options.profileDir, { recursive: true, mode: 0o700 })

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${options.profileDir}`,
    `--window-size=${options.viewport.width},${options.viewport.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    // Chromium's own crash reporter would upload; the profile is a user secret.
    '--disable-breakpad',
    // Sign-in providers look at more than the User-Agent string. Headless
    // Chromium also reports "HeadlessChrome" in its UA, exposes
    // `navigator.webdriver`, and sends a `sec-ch-ua` branding of "Chromium".
    // These switches make all three agree with the Chrome version actually
    // running; without them Google answers "this browser or app may not be
    // secure" even when the UA string looks normal.
    ...(options.headed ? [] : ['--headless=new']),
    `--user-agent=${chromeUserAgent()}`,
    `--brand=${chromeBranding()}`,
    '--disable-blink-features=AutomationControlled',
    // Chromium refuses to start as root with its sandbox enabled; the plugin's
    // own confinement story is the profile directory, not the renderer sandbox.
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...(options.args ?? []),
    'about:blank',
  ]

  const child = spawn(options.executablePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Chromium must never inherit the Host's credential environment.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? options.profileDir,
      ...(process.env.DISPLAY === undefined ? {} : { DISPLAY: process.env.DISPLAY }),
      ...(process.env.WAYLAND_DISPLAY === undefined ? {} : { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }),
      ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
    },
  })

  const stderr: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'))
    if (stderr.length > 40) stderr.shift()
  })
  let exitCode: number | null | undefined
  child.once('exit', (code) => { exitCode = code })

  const portFile = join(options.profileDir, 'DevToolsActivePort')
  // A previous run leaves its port behind. Chromium only rewrites the file once
  // the new browser is ready, so waiting for "exists" would read a dead port.
  rmSync(portFile, { force: true })
  const deadline = Date.now() + options.startTimeoutMs
  while (!existsSync(portFile)) {
    if (exitCode !== undefined) {
      const detail = stderr.join('')
      throw new LaunchError(
        `Chromium exited with code ${exitCode} during startup`,
        PROFILE_IN_USE.test(detail)
          ? 'the browser profile is already in use by another Chromium; close it, or let dsh-browser manage this profile'
          : `check the browser profile at ${options.profileDir}`,
      )
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new LaunchError(
        'Chromium did not publish its debugging port in time',
        'if this is a remote or containerized environment, ensure a display is available or set headed: false',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const [portLine] = readFileSync(portFile, 'utf8').trim().split('\n')
  const port = Number(portLine)
  if (!Number.isInteger(port) || port <= 0) {
    child.kill('SIGKILL')
    throw new LaunchError('Chromium published an unreadable debugging port', `delete ${options.profileDir} and retry`)
  }
  // The file is written before the HTTP endpoint is necessarily listening.
  const readyBy = Date.now() + options.startTimeoutMs
  while (Date.now() < readyBy) {
    try {
      await browserEndpoint(port)
      break
    } catch (error) {
      if (Date.now() >= readyBy) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  let endpoint: { webSocketDebuggerUrl: string; browser: string }
  try {
    endpoint = await browserEndpoint(port)
  } catch (error) {
    child.kill('SIGKILL')
    throw new LaunchError('Chromium started but its debugging endpoint did not answer', 'retry; if it persists, delete the browser profile', { cause: error })
  }

  return {
    pid: child.pid,
    profileDir: options.profileDir,
    port,
    webSocketDebuggerUrl: endpoint.webSocketDebuggerUrl,
    version: endpoint.browser,
    async close() {
      await stop(child, options.profileDir)
    },
  }
}


/**
 * A Chrome User-Agent without the headless marker.
 *
 * Chromium's headless build puts "HeadlessChrome" where a browser name belongs;
 * Google's sign-in refuses that string with "this browser or app may not be
 * secure". The rest of the string still describes the actual engine, so sites
 * get an honest platform and version.
 * @returns the User-Agent to present in headless mode.
 */
export function chromeUserAgent(): string {
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
  const version = process.versions.chrome ?? '156.0.0.0'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
}


/**
 * Chrome's product branding, so `sec-ch-ua` does not say "Chromium".
 *
 * Client hints are what a site reads for the browser family; leaving the
 * default makes a real Chrome identify as plain Chromium, which some sign-in
 * flows treat as unsupported.
 * @returns the `--brand` argument value.
 */
function chromeBranding(): string {
  return `Google Chrome`
}

/**
 * Close Chromium gracefully, then kill it if it ignores SIGTERM.
 * @param child - the process we spawned.
 * @param profileDir - profile to clean up afterwards.
 */
async function stop(child: ChildProcess, profileDir: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    // SIGTERM alone skips Chromium's shutdown path: cookies and storage stay in
    // memory, so the next launch finds an empty profile and every login is lost.
    // Asking the browser to close runs that path, which is what persists them.
    await requestBrowserClose(profileDir).catch(() => undefined)
    child.kill('SIGTERM')
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
    ])
    if (timedOut) {
      child.kill('SIGKILL')
      await exited
    }
    // Give Chromium a moment to finish committing the profile database.
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
  }
  // Chromium leaves Singleton* links behind when killed; they block the next launch.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(profileDir, name), { force: true })
  }
}

/**
 * Find a Chromium executable without a config entry.
 * @returns the first usable path, or `undefined`.
 */
export function discoverExecutable(): string | undefined {
  if (process.env.DSH_BROWSER_EXECUTABLE !== undefined) return process.env.DSH_BROWSER_EXECUTABLE
  const candidates = [
    // Playwright's own cache is the most likely source on a dev machine.
    ...playwrightCandidates(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/** Enumerate Playwright's browser cache, newest revision first. */
function playwrightCandidates(): string[] {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME ?? '', '.cache', 'ms-playwright'),
    join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright'),
  ].filter((root): root is string => typeof root === 'string' && root !== '')
  const found: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      entries = []
    }
    const revisions = entries
      .filter((name) => name.startsWith('chromium-') && !name.includes('headless_shell') && !name.includes('tip-of-tree'))
      .sort()
      .reverse()
    for (const revision of revisions) {
      found.push(
        join(root, revision, 'chrome-linux64', 'chrome'),
        join(root, revision, 'chrome-linux', 'chrome'),
        join(root, revision, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(root, revision, 'chrome-win', 'chrome.exe'),
      )
    }
  }
  return found
}
/**
 * Ask Chromium to close through its own protocol.
 *
 * A signal kills the process before it commits its profile, so cookies, local
 * storage and the saved logins never reach disk. This is the difference between
 * a browser a person can stay signed into and one that forgets every restart.
 * @param profileDir - the profile whose browser should close.
 * @returns resolves once the request is delivered or has clearly failed.
 */
async function requestBrowserClose(profileDir: string): Promise<void> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  if (!existsSync(portFile)) return
  const port = readFileSync(portFile, 'utf8').split('\n')[0]?.trim()
  if (port === undefined || port === '') return
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
  if (!version.ok) return
  const info = (await version.json()) as { webSocketDebuggerUrl?: string }
  if (info.webSocketDebuggerUrl === undefined) return
  const socket = new WebSocket(info.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const done = (): void => { try { socket.close() } catch { /* already closed */ } resolve() }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }))
      // The socket closes as the browser exits; either answer is success.
      setTimeout(done, 2000)
    })
    socket.addEventListener('error', reject)
    socket.addEventListener('close', done)
    setTimeout(done, 2500)
  })
}
