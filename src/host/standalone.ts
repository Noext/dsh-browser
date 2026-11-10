/**
 * Standalone host for the plugin's own smoke test: no Cordis, no DSH.
 *
 * It exercises exactly the classes the plugin uses (session → view → CDP) and
 * serves the same websocket protocol the sidebar tab speaks, so the browser can
 * be driven without booting a profile.
 *
 * Usage: node --experimental-strip-types src/host/standalone.ts [url]
 */
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { BrowserSession } from './session.ts'
import { consoleLog } from './log.ts'
import { discoverExecutable } from './launcher.ts'
import { normalizeAddress, FRAME_HEADER_BYTES, FRAME_MAGIC } from '../shared/protocol.ts'
import type { ClientFrame, ServerFrame } from '../shared/protocol.ts'
import type { Frame } from './view.ts'

const initialUrl = normalizeAddress(process.argv[2] ?? 'https://example.com') ?? 'https://example.com'
const executablePath = discoverExecutable()
if (executablePath === undefined) throw new Error('no Chromium executable found')

const viewers = new Set<import('ws').WebSocket>()

const session = new BrowserSession({
  log: consoleLog,
  executablePath,
  profileRoot: join(process.cwd(), '.dsh-browser-profile'),
  profileKind: 'persistent',
  headed: true,
  viewport: { width: 1280, height: 800 },
  quality: 62,
  startTimeoutMs: 20_000,
  humanIdleMs: 10 * 60 * 1000,
  idleTimeoutMs: 5 * 60 * 1000,
  initialUrl,
  sink: {
    onFrame(_session, _view, frame: Frame) {
      const header = Buffer.alloc(FRAME_HEADER_BYTES)
      header.writeUInt8(FRAME_MAGIC, 0)
      header.writeUInt32BE(frame.frameId >>> 0, 1)
      const payload = Buffer.concat([header, frame.jpeg])
      for (const viewer of viewers) {
        if (viewer.readyState === 1) viewer.send(payload, { binary: true })
      }
    },
    onViews(owner) {
      const snapshot = owner.snapshot()
      const frame: ServerFrame = {
        t: 'views',
        views: snapshot.views,
        activeViewId: snapshot.activeViewId,
      }
      broadcast(frame)
    },
    onLease(owner, transition) {
      broadcast({
        t: 'state',
        state: transition.after.state,
        holder: transition.after.holder,
        leaseExpiresAt: transition.after.expiresAt,
      })
    },
    onError(_owner, error) {
      broadcast({ t: 'error', code: 'browser/error', message: error.message })
    },
  },
})

function broadcast(frame: ServerFrame): void {
  const text = JSON.stringify(frame)
  for (const viewer of viewers) {
    if (viewer.readyState === 1) viewer.send(text)
  }
}

const server = createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(session.snapshot()))
    return
  }
  res.writeHead(404).end()
})
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req) })
})

wss.on('connection', async (ws) => {
  const view = session.activeView
  if (view === undefined) {
    try {
      await session.attachViewer()
    } catch (error) {
      ws.send(JSON.stringify({ t: 'error', code: 'browser/start', message: String(error) }))
      ws.close()
      return
    }
  }
  viewers.add(ws)
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
    viewers.delete(ws)
    session.detachViewer()
  })
  ws.on('message', async (raw) => {
    let frame: ClientFrame
    try {
      frame = JSON.parse(raw.toString()) as ClientFrame
    } catch {
      return
    }
    const current = session.activeView
    try {
      switch (frame.t) {
        case 'ack':
          current?.ackFrame(frame.frameId)
          break
        case 'navigate': {
          const url = normalizeAddress(frame.url)
          if (url === undefined) { ws.send(JSON.stringify({ t: 'error', code: 'address/rejected', message: 'only http(s) addresses are allowed' })); return }
          await current?.navigate(url)
          break
        }
        case 'back': await current?.back(); break
        case 'forward': await current?.forward(); break
        case 'reload': await current?.reload(); break
        case 'resize': await session.resize({ width: frame.cssWidth, height: frame.cssHeight }); break
        case 'control':
          if (frame.action === 'take') await session.claimHuman()
          else session.releaseToAgent()
          break
        case 'mouse':
        case 'wheel':
        case 'key':
        case 'text': {
          if (!session.allowsHuman) {
            broadcast({ t: 'error', code: 'control/denied', message: 'the agent holds the browser' })
            return
          }
          session.touchHuman()
          if (frame.t === 'mouse') await current?.mouse(frame)
          else if (frame.t === 'wheel') await current?.wheel(frame)
          else if (frame.t === 'key') await current?.key(frame)
          else await current?.insertText(frame.text)
          break
        }
        default:
          break
      }
    } catch (error) {
      broadcast({ t: 'error', code: 'browser/failed', message: error instanceof Error ? error.message : String(error) })
    }
  })
})

const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => {
  resolve((server.address() as import('node:net').AddressInfo).port)
}))
console.log(`[standalone] ws://127.0.0.1:${port}/ws  status http://127.0.0.1:${port}/status`)

const shutdown = async (): Promise<void> => {
  await session.dispose('standalone shutdown')
  server.close()
  void createNetServer
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
