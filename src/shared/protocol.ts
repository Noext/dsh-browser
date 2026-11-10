/**
 * Wire protocol shared by the plugin's Host and Client halves.
 *
 * Nothing here may import a DSH runtime value: the Client bundle is built from
 * these same files, so this module must stay plain JSON-shaped types.
 * @module dsh-browser/protocol
 */

/** Protocol revision; a Client that disagrees must refuse to attach. */
export const PROTOCOL_VERSION = 1

/** Exact HTTP routes the Host owns below the API channel. */
export const ROUTE_STATUS = '/api/dsh-browser/status'
export const ROUTE_VIEWS = '/api/dsh-browser/views'
export const ROUTE_PROFILE = '/api/dsh-browser/profile'
export const WS_PATH = '/api/dsh-browser/ws'

/** Who is driving the browser right now. */
export type ControlState = 'idle' | 'agent' | 'human'

/** One browser view (tab) as the Client sees it. */
export interface ViewSummary {
  readonly viewId: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
}

/** The Host's answer to a status poll. */
export interface StatusPayload {
  readonly protocol: number
  readonly state: ControlState
  readonly holder: 'agent' | 'human' | undefined
  readonly leaseExpiresAt: number | undefined
  readonly views: readonly ViewSummary[]
  readonly activeViewId: string | undefined
  readonly viewport: { readonly width: number; readonly height: number }
  /** Present while the Agent is waiting for a human action. */
  readonly request: { readonly reason: string; readonly startedAt: number } | undefined
  readonly profile: 'persistent' | 'ephemeral'
  readonly runs: { readonly active: number; readonly max: number }
}

/** Client to Host frames. */
export type ClientFrame =
  | { readonly t: 'hello'; readonly proto: number }
  | { readonly t: 'ack'; readonly frameId: number }
  | {
    readonly t: 'mouse'
    readonly type: 'down' | 'up' | 'move'
    readonly x: number
    readonly y: number
    readonly button: 0 | 1 | 2
    readonly clickCount: number
    readonly modifiers: number
  }
  | { readonly t: 'wheel'; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
  | {
    readonly t: 'key'
    readonly type: 'down' | 'up'
    readonly key: string
    readonly code: string
    readonly vk: number
    readonly text?: string
    readonly modifiers: number
  }
  | { readonly t: 'text'; readonly text: string }
  | { readonly t: 'resize'; readonly cssWidth: number; readonly cssHeight: number; readonly devicePixelRatio?: number }
  | { readonly t: 'navigate'; readonly url: string }
  | { readonly t: 'back' }
  | { readonly t: 'forward' }
  | { readonly t: 'reload' }
  | { readonly t: 'control'; readonly action: 'take' | 'release' }
  | { readonly t: 'human-done' }
  | { readonly t: 'view'; readonly action: 'select' | 'create' | 'close'; readonly viewId?: string }

/** Host to Client frames (text frames; binary frames carry screencast JPEGs). */
export type ServerFrame =
  | {
    readonly t: 'ready'
    readonly proto: number
    readonly state: ControlState
    readonly views: readonly ViewSummary[]
    readonly activeViewId: string | undefined
    readonly viewport: { readonly width: number; readonly height: number }
  }
  | {
    readonly t: 'views'
    readonly views: readonly ViewSummary[]
    readonly activeViewId: string | undefined
  }
  | { readonly t: 'nav'; readonly viewId: string; readonly url: string; readonly title: string; readonly loading: boolean }
  | { readonly t: 'state'; readonly state: ControlState; readonly holder: 'agent' | 'human' | undefined; readonly leaseExpiresAt: number | undefined }
  | { readonly t: 'request'; readonly reason: string; readonly startedAt: number }
  | { readonly t: 'request-done'; readonly outcome: 'released' | 'cancelled' }
  | { readonly t: 'viewport'; readonly width: number; readonly height: number }
  | { readonly t: 'error'; readonly code: string; readonly message: string }

/** Binary frame layout: [0x01][frameId uint32 BE][JPEG bytes]. */
export const FRAME_MAGIC = 0x01
export const FRAME_HEADER_BYTES = 5

/** Whether an HTTP(S) address is one this plugin is willing to open. */
export function isAllowedAddress(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  return url.hostname !== ''
}

/** Normalize address-bar input into an absolute HTTP(S) URL, or `undefined` when it cannot be one. */
export function normalizeAddress(input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  // A scheme needs "://": without it, "localhost:8080" is a host and port, not a scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!isAllowedAddress(candidate)) return undefined
  return new URL(candidate).href
}
