/**
 * Canvas geometry: turning a pointer position in the mirrored pane into page
 * pixels, and choosing the emulated viewport for a given pane size.
 *
 * Pure and separately tested: an off-by-one here silently breaks every click.
 * @module dsh-browser/geometry
 */

/** One rectangle in CSS pixels. */
export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** A point in page (device-independent) pixels. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** Viewport the browser is emulated at. */
export interface Viewport {
  readonly width: number
  readonly height: number
}

/** Smallest viewport we will render into; below this the page is unreadable anyway. */
export const MIN_VIEWPORT = { width: 360, height: 300 } as const
/** Largest viewport we render at; beyond this the sidebar is scrolling horizontally. */
export const MAX_VIEWPORT = { width: 1920, height: 1200 } as const

/**
 * Fit the emulated viewport into a pane, preserving a sane aspect ratio.
 * @param pane - available pane size in CSS pixels.
 * @param fallback - viewport to use when the pane reports no usable size.
 * @returns the viewport to emulate, clamped to the supported range.
 */
export function viewportFor(pane: { width: number; height: number }, fallback: Viewport): Viewport {
  const width = Number.isFinite(pane.width) ? Math.floor(pane.width) : 0
  const height = Number.isFinite(pane.height) ? Math.floor(pane.height) : 0
  if (width < MIN_VIEWPORT.width || height < MIN_VIEWPORT.height) {
    return {
      width: Math.max(MIN_VIEWPORT.width, Math.min(MAX_VIEWPORT.width, fallback.width)),
      height: Math.max(MIN_VIEWPORT.height, Math.min(MAX_VIEWPORT.height, fallback.height)),
    }
  }
  return {
    width: Math.min(MAX_VIEWPORT.width, width),
    height: Math.min(MAX_VIEWPORT.height, height),
  }
}

/**
 * Map a pointer event position onto page pixels.
 * @param event - client coordinates of the pointer event.
 * @param rect - the canvas's bounding client rect.
 * @param viewport - the emulated page viewport.
 * @returns the page point, or `undefined` when the event is outside the canvas.
 */
export function toPagePoint(event: Point, rect: Rect, viewport: Viewport): Point | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const ratioX = viewport.width / rect.width
  const ratioY = viewport.height / rect.height
  const x = (event.x - rect.left) * ratioX
  const y = (event.y - rect.top) * ratioY
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return undefined
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * Scale a wheel delta into the page's own scroll units.
 * @param delta - raw wheel delta from the DOM event.
 * @param viewport - the emulated page viewport.
 * @param rect - the canvas's bounding client rect.
 * @returns the delta in page pixels, with sub-pixel values preserved as `number`.
 */
export function toPageDelta(delta: number, viewport: Viewport, rect: Rect): number {
  if (rect.height <= 0) return delta
  return delta * (viewport.height / rect.height)
}

/**
 * Convert DOM modifier flags to the CDP bit mask.
 * @param event - object carrying the four modifier booleans.
 * @returns the CDP `modifiers` bit mask (Alt 1, Ctrl 2, Meta 4, Shift 8).
 */
export function modifiersOf(event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): number {
  return (event.altKey === true ? 1 : 0)
    | (event.ctrlKey === true ? 2 : 0)
    | (event.metaKey === true ? 4 : 0)
    | (event.shiftKey === true ? 8 : 0)
}
