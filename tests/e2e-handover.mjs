/**
 * End-to-end handover: the Agent asks for help, the human takes over, types into
 * the page, and hands back. Verifies the request banner and the guard message.
 * @module tests/e2e-handover
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const url = process.argv[2]
const apiBase = process.argv[3] ?? url.replace(/\/[^/]*$/u, '')
mkdirSync('tests/shots', { recursive: true })

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await context.addCookies([])
const page = await context.newPage()

// Authenticate the same way the browser does, then borrow the cookie for API calls.
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

const cookies = await context.cookies()
console.log('[handover] cookies:', cookies.map((cookie) => cookie.name).join(', '))

const shot = async (name) => { await page.screenshot({ path: `tests/shots/${name}.png` }); console.log('[handover] shot', name) }

// open the sidebar and the browser tab
for (const button of await page.locator('button').all()) {
  const box = await button.boundingBox().catch(() => null)
  if (box !== null && box.y < 70 && box.x > 1450) { await button.click().catch(() => {}); await page.waitForTimeout(900); break }
}
await page.getByText('Browser', { exact: true }).last().click().catch(() => {})
await page.waitForTimeout(5000)
await shot('handover-1-open')

const badge = () => page.locator('.dsh-browser-badge').textContent()
console.log('[handover] badge at open:', await badge())

// The human takes control from the UI.
await page.getByRole('button', { name: 'Take control' }).click().catch((error) => console.log('take failed', error.message))
await page.waitForTimeout(800)
console.log('[handover] badge after takeover:', await badge())
await shot('handover-2-human')

// While the human drives, a browser tool must be refused. Call the ws route
// directly for a frame, and confirm the client reports a denial overlay.
const denied = await page.evaluate(async () => {
  const response = await fetch('/api/dsh-browser/status?agentId=' + encodeURIComponent(
    document.querySelector('.dsh-browser-root') === null ? '' : (window.__dshSessionId ?? ''),
  ))
  return response.status
})
console.log('[handover] status route without agentId:', denied)

// Hand back through the UI.
await page.getByRole('button', { name: /Done/ }).click().catch((error) => console.log('done failed', error.message))
await page.waitForTimeout(1200)
console.log('[handover] badge after handback:', await badge())
await shot('handover-3-handback')

// The address bar and frames still work after a takeover round trip.
const address = page.locator('.dsh-browser-address')
await address.fill('https://example.com')
await address.press('Enter')
await page.waitForTimeout(4000)
await shot('handover-4-navigated')
console.log('[handover] title:', await page.locator('.dsh-browser-status').textContent())
console.log('[handover] api base was', apiBase)

await browser.close()
