/**
 * Act on a snapshot ref, the way agent-browser does.
 *
 * A ref is a Chromium backend node id. Resolving it and scrolling it into view
 * is exact, and unlike a CSS selector it cannot silently match a different
 * element after the page re-renders. A target that is hidden, disabled or
 * covered fails with a reason instead of reporting a click that did nothing.
 * @module dsh-browser/host/refs
 */
import type { CdpConnection } from './cdp.ts'

/** Why an action could not be delivered. */
export type ActionRefusal = 'unknown-ref' | 'detached' | 'hidden' | 'disabled' | 'covered'

/** Result of attempting one action. */
export interface ActionResult {
  readonly ok: boolean
  readonly refusal?: ActionRefusal
  /** Human-readable detail for the model; present on both outcomes. */
  readonly detail: string
}

/** Geometry of a resolved element, in page pixels. */
interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Resolve a ref to its element and return a click point.
 * @param connection - the CDP connection carrying the page session.
 * @param sessionId - the flattened page session.
 * @param backendNodeId - backend node id from a snapshot ref.
 * @returns the point to click and a short description, or a refusal.
 */
export async function resolveClickPoint(
  connection: CdpConnection,
  sessionId: string,
  backendNodeId: number,
): Promise<{ point: Box; detail: string } | { refusal: ActionRefusal; detail: string }> {
  await connection.send('DOM.enable', {}, sessionId)
  let objectId: string | undefined
  try {
    const resolved = await connection.send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode', { backendNodeId }, sessionId,
    )
    objectId = resolved.object?.objectId
  } catch (error) {
    return { refusal: 'detached', detail: `the element is gone (${message(error)}); take a new snapshot` }
  }
  if (objectId === undefined) {
    return { refusal: 'unknown-ref', detail: 'the ref does not name an element; take a new snapshot' }
  }

  const measured = await connection.send<{ result?: { value?: Record<string, unknown> } }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () {
      this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = this.getBoundingClientRect()
      const style = getComputedStyle(this)
      const disabled = this.disabled === true || this.getAttribute('aria-disabled') === 'true'
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') return { hidden: true }
      if (disabled) return { disabled: true }
      const cx = Math.round(r.x + r.width / 2)
      const cy = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(cx, cy)
      const covered = hit === null ? false : !(this === hit || this.contains(hit))
      return { x: cx, y: cy, width: r.width, height: r.height, covered, label: (this.innerText || this.getAttribute('aria-label') || this.value || '').slice(0, 60) }
    }`,
    returnByValue: true,
  }, sessionId)

  const value = measured.result?.value ?? {}
  if (value.hidden === true) return { refusal: 'hidden', detail: 'the element is not visible; take a new snapshot' }
  if (value.disabled === true) return { refusal: 'disabled', detail: 'the element is disabled' }
  if (value.covered === true) return { refusal: 'covered', detail: 'another element covers it, often a consent banner; dismiss it and take a new snapshot' }
  const point: Box = {
    x: Number(value.x ?? 0), y: Number(value.y ?? 0),
    width: Number(value.width ?? 0), height: Number(value.height ?? 0),
  }
  return { point, detail: String(value.label ?? '').trim() }
}

/** Read an error's message without trusting its shape. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}