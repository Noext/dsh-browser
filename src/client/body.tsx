/**
 * The browser tab body: toolbar, canvas mirror, and the control handover.
 *
 * The component owns one websocket per tab. It never renders page HTML, so a
 * visited site cannot reach DSH's DOM — which is exactly why this is a
 * screencast and not an iframe.
 * @module dsh-browser/body
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { FRAME_HEADER_BYTES, FRAME_MAGIC, WS_PATH, normalizeAddress } from '../shared/protocol.ts'
import type { ClientFrame, ControlState, ServerFrame, ViewSummary } from '../shared/protocol.ts'
import { modifiersOf, toPageDelta, toPagePoint, viewportFor } from '../shared/geometry.ts'
import { copy } from './copy.ts'
import { STYLE_ID, STYLE_TEXT } from './style.ts'

/** Owner props supplied by the Keyed Slot framework. */
export type BrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>

/** One line of scrolling status under the toolbar. */
interface Status {
  readonly fps: number
  readonly width: number
  readonly height: number
}

/** Physical key codes Chromium needs beyond the printable ranges. */
const VK: Record<string, number> = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
}

/** Windows virtual key code for one DOM key event. */
function vkOf(event: KeyboardEvent): number {
  const named = VK[event.key]
  if (named !== undefined) return named
  if (event.key.length === 1) return event.key.toUpperCase().charCodeAt(0)
  return event.keyCode
}

/**
 * Inject the plugin stylesheet once per document.
 *
 * The out-of-tree client bundle has no stylesheet pipeline, so the CSS ships as
 * a string and is attached on first render.
 */
function usePluginStyle(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const tag = document.createElement('style')
    tag.id = STYLE_ID
    tag.textContent = STYLE_TEXT
    document.head.appendChild(tag)
  }, [])
}

