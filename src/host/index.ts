/**
 * Host half of dsh-browser: one Chromium per Session, a screencast relay, the
 * Agent's browser tools, and the handover lease between the two.
 *
 * Transport choice: exact Fetch routes plus one websocket upgrade, not Typert
 * Remotes. Generated Remotes only exist for packages inside the DSH monorepo,
 * and a screencast is binary both ways, which the Remote stream format does not
 * carry. The websocket reuses Connection's browser-session authentication.
 * @module dsh-browser/host
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import { WebSocketServer, type WebSocket } from 'ws'
import { ControlMachine } from '../shared/control.ts'
import { FRAME_HEADER_BYTES, FRAME_MAGIC, ROUTE_PROFILE, ROUTE_STATUS, ROUTE_VIEWS, WS_PATH, normalizeAddress, type ClientFrame, type ServerFrame, type StatusPayload } from '../shared/protocol.ts'
import { discoverExecutable, LaunchError } from './launcher.ts'
import { registerTools } from './tools.ts'
import { BrowserSession } from './session.ts'
import { createProfiles } from './profiles.ts'
import type { Frame } from './view.ts'

/** Plugin configuration. */
export interface Config {
  /** Chromium executable; omission discovers Playwright's cache or a system browser. */
  executablePath?: string
  /** Run Chromium with a visible window; false uses the new headless mode. */
  headed: boolean
  /** Keep cookies and logins in `$DSH_HOME/browser-profiles`; false uses a temporary profile. */
  persistentProfile: boolean
  /** Viewport when a pane has no measurement yet. */
  width: number
  height: number
  /** JPEG quality of the mirror. */
  quality: number
  /** Concurrent browser sessions allowed on this Host. */
  maxSessions: number
  /** Idle time before a human takeover lapses; 0 never lapses. */
  humanIdleMs: number
  /** Close a browser nobody is watching after this long; 0 never closes it. */
  idleTimeoutMs: number
  /** What a new session opens first. */
  startUrl: string
  /** Extra Chromium switches. */
  chromiumArgs?: string[]
}

/** Validated plugin configuration. */
export const Config: Schema<Config> = Schema.object({
  executablePath: Schema.string().description('Chromium executable'),
  headed: Schema.boolean().default(true).description('Show the browser window on the Host display'),
  persistentProfile: Schema.boolean().default(true).description('Keep cookies and logins across restarts'),
  width: Schema.number().min(360).max(1920).default(1280).description('Browser viewport width'),
  height: Schema.number().min(300).max(1200).default(800).description('Browser viewport height'),
  quality: Schema.number().min(20).max(95).default(62).description('Mirror JPEG quality'),
  maxSessions: Schema.number().min(1).max(8).default(2).description('Concurrent browsers'),
  humanIdleMs: Schema.number().min(0).default(600000).description('Human takeover idle timeout'),
  idleTimeoutMs: Schema.number().min(0).default(300000).description('Close a browser with no viewer and no activity after this long; 0 keeps it open'),
  startUrl: Schema.string().default('about:blank').description('Address a new browser opens'),
  chromiumArgs: Schema.array(Schema.string()).description('Extra Chromium switches'),
})

/** Per-Agent state this plugin owns. */
interface Entry {
  readonly session: BrowserSession
  disposal: (() => void) | undefined
}

