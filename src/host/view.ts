/**
 * One live browser view: a CDP page target, its screencast pump, and its input
 * channel.
 *
 * A view owns exactly one screencast. Chromium allows several, but a second
 * frame consumer on the same target doubles the encode cost and makes the ack
 * protocol ambiguous, so the session serialises viewers instead.
 * @module dsh-browser/host/view
 */
import { CdpConnection, type CdpEvent } from './cdp.ts'
import type { Log } from './log.ts'

/** A screencast frame ready for the wire. */
export interface Frame {
  readonly frameId: number
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
}

/** Callbacks one view reports to its owner. */
export interface ViewSink {
  onFrame(view: BrowserView, frame: Frame): void
  onNavigation(view: BrowserView, state: { url: string; title: string; loading: boolean }): void
  onCursor(view: BrowserView, cursor: string): void
  onClosed(view: BrowserView, reason: string): void
  onError(view: BrowserView, error: Error): void
}

/** Construction settings for one view. */
export interface ViewOptions {
  readonly connection: CdpConnection
  readonly targetId: string
  readonly sessionId: string
  readonly sink: ViewSink
  readonly log: Log
  /** JPEG quality for the mirror; the human pane is small, so 55–70 is plenty. */
  readonly quality: number
  /** Viewport to emulate, in page pixels. */
  readonly viewport: { width: number; height: number }
}

/** One browser tab the human can look at. */
export class BrowserView {
  readonly targetId: string
  readonly sessionId: string
  private readonly options: ViewOptions
  private readonly log: Log
  private frames = 0
  private bytes = 0
  private acked = 0
  private pendingFrameId: number | undefined
  private screencastSessionId: number | undefined
  private active = false
  private closed = false
  private url = 'about:blank'
  private title = ''
  private loading = true
  private viewport: { width: number; height: number }
  private deviceScaleFactor = 1
  /** Serialises viewport updates: stop/start of the screencast must not interleave. */
  private viewportQueue: Promise<void> = Promise.resolve()
  private disposeEvents: (() => void) | undefined
  private inflight: (() => Promise<void>) | undefined

  constructor(options: ViewOptions) {
    this.options = options
    this.log = options.log
    this.targetId = options.targetId
    this.sessionId = options.sessionId
    this.viewport = options.viewport
  }

  /** Current address, as last reported by the page. */
  get currentUrl(): string { return this.url }
  /** Current document title. */
  get currentTitle(): string { return this.title }
  /** Whether a document load is in flight. */
  get isLoading(): boolean { return this.loading }
  /** Whether the screencast is running. */
  get streaming(): boolean { return this.active }
  /** Viewport the target is emulated at. */
  get currentViewport(): { width: number; height: number } { return this.viewport }

