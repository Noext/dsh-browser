/** Geometry: an off-by-one here silently misses every click. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_VIEWPORT, toPageDelta, toPagePoint, viewportFor } from '../src/shared/geometry.ts'

const rect = { left: 10, top: 20, width: 640, height: 400 }
const viewport = { width: 1280, height: 800 }

test('a canvas at half scale maps to page pixels', () => {
  assert.deepEqual(toPagePoint({ x: 10, y: 20 }, rect, viewport), { x: 0, y: 0 })
  assert.deepEqual(toPagePoint({ x: 650, y: 420 }, rect, viewport), { x: 1280, y: 800 })
  assert.deepEqual(toPagePoint({ x: 330, y: 220 }, rect, viewport), { x: 640, y: 400 })
})

test('points outside the canvas are rejected, not clamped', () => {
  assert.equal(toPagePoint({ x: 9, y: 20 }, rect, viewport), undefined)
  assert.equal(toPagePoint({ x: 651, y: 20 }, rect, viewport), undefined)
})

test('a zero-sized canvas never produces coordinates', () => {
  assert.equal(toPagePoint({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 }, viewport), undefined)
})

test('wheel deltas scale with the viewport', () => {
  assert.equal(toPageDelta(100, viewport, rect), 200)
  assert.equal(toPageDelta(0, viewport, rect), 0)
})

test('a pane smaller than the minimum keeps the fallback viewport', () => {
  assert.deepEqual(viewportFor({ width: 100, height: 50 }, viewport), viewport)
  assert.deepEqual(viewportFor({ width: Number.NaN, height: 0 }, viewport), viewport)
})

test('a real pane is used as-is, within the supported range', () => {
  assert.deepEqual(viewportFor({ width: 900, height: 700 }, viewport), { width: 900, height: 700 })
  assert.deepEqual(viewportFor({ width: 5000, height: 5000 }, viewport), { width: 1920, height: 1200 })
  assert.deepEqual(viewportFor({ width: MIN_VIEWPORT.width, height: MIN_VIEWPORT.height }, viewport), MIN_VIEWPORT)
})
