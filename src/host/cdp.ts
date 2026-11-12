/**
 * Minimal Chrome DevTools Protocol client.
 *
 * We keep this in-house instead of pulling Playwright into the plugin: the
 * bundle must stay small, and the control lease has to interleave with every
 * browser command — which a higher-level driver would hide from us.
 * @module dsh-browser/host/cdp
 */
import { WebSocket } from 'ws'

/** One CDP event message. */
export interface CdpEvent {
  readonly method: string
  readonly params?: Record<string, unknown>
  readonly sessionId?: string
}

/** Anything that can carry a CDP message; satisfied by `ws`'s WebSocket. */
export interface CdpTransport {
  send(data: string): void
  close(): void
  on(event: 'message', handler: (data: Buffer | string) => void): unknown
  on(event: 'close', handler: () => void): unknown
  on(event: 'error', handler: (error: Error) => void): unknown
}

/** A command failure reported by Chromium, not by us. */
export class CdpError extends Error {
  override readonly name = 'CdpError'
  readonly method: string

  constructor(method: string, message: string) {
    super(`${method}: ${message}`)
    this.method = method
  }
}

/** Connection closed under an in-flight command. */
export class CdpClosedError extends Error {
  override readonly name = 'CdpClosedError'

  constructor() {
    super('the browser connection closed')
  }
}

/**
 * One multiplexed connection to Chromium, with optional flattened sessions.
 *
 * A flattened session addresses a page target on the same socket, which is how
 * we drive several tabs of one browser without one socket each.
 */
export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private closeError: Error | undefined
  private closed = false
  private readonly transport: CdpTransport

  constructor(transport: CdpTransport) {
    this.transport = transport
    transport.on('message', (data) => { this.receive(typeof data === 'string' ? data : data.toString('utf8')) })
    transport.on('close', () => { this.failAll(new CdpClosedError()) })
    transport.on('error', (error) => { this.failAll(error) })
  }

  /** Whether the underlying socket is still usable. */
  get open(): boolean {
    return !this.closed
  }

  /**
   * Send one command.
   * @param method - CDP method name, for example `Page.navigate`.
   * @param params - method parameters.
   * @param sessionId - flattened session to address, or omitted for the browser target.
   * @returns the method's result object.
   */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpClosedError())
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.transport.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
    })
  }

  /**
   * Observe the connection ending.
   *
   * A browser can vanish under a live command — a crash, a closed window, an
   * external kill. Owners need to learn about that to reset their own state;
   * without it a session keeps reporting "ready" and every later command fails
   * against a dead socket.
   * @param listener - called once with the cause, immediately if already closed.
   * @returns an unsubscribe function.
   */
  onClose(listener: (error: Error) => void): () => void {
    if (this.closeError !== undefined) {
      listener(this.closeError)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /**
   * Observe every event on this connection, including session-scoped ones.
   * @param listener - called for each event message.
   * @returns an unsubscribe function.
   */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Close the socket; in-flight commands reject. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(new CdpClosedError())
    this.transport.close()
  }

  private receive(raw: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: any; error?: { message?: string; data?: string } }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) {
        entry.reject(new CdpError(entry.method, message.error.message ?? message.error.data ?? 'unknown error'))
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }
    if (message.method === undefined) return
    const event: CdpEvent = { method: message.method, params: message.params, sessionId: message.sessionId }
    for (const listener of this.listeners) listener(event)
  }

  private failAll(error: Error): void {
    if (this.closed && this.closeError !== undefined) return
    this.closed = true
    this.closeError = error
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) entry.reject(error)
    const closeListeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const listener of closeListeners) {
      try { listener(error) } catch { /* an observer must not break the others */ }
    }
  }
}

/**
 * Open a websocket and wrap it in a {@link CdpConnection}.
 * @param url - `ws://` debugging endpoint.
 * @param signal - aborts the connection attempt.
 * @returns the connected client.
 */
export async function connectCdp(url: string, signal?: AbortSignal): Promise<{ connection: CdpConnection; socket: WebSocket }> {
  const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false })
  const abort = (): void => { socket.close() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', (error) => { reject(error) })
      if (signal?.aborted === true) reject(new Error('aborted'))
    })
  } catch (error) {
    signal?.removeEventListener('abort', abort)
    throw error
  }
  signal?.removeEventListener('abort', abort)
  const connection = new CdpConnection({
    send: (data) => { socket.send(data) },
    close: () => { socket.close() },
    on: (event: any, handler: any) => socket.on(event, handler),
  })
  return { connection, socket }
}

/** Fetch the browser's own websocket URL from a debugging HTTP endpoint. */
export async function browserEndpoint(port: number, host = '127.0.0.1'): Promise<{ webSocketDebuggerUrl: string; browser: string }> {
  const response = await fetch(`http://${host}:${port}/json/version`)
  if (!response.ok) throw new Error(`CDP version endpoint answered ${response.status}`)
  const body = await response.json() as { webSocketDebuggerUrl?: string; Browser?: string }
  if (typeof body.webSocketDebuggerUrl !== 'string') throw new Error('CDP version endpoint returned no websocket URL')
  return { webSocketDebuggerUrl: body.webSocketDebuggerUrl, browser: body.Browser ?? 'unknown' }
}