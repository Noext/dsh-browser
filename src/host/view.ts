/**
 * One live browser view: a CDP page target, its screencast pump, and its input
 * channel.
 *
 * A view owns exactly one screencast. Chromium allows several, but a second
 * frame consumer on the same target doubles the encode cost and makes the ack
 * protocol ambiguous, so the session serialises viewers instead.
 * @module dsh-browser/host/view
 */
import { chromeUserAgent } from './launcher.ts'
import { existsSync } from 'node:fs'
import { resolveClickPoint } from './refs.ts'
import { snapshotPage, type Snapshot, type SnapshotOptions } from './snapshot.ts'
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
  /** Latest snapshot; a ref only means something against the tree it came from. */
  private lastSnapshot: Snapshot | undefined
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
    // Identity first: a view rebuilt by an external action must look the same.
    await this.applyChromeIdentity()
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
   * Read the page as a compact accessibility tree with a ref per element.
   *
   * The default way an agent should look at a page: a text tree is exact and
   * cheap, where a screenshot forces the model to guess coordinates.
   * @param options - filtering and size bounds.
   * @returns the tree and its ref table.
   */
  async snapshot(options?: SnapshotOptions): Promise<Snapshot> {
    const snapshot = await snapshotPage(this.options.connection, this.sessionId, options)
    this.lastSnapshot = snapshot
    return snapshot
  }

  /**
   * Click the element a snapshot ref names.
   *
   * A refused action throws with the reason, so a click that cannot land never
   * looks like success.
   * @param ref - ref such as `e12` from the latest snapshot.
   * @returns what was clicked.
   */
  async clickRef(ref: string): Promise<{ detail: string }> {
    const nodeId = this.lastSnapshot?.refs.get(ref)
    if (nodeId === undefined) throw new Error(`unknown ref "${ref}"; take a new browser_snapshot`)
    const target = await resolveClickPoint(this.options.connection, this.sessionId, nodeId)
    if ('refusal' in target) throw new Error(`cannot click ${ref}: ${target.detail}`)
    await this.mouse({ type: 'move', x: target.point.x, y: target.point.y, button: 0, clickCount: 0, modifiers: 0 })
    await this.mouse({ type: 'down', x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 })
    await this.mouse({ type: 'up', x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 })
    return { detail: target.detail === '' ? ref : `${target.detail} (${ref})` }
  }

  /**
   * Focus the element a snapshot ref names, so a following insert goes into it.
   * @param ref - ref such as `e12` from the latest snapshot.
   */
  async focusRef(ref: string): Promise<void> {
    const nodeId = this.lastSnapshot?.refs.get(ref)
    if (nodeId === undefined) throw new Error(`unknown ref "${ref}"; take a new browser_snapshot`)
    const target = await resolveClickPoint(this.options.connection, this.sessionId, nodeId)
    if ('refusal' in target) throw new Error(`cannot focus ${ref}: ${target.detail}`)
    await this.mouse({ type: 'move', x: target.point.x, y: target.point.y, button: 0, clickCount: 0, modifiers: 0 })
    await this.mouse({ type: 'down', x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 })
    await this.mouse({ type: 'up', x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 })
  }

  /**
   * Find elements by role and/or accessible name, anywhere on the page.
   *
   * A truncated snapshot cannot list the whole of a dense page, so this is how a
   * caller reaches an element past the cut without scrolling through it.
   * @param query - role and/or text to match, case-insensitively.
   * @returns matching elements with a ref each.
   */
  async find(query: { role?: string; name?: string; max?: number }): Promise<{
    matches: { role: string; name: string; ref: string }[]
    total: number
  }> {
    const limit = Math.max(1, Math.min(query.max ?? 20, 100))
    await this.options.connection.send('Accessibility.enable', {}, this.sessionId)
    const tree = await this.options.connection.send<{ nodes?: AxSnapNode[] }>(
      'Accessibility.getFullAXTree', {}, this.sessionId,
    )
    const nodes = tree.nodes ?? []
    const wantedRole = query.role?.toLowerCase()
    const wantedName = query.name?.toLowerCase()
    const matches: { role: string; name: string; ref: string }[] = []
    let total = 0
    for (const node of nodes) {
      if (node.ignored === true || node.backendDOMNodeId === undefined) continue
      const role = node.role?.value ?? ''
      const name = (node.name?.value ?? '').replace(/\s+/gu, ' ').trim()
      if (wantedRole !== undefined && role.toLowerCase() !== wantedRole) continue
      if (wantedName !== undefined && !name.toLowerCase().includes(wantedName)) continue
      if (wantedName === undefined && wantedRole === undefined) continue
      if (name === '' && wantedName !== undefined) continue
      total++
      if (matches.length >= limit) continue
      matches.push({ role, name: name.slice(0, 120), ref: `e${node.backendDOMNodeId}` })
    }
    // Refs from a find must stay usable, and a find must not invalidate refs the
    // previous snapshot handed out: both name the same page, so the tables merge.
    const refs = new Map(this.lastSnapshot?.refs ?? [])
    for (const match of matches) refs.set(match.ref, Number(match.ref.slice(1)))
    this.lastSnapshot = {
      text: this.lastSnapshot?.text ?? '',
      refs, url: this.url, title: this.title, nodeCount: matches.length,
      truncated: total > matches.length,
    }
    return { matches, total }
  }

  /**
   * Attach files to a file input.
   *
   * A file input cannot be filled by typing: the browser only accepts a path
   * through the file-system channel, and a page can then read the bytes as if a
   * person had picked them. The path is Host-local, which is what the deployer's
   * own filesystem already grants.
   * @param ref - ref of the input from a snapshot or a find.
   * @param files - absolute paths of existing files.
   * @returns what the input now reports, for the model to confirm.
   */
  async setFiles(ref: string, files: readonly string[]): Promise<{ names: string[] }> {
    const nodeId = this.lastSnapshot?.refs.get(ref)
    if (nodeId === undefined) throw new Error(`unknown ref "${ref}"; take a new browser_snapshot`)
    for (const file of files) {
      if (!existsSync(file)) throw new Error(`no such file: ${file}`)
    }
    await this.options.connection.send('DOM.enable', {}, this.sessionId)
    try {
      await this.options.connection.send('DOM.setFileInputFiles', { files: [...files], backendNodeId: nodeId }, this.sessionId)
    } catch (error) {
      throw new Error(`cannot attach files to ${ref}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const names = await this.options.connection.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => {
        const doc = document.activeElement
        const input = doc && doc.type === 'file' ? doc : document.querySelector('input[type=file]')
        return input == null ? [] : Array.from(input.files ?? []).map((f) => f.name)
      })()`,
      returnByValue: true,
    }, this.sessionId)
    const value = names.result?.value
    return { names: Array.isArray(value) ? value.map(String) : [] }
  }

  /**
   * Choose an option in a native select.
   *
   * A select is not a button: clicking it opens a popup the page cannot be
   * driven through reliably. Setting the value and firing the events the
   * framework listens to is what makes the form believe a person chose.
   * @param ref - ref of the select.
   * @param option - the visible label or the value to select.
   * @returns the option now selected.
   */
  async selectOption(ref: string, option: string): Promise<{ selected: string }> {
    const nodeId = this.lastSnapshot?.refs.get(ref)
    if (nodeId === undefined) throw new Error(`unknown ref "${ref}"; take a new browser_snapshot`)
    await this.options.connection.send('DOM.enable', {}, this.sessionId)
    const doc = await this.options.connection.send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode', { backendNodeId: nodeId }, this.sessionId,
    )
    const objectId = doc.object?.objectId
    if (objectId === undefined) throw new Error(`the ref "${ref}" no longer names an element`)
    const result = await this.options.connection.send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (wanted) {
        if (this.tagName !== 'SELECT') return { error: 'not a select (' + this.tagName + ')' }
        const options = Array.from(this.options)
        const match = options.find((o) => o.value === wanted) ?? options.find((o) => o.textContent.trim() === wanted)
        if (!match) return { error: 'no option named ' + wanted + '; available: ' + options.map((o) => o.textContent.trim()).join(', ') }
        this.value = match.value
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
        return { selected: match.textContent.trim() }
      }`,
      arguments: [{ value: option }],
      returnByValue: true,
    }, this.sessionId)
    const value = result.result?.value as { selected?: string; error?: string } | undefined
    if (value?.error !== undefined) throw new Error(value.error)
    return { selected: value?.selected ?? option }
  }

  /**
   * Set a checkbox or radio to an explicit state.
   *
   * Clicking is not the same thing: a click toggles, so a caller that cannot see
   * the current state flips it the wrong way half the time. This sets the state
   * the caller asked for and reports the result.
   * @param ref - ref of the checkbox or radio.
   * @param checked - the state to end in.
   * @returns the state after the change.
   */
  async setChecked(ref: string, checked: boolean): Promise<{ checked: boolean; label: string }> {
    const nodeId = this.lastSnapshot?.refs.get(ref)
    if (nodeId === undefined) throw new Error(`unknown ref "${ref}"; take a new browser_snapshot`)
    await this.options.connection.send('DOM.enable', {}, this.sessionId)
    const doc = await this.options.connection.send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode', { backendNodeId: nodeId }, this.sessionId,
    )
    const objectId = doc.object?.objectId
    if (objectId === undefined) throw new Error(`the ref "${ref}" no longer names an element`)
    const result = await this.options.connection.send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (wanted) {
        const type = this.type ?? this.tagName.toLowerCase()
        if (!['checkbox', 'radio', 'switch'].includes(type)) return { error: 'not a checkbox or radio (' + type + ')' }
        if (this.disabled) return { error: 'the control is disabled' }
        if (this.checked !== wanted) this.click()
        return { checked: this.checked, label: (this.getAttribute('aria-label') || this.value || '').slice(0, 60) }
      }`,
      arguments: [{ value: checked }],
      returnByValue: true,
    }, this.sessionId)
    const value = result.result?.value as { checked?: boolean; label?: string; error?: string } | undefined
    if (value?.error !== undefined) throw new Error(value.error)
    return { checked: value?.checked === true, label: value?.label ?? '' }
  }

  /**
   * Wait until the page settles or a condition holds.
   *
   * A navigation returns before the page is usable, so an agent that acts
   * immediately clicks a placeholder. This waits for the document to finish, and
   * optionally for an element or text to appear.
   * @param options - what to wait for, and how long.
   * @returns whether the condition was met before the deadline.
   */
  async waitFor(options: { selector?: string; text?: string; timeoutMs?: number }): Promise<{
    met: boolean
    waitedMs: number
    reason: string
  }> {
    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 10_000, 60_000))
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const check = await this.options.connection.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: `(() => {
          if (document.readyState !== 'complete') return { ready: false, detail: 'loading' }
          ${options.selector === undefined ? '' : `if (document.querySelector(${JSON.stringify(options.selector)}) === null) return { ready: false, detail: 'selector absent' }`}
          ${options.text === undefined ? '' : `if (!document.body || !document.body.innerText.includes(${JSON.stringify(options.text)})) return { ready: false, detail: 'text absent' }`}
          return { ready: true, detail: 'ready' }
        })()`,
        returnByValue: true,
      }, this.sessionId)
      const value = check.result?.value as { ready?: boolean; detail?: string } | undefined
      if (value?.ready === true) {
        return { met: true, waitedMs: Date.now() - started, reason: value.detail ?? 'ready' }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { met: false, waitedMs: Date.now() - started, reason: `timed out after ${timeoutMs} ms` }
  }

  /** The most recent snapshot, whose refs a later action resolves against. */
  get snapshotState(): Snapshot | undefined { return this.lastSnapshot }

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

  /**
   * Present this page as Google Chrome rather than plain Chromium.
   *
   * Sign-in providers read the User-Agent Client Hints, not only the UA string.
   * `--user-agent` leaves the hint branding as "Chromium", and Google answers
   * that with "this browser or app may not be secure". The CDP override is the
   * supported way to set the metadata those hints are derived from; it is scoped
   * to this target, so it survives navigation and is dropped with the page.
   */
  private async applyChromeIdentity(): Promise<void> {
    const version = process.versions.chrome ?? '156.0.0.0'
    const major = version.split('.')[0]
    await this.send('Emulation.setUserAgentOverride', {
      userAgent: chromeUserAgent(),
      acceptLanguage: 'en-US,en',
      platform: process.platform === 'darwin' ? 'MacIntel' : process.platform === 'win32' ? 'Win32' : 'Linux x86_64',
      userAgentMetadata: {
        brands: [
          { brand: 'Not:A-Brand', version: '8' },
          { brand: 'Chromium', version: major },
          { brand: 'Google Chrome', version: major },
        ],
        fullVersionList: [
          { brand: 'Not:A-Brand', version: '8.0.0.0' },
          { brand: 'Chromium', version },
          { brand: 'Google Chrome', version },
        ],
        fullVersion: version,
        platform: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
        platformVersion: '6.8.0',
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      },
    })
  }

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
/** The subset of an accessibility node that \`find\` reads. */
interface AxSnapNode {
  readonly ignored?: boolean
  readonly role?: { value?: string }
  readonly name?: { value?: string }
  readonly backendDOMNodeId?: number
}