/** Host plugin. */
export function apply(ctx: Context, config: Config): void {
  const log = {
    debug: (message: string, error?: unknown) => { ctx.logger.debug(message, error) },
    info: (message: string) => { ctx.logger.info(message) },
    warn: (message: string, error?: unknown) => { ctx.logger.warn(message, error) },
    error: (message: string, error?: unknown) => { ctx.logger.error(message, error) },
  }
  const executablePath = config.executablePath ?? discoverExecutable()
  if (executablePath === undefined) {
    log.warn('no Chromium executable found; dsh-browser stays inert until one is configured')
  }
  const profiles = createProfiles({ persistent: config.persistentProfile })
  const entries = new Map<string, Entry>()
  const viewers = new Map<string, Set<WebSocket>>()

  const statusFor = (agentId: string): StatusPayload | undefined => {
    const entry = entries.get(agentId)
    if (entry === undefined) return undefined
    const snapshot = entry.session.snapshot()
    return {
      protocol: 1,
      state: snapshot.lease.state,
      holder: snapshot.lease.holder,
      leaseExpiresAt: snapshot.lease.expiresAt,
      views: snapshot.views,
      activeViewId: snapshot.activeViewId,
      viewport: snapshot.viewport,
      request: entry.session.pendingRequest,
      profile: config.persistentProfile ? 'persistent' : 'ephemeral',
      runs: { active: entries.size, max: config.maxSessions },
    }
  }

  const broadcast = (agentId: string, frame: ServerFrame): void => {
    const sockets = viewers.get(agentId)
    if (sockets === undefined) return
    const text = JSON.stringify(frame)
    for (const socket of sockets) if (socket.readyState === 1) socket.send(text)
  }

  const sessionFor = (agent: { id: string; workspace?: { cwd?: string } }, agentId: string): BrowserSession => {
    const existing = entries.get(agentId)
    if (existing !== undefined) return existing.session
    if (entries.size >= config.maxSessions) {
      throw new Error(`dsh-browser already runs ${entries.size} browsers; close one before opening another (limit: ${config.maxSessions})`)
    }
    if (executablePath === undefined) {
      throw new Error('no Chromium executable is available: set dsh-browser executablePath, or set DSH_BROWSER_EXECUTABLE, or run "npx playwright install chromium"')
    }
    const profileRoot = profiles.directoryFor(agent)
    const session = new BrowserSession({
      log,
      executablePath,
      profileRoot,
      profileKind: config.persistentProfile ? 'persistent' : 'ephemeral',
      headed: config.headed,
      viewport: { width: config.width, height: config.height },
      quality: config.quality,
      startTimeoutMs: 20_000,
      humanIdleMs: config.humanIdleMs,
      idleTimeoutMs: config.idleTimeoutMs,
      initialUrl: normalizeAddress(config.startUrl) ?? 'about:blank',
      sink: {
        onFrame(_session, view, frame: Frame) {
          const sockets = viewers.get(agentId)
          if (sockets === undefined || sockets.size === 0) return
          const header = Buffer.alloc(FRAME_HEADER_BYTES)
          header.writeUInt8(FRAME_MAGIC, 0)
          header.writeUInt32BE(frame.frameId >>> 0, 1)
          const payload = Buffer.concat([header, frame.jpeg])
          for (const socket of sockets) if (socket.readyState === 1) socket.send(payload, { binary: true })
          void view
        },
        onViews(owner) {
          const snapshot = owner.snapshot()
          broadcast(agentId, { t: 'views', views: snapshot.views, activeViewId: snapshot.activeViewId })
        },
        onLease(_owner, transition) {
          broadcast(agentId, {
            t: 'state',
            state: transition.after.state,
            holder: transition.after.holder,
            leaseExpiresAt: transition.after.expiresAt,
          })
        },
        onError(_owner, error) {
          broadcast(agentId, { t: 'error', code: 'browser/error', message: error.message })
        },
      },
    })
    entries.set(agentId, { session, disposal: undefined })
    // A failed browser must not stay cached: the next attach retries from scratch
    // instead of answering with a disposed session forever.
    void session.ensureStarted().catch(() => {
      const current = entries.get(agentId)
      if (current?.session === session) entries.delete(agentId)
    })
    return session
  }

  /** Look up the calling Agent's session, or fail with an actionable message. */
  const requireSession = (agentId: string): BrowserSession => {
    const entry = entries.get(agentId)
    if (entry === undefined) throw new Error('no browser is open for this Session; open one from the sidebar, or call browser_open')
    return entry.session
  }

  // ---- Agent tools ----
  ctx.inject(['tools'], (toolCtx) => registerTools(toolCtx, {
    log,
    config,
    getSession: (agent) => sessionFor(agent, agent.id),
    requireSession: (agentId) => requireSession(agentId),
    executableAvailable: () => executablePath !== undefined,
  }))

  // ---- A human takeover denies browser tools monotonically ----
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => toolsCtx.tools.guard((exec) => {
      if (!exec.name.startsWith('browser_')) return undefined
      const agent = exec.agent
      if (agent === undefined) return undefined
      const entry = entries.get(agent.id)
      if (entry === undefined) return undefined
      if (entry.session.allowsAgent) return undefined
      return 'a human is controlling the side-panel browser; wait for them to hand it back'
    }), 'dsh-browser: control guard')
  })

  // ---- Host shutdown must not orphan browsers ----
  // A Chromium left running after the Host exits shows up as a stray window the
  // user has to close by hand, and holds the profile lock for the next launch.
  ctx.effect(() => () => {
    for (const entry of entries.values()) void entry.session.dispose('the Host shut down')
  }, 'dsh-browser: shutdown cleanup')

  // ---- Agent disposal tears its browser down ----
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = entries.get(agent.id)
    if (entry === undefined) return
    entries.delete(agent.id)
    viewers.delete(agent.id)
    void entry.session.dispose('the Session was disposed')
  })

  // ---- HTTP status and views ----
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    connectionCtx.effect(() => connection.fetch.register({
      path: ROUTE_STATUS,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const agentId = new URL(request.url).searchParams.get('agentId') ?? ''
        const status = statusFor(agentId)
        if (status === undefined) return Response.json({ protocol: 1, state: 'idle', views: [], runs: { active: 0, max: config.maxSessions } })
        return Response.json(status)
      },
    }), 'dsh-browser: status route')
    connectionCtx.effect(() => connection.fetch.register({
      path: ROUTE_VIEWS,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const agentId = new URL(request.url).searchParams.get('agentId') ?? ''
        const status = statusFor(agentId)
        return Response.json({ views: status?.views ?? [], activeViewId: status?.activeViewId })
      },
    }), 'dsh-browser: views route')
    connectionCtx.effect(() => connection.fetch.register({
      path: ROUTE_PROFILE,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await request.json().catch(() => ({})) as { agentId?: string; action?: string }
        if (body.agentId === undefined || body.action !== 'clear') return new Response('bad request', { status: 400 })
        const entry = entries.get(body.agentId)
        if (entry !== undefined) {
          entries.delete(body.agentId)
          await entry.session.dispose('profile cleared')
        }
        await profiles.clear(body.agentId)
        return Response.json({ cleared: true })
      },
    }), 'dsh-browser: profile route')
  })

  // ---- The screencast and input websocket ----
  ctx.inject(['webServer', 'connection', 'agents'], (webCtx) => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
    webCtx.effect(() => webCtx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: (req, socket, head) => {
        const rejection = webCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          socket.end(`HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const url = new URL(req.url ?? '/', 'http://dsh.invalid')
          const agentId = url.searchParams.get('agentId') ?? ''
          void handleViewer(ws, agentId)
        })
      },
    }), 'dsh-browser: screencast upgrade')

    const handleViewer = async (ws: WebSocket, agentId: string): Promise<void> => {
      if (agentId === '') { ws.close(4400, 'agentId is required'); return }
      const agent = webCtx.agents.get(agentId as never)
      if (agent === undefined) { ws.close(4404, 'unknown Session'); return }
      let session: BrowserSession
      try {
        session = sessionFor(agent, agentId)
        await session.attachViewer()
      } catch (error) {
        ws.send(JSON.stringify({ t: 'error', code: 'browser/start', message: describe(error) } satisfies ServerFrame))
        ws.close()
        return
      }
      const sockets = viewers.get(agentId) ?? new Set<WebSocket>()
      viewers.set(agentId, sockets)
      sockets.add(ws)
      const snapshot = session.snapshot()
      ws.send(JSON.stringify({
        t: 'ready',
        proto: 1,
        state: snapshot.lease.state,
        views: snapshot.views,
        activeViewId: snapshot.activeViewId,
        viewport: snapshot.viewport,
      } satisfies ServerFrame))

      ws.on('close', () => {
        sockets.delete(ws)
        if (sockets.size === 0) {
          viewers.delete(agentId)
          session.detachViewer()
        }
      })
      ws.on('error', (error) => { log.debug('viewer socket error', error) })
      ws.on('message', async (raw) => {
        let frame: ClientFrame
        try {
          frame = JSON.parse(raw.toString()) as ClientFrame
        } catch {
          return
        }
        try {
          await handleClientFrame(session, ws, frame)
        } catch (error) {
          ws.send(JSON.stringify({ t: 'error', code: 'browser/failed', message: describe(error) } satisfies ServerFrame))
        }
      })
    }

    const handleClientFrame = async (session: BrowserSession, ws: WebSocket, frame: ClientFrame): Promise<void> => {
      const view = session.activeView
      switch (frame.t) {
        case 'hello':
          if (frame.proto !== 1) ws.close(4400, 'protocol mismatch')
          break
        case 'ack':
          view?.ackFrame(frame.frameId)
          break
        case 'resize': {
          await session.resize({ width: frame.cssWidth, height: frame.cssHeight }, frame.devicePixelRatio ?? 1)
          const viewport = session.snapshot().viewport
          ws.send(JSON.stringify({ t: 'viewport', width: viewport.width, height: viewport.height } satisfies ServerFrame))
          break
        }
        case 'navigate': {
          const url = normalizeAddress(frame.url)
          if (url === undefined) {
            ws.send(JSON.stringify({ t: 'error', code: 'address/rejected', message: 'only http and https addresses are supported' } satisfies ServerFrame))
            return
          }
          await view?.navigate(url)
          break
        }
        case 'back': await view?.back(); break
        case 'forward': await view?.forward(); break
        case 'reload': await view?.reload(); break
        case 'control':
          if (frame.action === 'take') await session.claimHuman()
          else session.releaseToAgent()
          break
        case 'human-done':
          // "Done" always hands control back, whether or not the Agent had asked
          // for help; finishing only the request would leave the human holding
          // the lease forever.
          session.finishHumanRequest('released')
          session.releaseToAgent()
          break
        case 'view':
          if (frame.action === 'create') await session.createView('about:blank')
          else if (frame.action === 'close' && frame.viewId !== undefined) await session.closeView(frame.viewId)
          else if (frame.action === 'select' && frame.viewId !== undefined) await session.selectView(frame.viewId)
          break
        case 'mouse':
        case 'wheel':
        case 'key':
        case 'text': {
          if (!session.allowsHuman) {
            ws.send(JSON.stringify({ t: 'error', code: 'control/denied', message: 'the Agent holds the browser; take control first' } satisfies ServerFrame))
            return
          }
          session.touchHuman()
          if (frame.t === 'mouse') await view?.mouse(frame)
          else if (frame.t === 'wheel') await view?.wheel(frame)
          else if (frame.t === 'key') await view?.key(frame)
          else await view?.insertText(frame.text)
          break
        }
        default:
          break
      }
    }

    const agentIdOf = (session: BrowserSession): string => {
      for (const [id, entry] of entries) if (entry.session === session) return id
      return ''
    }
  })
}

/** Turn a thrown value into a message a user can act on. */
function describe(error: unknown): string {
  if (error instanceof LaunchError) return `${error.message} — ${error.hint}`
  if (error instanceof Error) return error.message
  return String(error)
}