/** Render the browser tab. */
export function BrowserBody(props: BrowserBodyProps): React.ReactElement {
  const { useTabInfo, sessionId } = props
  const tabInfo = useTabInfo()
  usePluginStyle()

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const viewportRef = useRef({ width: 1280, height: 800 })
  const resizeRef = useRef<() => void>(() => {})
  const [address, setAddress] = useState('')
  const [title, setTitle] = useState('')
  const [views, setViews] = useState<readonly ViewSummary[]>([])
  const [activeViewId, setActiveViewId] = useState<string | undefined>(undefined)
  const [control, setControl] = useState<ControlState>('idle')
  const [request, setRequest] = useState<{ reason: string } | undefined>(undefined)
  const [status, setStatus] = useState<Status>({ fps: 0, width: 1280, height: 800 })
  const [connection, setConnection] = useState<'connecting' | 'open' | 'lost'>('connecting')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  // ---- websocket lifecycle, including reconnect ----
  useEffect(() => {
    let disposed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let frames = 0
    let windowStart = performance.now()
    let bitmapQueue = Promise.resolve()

    const draw = (blob: Blob): void => {
      // Serialize bitmap decoding: two decodes racing on one canvas tear frames.
      bitmapQueue = bitmapQueue.then(async () => {
        const canvas = canvasRef.current
        if (canvas === null || disposed) return
        const bitmap = await createImageBitmap(blob)
        try {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        } finally {
          bitmap.close()
        }
        frames++
        const now = performance.now()
        if (now - windowStart >= 1000) {
          const fps = Math.round((frames * 1000) / (now - windowStart))
          frames = 0
          windowStart = now
          // A static page produces no frames at all; showing "0 fps" would read
          // as a broken connection, so the counter only appears when it counts.
          setStatus((previous) => (previous.fps === fps ? previous : { ...previous, fps }))
        }
      }).catch(() => {})
    }

    const connect = (): void => {
      if (disposed) return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${protocol}//${location.host}${WS_PATH}?agentId=${encodeURIComponent(sessionId)}`
      const socket = new WebSocket(url)
      socketRef.current = socket
      socket.binaryType = 'arraybuffer'
      setConnection('connecting')

      socket.onopen = () => {
        retry = 0
        setConnection('open')
        setFailure(undefined)
        socket.send(JSON.stringify({ t: 'hello', proto: 1 } satisfies ClientFrame))
        // The pane was measured before this socket existed, so its size was
        // never delivered; re-send it now that the channel is open.
        lastSent = { width: 0, height: 0 }
        fit()
      }
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const frame = JSON.parse(event.data) as ServerFrame
          applyServerFrame(frame)
          return
        }
        const buffer = event.data as ArrayBuffer
        const view = new DataView(buffer)
        if (view.getUint8(0) !== FRAME_MAGIC) return
        const frameId = view.getUint32(1)
        draw(new Blob([new Uint8Array(buffer, FRAME_HEADER_BYTES)], { type: 'image/jpeg' }))
        socket.send(JSON.stringify({ t: 'ack', frameId } satisfies ClientFrame))
      }
      socket.onclose = () => {
        if (disposed) return
        setConnection('lost')
        retry++
        timer = setTimeout(connect, Math.min(8000, 500 * retry))
      }
      socket.onerror = () => { socket.close() }
    }

    const applyServerFrame = (frame: ServerFrame): void => {
      switch (frame.t) {
        case 'ready':
          setControl(frame.state)
          setViews(frame.views)
          setActiveViewId(frame.activeViewId)
          if (lastSent.width === 0) viewportRef.current = frame.viewport
          queueMicrotask(() => { resizeRef.current() })
          break
        case 'views':
          setViews(frame.views)
          setActiveViewId(frame.activeViewId)
          break
        case 'nav':
          setAddress(frame.url)
          setTitle(frame.title)
          setLoading(frame.loading)
          break
        case 'state':
          setControl(frame.state)
          if (frame.state !== 'human') setRequest(undefined)
          break
        case 'request':
          setRequest({ reason: frame.reason })
          break
        case 'request-done':
          setRequest(undefined)
          break
        case 'viewport':
          // The Host confirms the size now in force; adopt it so the footer and the
          // canvas agree even if the pane changed while the socket was down.
          if (frame.width !== viewportRef.current.width || frame.height !== viewportRef.current.height) {
            viewportRef.current = { width: frame.width, height: frame.height }
            lastSent = { width: frame.width, height: frame.height }
            queueMicrotask(() => { resizeRef.current() })
          }
          break
        case 'error':
          setFailure(frame.message)
          break
        default:
          break
      }
    }

    /**
     * Match the page's viewport to the pane, and the canvas to the viewport.
     *
     * The page is emulated at the pane's own CSS size (at least a usable
     * minimum), so the mirror is 1:1 and nothing is letterboxed. Below the
     * minimum the canvas is scaled down instead, because a 300px-wide site is
     * unusable for both parties.
     */
    let lastSent = { width: 0, height: 0 }
    const send = (frame: ClientFrame): void => {
      const socket = socketRef.current
      if (socket?.readyState === 1) socket.send(JSON.stringify(frame))
    }

    /** Small pane wobbles must not restart the screencast; only real resizes do. */
    const RESIZE_THRESHOLD = 8
    const fit = (): void => {
      const canvas = canvasRef.current
      const stage = canvas?.parentElement
      if (canvas === null || stage === null || stage === undefined) return
      const box = stage.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return
      const viewport = viewportFor({ width: box.width, height: box.height }, viewportRef.current)
      // Paint at the emulated size; the stage centers it, so no letterbox math.
      canvas.style.width = `${Math.round(viewport.width)}px`
      canvas.style.height = `${Math.round(viewport.height)}px`
      setStatus((previous) => (previous.width === viewport.width && previous.height === viewport.height
        ? previous
        : { ...previous, width: viewport.width, height: viewport.height }))
      if (Math.abs(viewport.width - lastSent.width) < RESIZE_THRESHOLD
        && Math.abs(viewport.height - lastSent.height) < RESIZE_THRESHOLD) return
      viewportRef.current = viewport
      lastSent = viewport
      send({
        t: 'resize',
        cssWidth: viewport.width,
        cssHeight: viewport.height,
        devicePixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
      })
    }

    resizeRef.current = fit
    const observer = new ResizeObserver(() => { fit() })
    const stage = canvasRef.current?.parentElement
    if (stage !== null && stage !== undefined) observer.observe(stage)
    fit()

    connect()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [sessionId])

  const send = useCallback((frame: ClientFrame): void => {
    const socket = socketRef.current
    if (socket?.readyState === 1) socket.send(JSON.stringify(frame))
  }, [])

  // ---- input: every handler refuses while the Agent drives ----
  const acceptsInput = control === 'human'

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    return toPagePoint(
      { x: event.clientX, y: event.clientY },
      canvas.getBoundingClientRect(),
      viewportRef.current,
    )
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.focus()
    if (!acceptsInput) return
    const mapped = point(event)
    if (mapped === undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const button = event.button === 2 ? 2 : event.button === 1 ? 1 : 0
    send({ t: 'mouse', type: 'down', ...mapped, button: button as 0 | 1 | 2, clickCount: 1, modifiers: modifiersOf(event) })
  }

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!acceptsInput) return
    const mapped = point(event)
    if (mapped === undefined) return
    const button = event.button === 2 ? 2 : event.button === 1 ? 1 : 0
    send({ t: 'mouse', type: 'up', ...mapped, button: button as 0 | 1 | 2, clickCount: 1, modifiers: modifiersOf(event) })
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!acceptsInput) return
    const mapped = point(event)
    if (mapped === undefined) return
    send({ t: 'mouse', type: 'move', ...mapped, button: 0, clickCount: 0, modifiers: modifiersOf(event) })
  }

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!acceptsInput) return
    const mapped = toPagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), viewportRef.current)
    if (mapped === undefined) return
    const rect = event.currentTarget.getBoundingClientRect()
    send({
      t: 'wheel',
      ...mapped,
      dx: Math.round(toPageDelta(-event.deltaX, viewportRef.current, rect)),
      dy: Math.round(toPageDelta(-event.deltaY, viewportRef.current, rect)),
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>): void => {
    if (!acceptsInput) return
    const printable = event.key.length === 1
    send({
      t: 'key',
      type: 'down',
      key: event.key,
      code: event.code,
      vk: vkOf(event.nativeEvent),
      ...(printable && !event.ctrlKey && !event.metaKey ? { text: event.key } : {}),
      modifiers: modifiersOf(event),
    })
    // Keep the page's own scroll and focus semantics: DSH shortcuts must not fire here.
    if ([' ', 'Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(event.key)) {
      event.preventDefault()
    }
  }

  const onKeyUp = (event: React.KeyboardEvent<HTMLCanvasElement>): void => {
    if (!acceptsInput) return
    send({ t: 'key', type: 'up', key: event.key, code: event.code, vk: vkOf(event.nativeEvent), modifiers: modifiersOf(event) })
  }

  const onPaste = (event: React.ClipboardEvent<HTMLCanvasElement>): void => {
    if (!acceptsInput) return
    const text = event.clipboardData.getData('text')
    if (text === '') return
    event.preventDefault()
    send({ t: 'text', text })
  }

  const submitAddress = (): void => {
    const url = normalizeAddress(address)
    if (url === undefined) { setFailure('only http and https addresses are supported'); return }
    send({ t: 'navigate', url })
  }

  const controlLabel = useMemo(() => {
    if (control === 'human') return copy['control.human']
    if (control === 'agent') return copy['control.agent']
    return copy['control.idle']
  }, [control])

  return (
    <div className="dsh-browser-root">
      <div className="dsh-browser-bar">
        <button type="button" title={copy['toolbar.back']} onClick={() => send({ t: 'back' })}>←</button>
        <button type="button" title={copy['toolbar.forward']} onClick={() => send({ t: 'forward' })}>→</button>
        <button type="button" title={copy['toolbar.reload']} onClick={() => send({ t: 'reload' })}>{loading ? '×' : '⟳'}</button>
        <input
          className="dsh-browser-address"
          value={address}
          spellCheck={false}
          aria-label={copy['toolbar.address']}
          placeholder="https://…"
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submitAddress() }}
        />
        <span className={`dsh-browser-badge dsh-browser-badge--${control}`}>{controlLabel}</span>
        {control === 'human'
          ? <button type="button" className="dsh-browser-action" onClick={() => { setRequest(undefined); send({ t: 'human-done' }) }}>{copy['control.done']}</button>
          : <button type="button" className="dsh-browser-action" onClick={() => send({ t: 'control', action: 'take' })}>{copy['control.take']}</button>}
      </div>

      {request !== undefined && (
        <div className="dsh-browser-request" role="status">
          <strong>{copy['request.title']}</strong>
          <span>{request.reason}</span>
        </div>
      )}
      {failure !== undefined && <div className="dsh-browser-notice" role="alert">{failure}</div>}
      {connection !== 'open' && (
        <div className="dsh-browser-notice">{connection === 'connecting' ? copy['state.connecting'] : copy['state.reconnecting']}</div>
      )}

      <div className="dsh-browser-stage">
        <canvas
          ref={canvasRef}
          className="dsh-browser-canvas"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
          onContextMenu={(event) => { event.preventDefault() }}
        />
      </div>

      <div className="dsh-browser-status">
        <span className="dsh-browser-status-title">{title || address}</span>
        <span>{status.fps > 0 ? `${status.fps} fps · ` : ''}{status.width}×{status.height}</span>
        {views.length > 1 && <span>{views.length} tabs{activeViewId === undefined ? '' : ''}</span>}
      </div>
    </div>
  )
}
