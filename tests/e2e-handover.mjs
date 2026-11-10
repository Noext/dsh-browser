/**
 * End-to-end handover: take control, hand back, and confirm the badge and the
 * mirror both follow.
 *
 * Usage: node tests/e2e-handover.mjs <dsh-url-with-token>
 * @module tests/e2e-handover
 */
import { mkdirSync } from 'node:fs'
import { openBrowserTab, openDsh } from './launch.mjs'

const url = process.argv[2]
if (url === undefined) throw new Error('usage: node tests/e2e-handover.mjs <dsh-url-with-token>')
mkdirSync('tests/shots', { recursive: true })

const { browser, page } = await openDsh(url)
const shot = (name) => page.screenshot({ path: `tests/shots/${name}.png` })

let frames = 0
page.on('websocket', (socket) => {
  if (!socket.url().includes('dsh-browser')) return
  socket.on('framereceived', (payload) => { if (typeof payload.payload !== 'string') frames++ })
})

if (!await openBrowserTab(page)) throw new Error('the Browser tab never opened')
await page.waitForTimeout(5000)
await shot('handover-1-open')

const badge = () => page.locator('.dsh-browser-badge').textContent()
console.log('[handover] badge at open:', await badge())

await page.getByRole('button', { name: 'Take control' }).click().catch(() => {})
await page.waitForTimeout(900)
console.log('[handover] badge after takeover:', await badge())
await shot('handover-2-human')

// While the human holds the browser the agent's tools must be refused; the
// status route reports the lease the guard reads.
const status = await page.evaluate(async () => {
  const response = await fetch('/api/dsh-browser/status')
  return { code: response.status, body: await response.text() }
})
console.log('[handover] status route:', status.code, status.body.slice(0, 120))

await page.getByRole('button', { name: /Done/ }).click().catch(() => {})
await page.waitForTimeout(1200)
console.log('[handover] badge after handback:', await badge())
await shot('handover-3-handback')

// A page with real scrollback, so a wheel actually repaints and frames must flow.
const address = page.locator('.dsh-browser-address')
await address.fill('https://en.wikipedia.org/wiki/Chromium_(web_browser)')
await address.press('Enter')
await page.waitForTimeout(6000)
console.log('[handover] title:', await page.locator('.dsh-browser-status').textContent())
await shot('handover-4-navigated')

const afterNavigation = frames
await page.locator('canvas.dsh-browser-canvas').hover()
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(120)
}
await page.waitForTimeout(1200)
console.log('[handover] frames while scrolling:', frames - afterNavigation)
await shot('handover-5-scrolled')

console.log('[handover] done')
await browser.close()
