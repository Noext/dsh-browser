/**
 * End-to-end: navigate, take control, type, and confirm frames keep flowing.
 * @module tests/e2e
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const url = process.argv[2]
if (!url) throw new Error('usage: e2e.mjs <url>')
mkdirSync('tests/shots', { recursive: true })

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const logs = []
page.on('console', (m) => { if (m.type() === 'error') logs.push('[error] ' + m.text()) })
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))

let frames = 0
page.on('websocket', (ws) => {
  if (!ws.url().includes('dsh-browser')) return
  ws.on('framereceived', (frame) => {
    if (typeof frame.payload !== 'string') frames++
  })
})

const shot = async (name) => {
  await page.screenshot({ path: `tests/shots/${name}.png` })
  console.log('[e2e] shot', name)
}
const canvasSignature = () => page.evaluate(() => {
  const canvas = document.querySelector('canvas.dsh-browser-canvas')
  if (canvas === null) return null
  const context = canvas.getContext('2d')
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let hash = 0
  let lit = 0
  for (let i = 0; i < data.length; i += 397) {
    hash = (hash * 31 + data[i]) | 0
    if (data[i] > 20) lit++
  }
  return { hash, lit, width: canvas.width, height: canvas.height }
})

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

// Open the right sidebar: the toggle is the last header icon, top-right.
const openSidebar = async () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await page.locator('.dsh-browser-address').count() > 0) return true
    if (await page.getByText('Browser', { exact: true }).count() > 0) {
      await page.getByText('Browser', { exact: true }).last().click().catch(() => {})
      await page.waitForTimeout(1200)
      continue
    }
    for (const button of await page.locator('button').all()) {
      const box = await button.boundingBox().catch(() => null)
      if (box !== null && box.y < 80 && box.x > page.viewportSize().width - 120) {
        await button.click().catch(() => {})
        await page.waitForTimeout(900)
        break
      }
    }
    await page.waitForTimeout(500)
  }
  return await page.locator('.dsh-browser-address').count() > 0
}
console.log('[e2e] sidebar opened:', await openSidebar())
await page.waitForTimeout(4000)
await shot('e2e-1-opened')

console.log('[e2e] blank signature:', JSON.stringify(await canvasSignature()))

// navigate through the address bar
const address = page.locator('.dsh-browser-address')
await address.fill('https://example.com')
await address.press('Enter')
await page.waitForTimeout(4000)
await shot('e2e-2-navigated')
const navigated = await canvasSignature()
console.log('[e2e] after navigate:', JSON.stringify(navigated))
console.log('[e2e] address bar:', await address.inputValue())
const title = await page.locator('.dsh-browser-status span').first().textContent()
console.log('[e2e] status title:', title)

// take control, then click inside the page canvas
await page.getByRole('button', { name: 'Take control' }).click().catch((e) => console.log('[e2e] take control failed', e.message))
await page.waitForTimeout(800)
const badge = await page.locator('.dsh-browser-badge').textContent()
console.log('[e2e] badge:', badge)
await shot('e2e-3-took-control')

// type a key and scroll, and watch frames arrive
const before = frames
await page.locator('canvas.dsh-browser-canvas').click({ position: { x: 200, y: 200 } })
await page.waitForTimeout(300)
await page.keyboard.type('test')
await page.mouse.wheel(0, 200)
await page.waitForTimeout(2500)
console.log('[e2e] frames during interaction:', frames - before)
await shot('e2e-4-interacted')
const after = await canvasSignature()
console.log('[e2e] after interaction:', JSON.stringify(after))

console.log('[e2e] errors:', logs.slice(0, 10))
await browser.close()
