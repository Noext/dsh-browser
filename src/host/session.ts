/**
 * One Session's browser: process, connection, views, and the control lease.
 *
 * The Session (an Agent) is the ownership key, exactly like the shipped
 * browser-use runtime: a resumed Session with the same durable id starts fresh
 * instead of inheriting another run's browser.
 * @module dsh-browser/host/session
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ControlMachine, type Lease, type Transition } from '../shared/control.ts'
import { connectCdp, type CdpConnection, type CdpEvent } from './cdp.ts'
import { launchBrowser, type Launch } from './launcher.ts'
import type { Log } from './log.ts'
import { BrowserView, type Frame, type ViewSink } from './view.ts'

/** Everything a viewer needs to render the session. */
export interface SessionSnapshot {
  readonly state: 'starting' | 'ready' | 'closed' | 'failed'
  readonly lease: Lease
  readonly views: readonly { viewId: string; url: string; title: string; loading: boolean }[]
  readonly activeViewId: string | undefined
  readonly viewport: { width: number; height: number }
  readonly error: string | undefined
}

/** Callbacks a session reports to the plugin. */
export interface SessionSink {
  onFrame(session: BrowserSession, view: BrowserView, frame: Frame): void
  onViews(session: BrowserSession): void
  onLease(session: BrowserSession, transition: Transition): void
  onError(session: BrowserSession, error: Error): void
}

/** Settings for one session, resolved from plugin config. */
export interface SessionOptions {
  readonly log: Log
  readonly sink: SessionSink
  /** Absolute path of a Chromium executable. */
  readonly executablePath: string
  /** Profile root; each session gets a subdirectory. */
  readonly profileRoot: string
  readonly profileKind: 'persistent' | 'ephemeral'
  readonly headed: boolean
  readonly viewport: { width: number; height: number }
  readonly quality: number
  readonly startTimeoutMs: number
  readonly humanIdleMs: number
  /** Close the browser after this long with no viewer and no activity; 0 disables it. */
  readonly idleTimeoutMs: number
  readonly initialUrl: string
}

/**
 * A session is lazily started: constructing it does no I/O, so an Agent that
 * never opens the browser pays nothing.
 */
export class BrowserSession {
  private readonly options: SessionOptions
  private readonly control: ControlMachine
  private readonly views = new Map<string, BrowserView>()
  private launch: Launch | undefined
  private connection: CdpConnection | undefined
  private starting: Promise<void> | undefined
  private state: SessionSnapshot['state'] = 'starting'
  private failure: string | undefined
  private activeViewId: string | undefined
  private viewport: { width: number; height: number }
  private viewers = 0
  private disposed = false
  /** Last time either party did something; drives idle reclamation. */
  private lastActivityAt = Date.now()
  private idleTimer: ReturnType<typeof setInterval> | undefined
  /** Work in flight that must not be interrupted by reclamation. */
  private busy = 0
  private readonly onDispose: (() => void) | undefined
  private request: { reason: string; startedAt: number } | undefined
  private requestResolve: ((outcome: 'released' | 'cancelled') => void) | undefined

  constructor(options: SessionOptions, onDispose?: () => void) {
    this.options = options
    this.onDispose = onDispose
    this.viewport = options.viewport
    this.control = new ControlMachine({ humanIdleMs: options.humanIdleMs })
  }

  /** Current lease. */
  get lease(): Lease { return this.control.current }
  /** The live view a viewer should show. */
  get activeView(): BrowserView | undefined {
    return this.activeViewId === undefined ? undefined : this.views.get(this.activeViewId)
  }
  /** Whether the browser process is up. */
  get ready(): boolean { return this.state === 'ready' }
  /** Why the session failed, when it did. */
  get error(): string | undefined { return this.failure }

  /** How many windows are mirroring this browser right now. */
  get watchers(): number { return this.viewers }

  /** The Agent's outstanding request for human help, if any. */
  get pendingRequest(): { reason: string; startedAt: number } | undefined { return this.request }

