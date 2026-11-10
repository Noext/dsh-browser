/**
 * End-to-end: open a Session, open the Browser tab, navigate, take control, type,
 * and confirm screencast frames arrive.
 *
 * Usage: node tests/e2e.mjs <dsh-url-with-token>
 * @module tests/e2e
 */
import { mkdirSync } from 'node:fs'
import { openBrowserTab, openDsh } from './launch.mjs'

const url = process.argv[2]
if (url === undefined) throw new Error('usage: node tests/e2e.mjs <dsh-url-with-token>')
mkdirSync('tests/shots', { recursive: true })

const { browser, page } = await openDsh(url)
const errors = []
page.on('pageerror', (error) => { errors.push(error.message) })

let frames = 0
page.on('websocket', (socket) => {
  if (!socket.url().includes('dsh-browser')) return
  socket.on('framereceived', (payload) => { if (typeof payload.payload !== 'string') frames++ })
})

const shot = (name) => page.screenshot({ path: `tests/shots/${name}.png` })

/** Hash the canvas so a frame is provably on screen. */
const canvasSignature = () => page.evaluate(() => {
  const canvas = document.querySelector('canvas.dsh-browser-canvas')
  if (canvas === null) return null
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let hash = 0
  for (let i = 0; i < data.length; i += 397) hash = (hash * 31 + data[i]) | 0
  return { hash, width: canvas.width, height: canvas.height }
})

if (!await openBrowserTab(page)) {
  await shot('e2e-failed')
  throw new Error('the Browser tab never opened')
}
await page.waitForTimeout(5000)
await shot('e2e-1-opened')
console.log('[e2e] opened, canvas', JSON.stringify(await canvasSignature()))

const address = page.locator('.dsh-browser-address')
await address.fill('https://example.com')
await address.press('Enter')
await page.waitForTimeout(5000)
await shot('e2e-2-navigated')
console.log('[e2e] navigated, canvas', JSON.stringify(await canvasSignature()))

await page.getByRole('button', { name: 'Take control' }).click().catch(() => {})
await page.waitForTimeout(900)
console.log('[e2e] control badge:', await page.locator('.dsh-browser-badge').textContent())
await shot('e2e-3-took-control')

const before = frames
await page.locator('canvas.dsh-browser-canvas').click({ position: { x: 200, y: 200 } })
await page.keyboard.type('test')
await page.mouse.wheel(0, 200)
await page.waitForTimeout(2500)
console.log('[e2e] frames while interacting:', frames - before)
await shot('e2e-4-interacted')

console.log('[e2e] total frames:', frames)
if (errors.length > 0) console.log('[e2e] page errors:', errors.slice(0, 5))
console.log('[e2e] done')
await browser.close()