  /** Enable the domains and wire events. Safe to call once. */
  async start(initialUrl: string): Promise<void> {
    this.disposeEvents = this.options.connection.onEvent((event) => { this.handleEvent(event) })
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true })
    // Keep the mirror honest: emulate a desktop viewport, never a mobile one.
    await this.applyViewport(this.viewport, this.deviceScaleFactor)
    await this.navigate(initialUrl)
  }

  /**
   * Start the screencast, replacing any previous consumer.
   * @returns nothing; frames arrive through the sink.
   */
  async startStreaming(): Promise<void> {
    if (this.closed || this.active) return
    // Chromium answers "Not attached to an active page" while a fresh target is
    // still committing its first navigation, so retry briefly instead of failing
    // the whole viewer attach.
    let lastError: unknown
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await this.send('Page.startScreencast', {
          format: 'jpeg',
          quality: this.options.quality,
          // Chromium only scales frames down to this cap, so it must match the
          // emulated viewport; a larger cap would upscale the frame and blur it.
          maxWidth: Math.round(this.viewport.width * this.deviceScaleFactor),
          maxHeight: Math.round(this.viewport.height * this.deviceScaleFactor),
          everyNthFrame: 1,
        })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (lastError !== undefined) throw lastError
    this.active = true
    this.frames = 0
    this.bytes = 0
  }

  /** Stop the screencast; the page keeps running. */
  async stopStreaming(): Promise<void> {
    if (!this.active) return
    this.active = false
    await this.send('Page.stopScreencast').catch((error: unknown) => {
      this.log.debug('stopScreencast failed', error)
    })
  }

  /**
   * Acknowledge one delivered frame, which is what paces the next one.
   * @param frameId - the id carried by the frame.
   * @returns true when the ack matched the frame we were waiting for.
   */
  ackFrame(frameId: number): boolean {
    if (this.pendingFrameId !== frameId) return false
    this.pendingFrameId = undefined
    this.acked++
    const sessionId = this.screencastSessionId
    if (sessionId === undefined) return true
    void this.send('Page.screencastFrameAck', { sessionId }).catch((error: unknown) => {
      this.log.debug('screencastFrameAck failed', error)
    })
    return true
  }

  /** Frame statistics since streaming started, for diagnostics. */
  stats(): { frames: number; bytes: number; acked: number } {
    return { frames: this.frames, bytes: this.bytes, acked: this.acked }
  }

  /** Navigate to an absolute URL. */
  async navigate(url: string): Promise<void> {
    this.loading = true
    await this.send('Page.navigate', { url })
  }

  /** Go back in the page's own history. */
  async back(): Promise<void> {
    await this.send('Runtime.evaluate', { expression: 'history.back()', userGesture: true })
  }

  /** Go forward in the page's own history. */
  async forward(): Promise<void> {
    await this.send('Runtime.evaluate', { expression: 'history.forward()', userGesture: true })
  }

  /** Reload the current document. */
  async reload(): Promise<void> {
    this.loading = true
    await this.send('Page.reload', {})
  }

  /**
   * Resize the emulated viewport to match the pane.
   *
   * @param viewport - page pixels.
   * @param devicePixelRatio - device pixel ratio to emulate; defaults to 1.
   */
  async setViewport(viewport: { width: number; height: number }, devicePixelRatio = 1): Promise<void> {
    if (viewport.width === this.viewport.width && viewport.height === this.viewport.height
      && devicePixelRatio === this.deviceScaleFactor) return
    this.viewport = viewport
    this.deviceScaleFactor = devicePixelRatio
    // Two resizes in flight would stop the screencast twice and start it once.
    this.viewportQueue = this.viewportQueue.then(async () => {
      if (this.closed) return
      await this.applyViewport(this.viewport, this.deviceScaleFactor)
      if (!this.active) return
      // The frame cap is fixed at start time; restart so it tracks the viewport.
      await this.stopStreaming()
      await this.startStreaming()
    }).catch((error: unknown) => {
      this.log.warn(`view ${this.sessionId}: viewport update failed`, error)
    })
    await this.viewportQueue
  }

  /** Dispatch one pointer event. */
  async mouse(event: {
    type: 'down' | 'up' | 'move'
    x: number
    y: number
    button: 0 | 1 | 2
    clickCount: number
    modifiers: number
  }): Promise<void> {
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
    const buttons = event.type === 'down' ? (event.button === 2 ? 2 : event.button === 1 ? 4 : 1) : 0
    await this.send('Input.dispatchMouseEvent', {
      type: event.type === 'down' ? 'mousePressed' : event.type === 'up' ? 'mouseReleased' : 'mouseMoved',
      x: event.x,
      y: event.y,
      button,
      buttons,
      clickCount: event.type === 'move' ? 0 : event.clickCount,
      modifiers: event.modifiers,
      pointerType: 'mouse',
    })
  }

  /** Dispatch one wheel event. */
  async wheel(event: { x: number; y: number; dx: number; dy: number }): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: event.x,
      y: event.y,
      deltaX: event.dx,
      deltaY: event.dy,
      modifiers: 0,
    })
  }

  /** Dispatch one key event. */
  async key(event: {
    type: 'down' | 'up'
    key: string
    code: string
    vk: number
    text?: string
    modifiers: number
  }): Promise<void> {
    const isText = event.type === 'down' && event.text !== undefined && event.text !== ''
    await this.send('Input.dispatchKeyEvent', {
      type: event.type === 'down' ? (isText ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.vk,
      nativeVirtualKeyCode: event.vk,
      ...(isText ? { text: event.text, unmodifiedText: event.text } : {}),
      modifiers: event.modifiers,
    })
  }

  /** Insert text without key events, which is how IME and paste must work. */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  /**
   * Read a bounded text snapshot of the page for the model.
   * @param maxChars - hard cap on returned length.
   * @returns the page's visible text and title.
   */
  async readText(maxChars: number): Promise<{ title: string; url: string; text: string; truncated: boolean }> {
    const result = await this.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => {
        const body = document.body
        const text = (body ? body.innerText : '') || ''
        return { title: document.title, url: location.href, text }
      })()`,
      returnByValue: true,
      awaitPromise: false,
    })
    const value = result.result?.value
    if (typeof value !== 'object' || value === null) return { title: this.title, url: this.url, text: '', truncated: false }
    const record = value as { title?: unknown; url?: unknown; text?: unknown }
    const text = typeof record.text === 'string' ? record.text.replace(/\n{3,}/g, '\n\n').trim() : ''
    return {
      title: typeof record.title === 'string' ? record.title : this.title,
      url: typeof record.url === 'string' ? record.url : this.url,
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars,
    }
  }

  /**
   * Capture the visible page as a PNG.
   * @returns PNG bytes.
   */
  async screenshot(): Promise<Buffer> {
    const result = await this.send<{ data?: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true })
    if (result.data === undefined) throw new Error('the page returned no screenshot data')
    return Buffer.from(result.data, 'base64')
  }

  /**
   * Run a click at a point or on a selector-resolved element.
   * @param selector - CSS selector to click.
   * @returns the element's description, useful in the model result.
   */
  async clickSelector(selector: string): Promise<{ text: string; url: string }> {
    const rect = await this.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || el.getAttribute('aria-label') || el.value || '').slice(0, 80) }
      })()`,
      returnByValue: true,
    })
    const value = rect.result?.value
    if (typeof value !== 'object' || value === null) throw new Error(`no element matches ${JSON.stringify(selector)}`)
    const point = value as { x?: unknown; y?: unknown; text?: unknown }
    const x = Math.round(Number(point.x ?? 0))
    const y = Math.round(Number(point.y ?? 0))
    await this.mouse({ type: 'move', x, y, button: 0, clickCount: 0, modifiers: 0 })
    await this.mouse({ type: 'down', x, y, button: 0, clickCount: 1, modifiers: 0 })
    await this.mouse({ type: 'up', x, y, button: 0, clickCount: 1, modifiers: 0 })
    return { text: typeof point.text === 'string' ? point.text : '', url: this.url }
  }

  /** Close the page target and release the screencast. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.stopStreaming().catch(() => {})
    this.disposeEvents?.()
    this.disposeEvents = undefined
    await this.options.connection.send('Target.closeTarget', { targetId: this.targetId }).catch((error: unknown) => {
      this.log.debug('closeTarget failed', error)
    })
    this.options.sink.onClosed(this, 'closed by request')
  }

  /** True after {@link close} or after the target disappeared. */
  get isClosed(): boolean { return this.closed }

  private async applyViewport(viewport: { width: number; height: number }, deviceScaleFactor: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    })
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`view ${this.sessionId} is closed`))
    return this.options.connection.send<T>(method, params, this.sessionId)
  }

  private handleEvent(event: CdpEvent): void {
    if (event.sessionId !== this.sessionId) return
    const params = event.params ?? {}
    switch (event.method) {
      case 'Page.screencastFrame': {
        if (!this.active) return
        const data = params.data
        const frameSession = params.sessionId
        const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined
        if (typeof data !== 'string') return
        const jpeg = Buffer.from(data, 'base64')
        this.frames++
        this.bytes += jpeg.length
        this.screencastSessionId = typeof frameSession === 'number' ? frameSession : undefined
        const width = metadata?.deviceWidth ?? this.viewport.width
        const height = metadata?.deviceHeight ?? this.viewport.height
        this.pendingFrameId = this.screencastSessionId
        this.options.sink.onFrame(this, {
          frameId: this.screencastSessionId ?? this.frames,
          jpeg,
          width,
          height,
        })
        break
      }
      case 'Page.frameNavigated': {
        const frame = params.frame as { url?: string; parentId?: string; name?: string } | undefined
        if (frame === undefined || frame.parentId !== undefined) return
        this.url = frame.url ?? this.url
        this.loading = true
        this.options.sink.onNavigation(this, { url: this.url, title: this.title, loading: true })
        break
      }
      case 'Page.loadEventFired': {
        this.loading = false
        void this.readText(0)
          .then(({ title, url }) => {
            this.title = title
            this.url = url
            this.options.sink.onNavigation(this, { url, title, loading: false })
          })
          .catch((error: unknown) => { this.log.debug('title read failed', error) })
        break
      }
      case 'Page.javascriptDialogOpening': {
        // A modal dialog blocks the target until answered; a mirror cannot show it.
        void this.send('Page.handleJavaScriptDialog', { accept: true }).catch((error: unknown) => {
          this.log.debug('dialog auto-accept failed', error)
        })
        break
      }
      case 'Target.targetDestroyed': {
        if (!this.closed) {
          this.closed = true
          this.active = false
          this.options.sink.onClosed(this, 'the page was closed')
        }
        break
      }
      default:
        break
    }
  }
}