  /**
   * Hand the browser to the human and wait for them to hand it back.
   *
   * The Agent's tool call stays blocked for the whole takeover, which is what
   * makes the handover observable: a silent release would let the Agent race a
   * person who is still typing a password.
   * @param reason - what the human needs to do.
   * @param timeoutSeconds - give up after this long.
   * @param signal - cancels the wait without taking the browser back.
   * @returns how the wait ended.
   */
  async requestHuman(reason: string, timeoutSeconds: number, signal: AbortSignal): Promise<'released' | 'timeout' | 'cancelled'> {
    if (this.request !== undefined) throw new Error('a human request is already pending for this browser')
    await this.claimHuman(signal)
    this.request = { reason, startedAt: Date.now() }
    this.options.sink.onViews(this)
    let timedOut = false
    const outcome = await new Promise<'released' | 'timeout' | 'cancelled'>((resolve) => {
      const settle = (value: 'released' | 'timeout' | 'cancelled'): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.requestResolve = undefined
        resolve(value)
      }
      const abort = (): void => { settle('cancelled') }
      const timer = setTimeout(() => { timedOut = true; settle('timeout') }, timeoutSeconds * 1000)
      this.requestResolve = (value) => { settle(value) }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      void timedOut
    })
    this.request = undefined
    this.requestResolve = undefined
    this.releaseToAgent()
    this.options.sink.onViews(this)
    return outcome
  }

  /** Resolve a pending human request, from the UI's "I'm done" action. */
  finishHumanRequest(outcome: 'released' | 'cancelled'): boolean {
    const resolve = this.requestResolve
    if (resolve === undefined) return false
    resolve(outcome)
    return true
  }

  /** Snapshot for status responses. */
  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      lease: this.control.current,
      views: [...this.views.values()].map((view) => ({
        viewId: view.sessionId,
        url: view.currentUrl,
        title: view.currentTitle,
        loading: view.isLoading,
      })),
      activeViewId: this.activeViewId,
      viewport: this.viewport,
      error: this.failure,
    }
  }

  /**
   * Start the browser if it is not up; concurrent callers share one launch.
   * @param signal - cancels the wait, not the launch.
   */
  async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('the browser session has been disposed')
    if (this.state === 'ready') return
    if (this.state === 'failed') throw new Error(this.failure ?? 'the browser session failed to start')
    if (this.starting === undefined) this.starting = this.start()
    return await withSignal(this.starting, signal)
  }

  /** Register a viewer; the first one starts the screencast. */
  async attachViewer(signal?: AbortSignal): Promise<void> {
    await this.ensureStarted(signal)
    this.viewers++
    const view = this.activeView ?? await this.createView(this.options.initialUrl, signal)
    await view.startStreaming()
  }

  /** Release a viewer; the last one stops the screencast. */
  detachViewer(): void {
    this.viewers = Math.max(0, this.viewers - 1)
    this.touch()
    if (this.viewers > 0) return
    for (const view of this.views.values()) void view.stopStreaming()
    void this.control.release(Date.now())
  }

  /** Claim the browser for the Agent, creating it when needed. */
  async claimAgent(signal?: AbortSignal): Promise<Lease> {
    await this.ensureStarted(signal)
    this.touch()
    const transition = this.control.claimAgent(Date.now())
    if (transition.changed) this.options.sink.onLease(this, transition)
    return transition.after
  }

  /** Claim the browser for the human. */
  async claimHuman(signal?: AbortSignal): Promise<Lease> {
    await this.ensureStarted(signal)
    this.touch()
    const transition = this.control.claimHuman(Date.now())
    if (transition.changed) this.options.sink.onLease(this, transition)
    return transition.after
  }

  /** Give the browser back to the Agent. */
  releaseToAgent(): Lease {
    const transition = this.control.release(Date.now())
    if (transition.changed) this.options.sink.onLease(this, transition)
    return transition.after
  }

  /** Extend a human lease on observed input. */
  touchHuman(): void {
    this.control.touch(Date.now())
  }

  /** Drop an expired human lease. */
  expireLease(): void {
    const transition = this.control.expire(Date.now())
    if (transition !== undefined) this.options.sink.onLease(this, transition)
  }

  /** Whether browser tools may run right now. */
  get allowsAgent(): boolean { return this.control.allowsAgent(Date.now()) }
  /** Whether human input may be forwarded right now. */
  get allowsHuman(): boolean { return this.control.allowsHuman(Date.now()) }

  /**
   * Resize every view to a new pane size.
   * @param viewport - page pixels.
   */
  async resize(viewport: { width: number; height: number }, devicePixelRatio = 1): Promise<void> {
    this.viewport = viewport
    for (const view of this.views.values()) await view.setViewport(viewport, devicePixelRatio)
    this.options.sink.onViews(this)
  }

  /** Create another tab and make it active. */
  async createView(url: string, signal?: AbortSignal): Promise<BrowserView> {
    await this.ensureStarted(signal)
    const connection = this.connection
    if (connection === undefined) throw new Error('the browser connection is not open')
    const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const view = new BrowserView({
      connection,
      targetId,
      sessionId,
      sink: this.viewSink(),
      log: this.options.log,
      quality: this.options.quality,
      viewport: this.viewport,
    })
    this.views.set(sessionId, view)
    this.activeViewId = sessionId
    try {
      await view.start(url)
    } catch (error) {
      this.views.delete(sessionId)
      await view.close().catch(() => {})
      throw error
    }
    this.options.sink.onViews(this)
    return view
  }

  /**
   * Make an existing tab the one viewers see.
   * @param viewId - the view's CDP session id.
   */
  async selectView(viewId: string): Promise<void> {
    if (!this.views.has(viewId)) throw new Error(`no browser view "${viewId}"`)
    const previous = this.activeView
    this.activeViewId = viewId
    if (previous !== undefined && previous.sessionId !== viewId) await previous.stopStreaming()
    const view = this.views.get(viewId)
    if (view !== undefined && this.viewers > 0) await view.startStreaming()
    this.options.sink.onViews(this)
  }

  /**
   * Close one tab.
   * @param viewId - the view to close.
   */
  async closeView(viewId: string): Promise<void> {
    const view = this.views.get(viewId)
    if (view === undefined) return
    this.views.delete(viewId)
    await view.close()
    if (this.activeViewId === viewId) {
      const next = [...this.views.keys()].at(-1)
      this.activeViewId = next
      const view2 = next === undefined ? undefined : this.views.get(next)
      if (view2 !== undefined && this.viewers > 0) await view2.startStreaming()
    }
    this.options.sink.onViews(this)
  }

  /** Record that a party used the browser, which defers idle reclamation. */
  touch(): void {
    this.lastActivityAt = Date.now()
  }

  /**
   * Reclaim a browser nobody is watching.
   *
   * A viewer that stops existing (a closed tab, a closed browser window, a
   * crash) must not leave a Chromium process running forever: that is how
   * abandoned windows pile up on the user's desktop. The grace is generous
   * because collapsing the sidebar and switching Sessions both drop the viewer
   * while the user still considers the browser theirs.
   */
  private startIdleWatch(): void {
    if (this.options.idleTimeoutMs <= 0) return
    const interval = Math.max(5000, Math.min(30_000, Math.floor(this.options.idleTimeoutMs / 4)))
    this.idleTimer = setInterval(() => {
      if (this.disposed || this.viewers > 0 || this.busy > 0) return
      if (Date.now() - this.lastActivityAt < this.options.idleTimeoutMs) return
      this.options.log.info('closing an idle browser nobody is watching')
      void this.dispose('idle reclamation')
    }, interval)
    this.idleTimer.unref?.()
  }

  /** Close the browser and every view. Idempotent. */
  async dispose(reason: string): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer)
      this.idleTimer = undefined
    }
    this.state = 'closed'
    this.options.log.info(`closing browser session (${reason})`)
    for (const view of [...this.views.values()]) {
      this.views.delete(view.sessionId)
      await view.close().catch((error: unknown) => { this.options.log.debug('view close failed', error) })
    }
    this.connection?.close()
    this.connection = undefined
    const launch = this.launch
    this.launch = undefined
    if (launch !== undefined) {
      await launch.close().catch((error: unknown) => { this.options.log.warn('browser close failed', error) })
      if (this.options.profileKind === 'ephemeral') {
        rmSync(launch.profileDir, { recursive: true, force: true })
      }
    }
    this.onDispose?.()
  }

  private async start(): Promise<void> {
    try {
      mkdirSync(this.options.profileRoot, { recursive: true, mode: 0o700 })
      const launch = await launchBrowser({
        executablePath: this.options.executablePath,
        profileDir: join(this.options.profileRoot, 'chromium'),
        headed: this.options.headed,
        viewport: this.options.viewport,
        startTimeoutMs: this.options.startTimeoutMs,
      })
      this.launch = launch
      this.options.log.info(`browser started: ${launch.version} on port ${launch.port}`)
      const { connection } = await connectCdp(launch.webSocketDebuggerUrl)
      this.connection = connection
      connection.onEvent((event: CdpEvent) => {
        if (event.method === 'Target.targetDestroyed') {
          const targetId = event.params?.targetId
          const view = [...this.views.values()].find((candidate) => candidate.targetId === targetId)
          if (view !== undefined) void this.closeView(view.sessionId)
        }
      })
      this.state = 'ready'
      this.startIdleWatch()
      // No tab is created here: the viewer that triggered this start creates the
      // first one, and a tool call creates one when no viewer exists. Creating
      // one eagerly left every session with an empty second tab.
    } catch (error) {
      this.state = 'failed'
      this.failure = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && 'hint' in error && typeof error.hint === 'string') {
        this.failure = `${this.failure} — ${error.hint}`
      }
      this.options.log.error('browser session failed to start', error)
      this.options.sink.onError(this, error instanceof Error ? error : new Error(String(error)))
      await this.dispose('startup failed').catch(() => {})
      throw error
    }
  }

  private viewSink(): ViewSink {
    return {
      onFrame: (view, frame) => { this.options.sink.onFrame(this, view, frame) },
      onNavigation: (view) => { this.options.sink.onViews(this); void view },
      onCursor: () => {},
      onClosed: (view, reason) => {
        this.views.delete(view.sessionId)
        if (this.activeViewId === view.sessionId) this.activeViewId = [...this.views.keys()].at(-1)
        this.options.log.debug(`view closed: ${reason}`)
        this.options.sink.onViews(this)
      },
      onError: (view, error) => {
        this.options.log.warn(`view ${view.sessionId} reported an error`, error)
      },
    }
  }
}

/** Await a promise, rejecting early when the caller cancels. */
async function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise
  if (signal.aborted) throw new Error('cancelled')
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(new Error('cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}
