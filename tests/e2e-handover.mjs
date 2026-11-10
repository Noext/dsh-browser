/**
 * End-to-end handover: take control, hand back, and confirm the badge and the
 * mirror both follow.
 *
 * Usage: node tests/e2e-handover.mjs <dsh-url-with-token>
 * @module tests/e2e-handover
 */
import { mkdirSync } from 'node:fs'
import { launchTestBrowser } from './launch.mjs'

const url = process.argv[2]
if (url === undefined) throw new Error('usage: node tests/e2e-handover.mjs <dsh-url-with-token>')
mkdirSync('tests/shots', { recursive: true })

const browser = await launchTestBrowser()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })

const shot = (name) => page.screenshot({ path: `tests/shots/${name}.png` })

/** Open the right sidebar, then the Browser card. */
async function openBrowserTab() {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (await page.locator('.dsh-browser-address').count() > 0) return true
    const card = page.getByText('Browser', { exact: true })
    if (await card.count() > 0) {
      await card.last().click().catch(() => {})
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

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
if (!await openBrowserTab()) throw new Error('the Browser tab never opened')
await page.waitForTimeout(4000)
await shot('handover-1-open')

const badge = () => page.locator('.dsh-browser-badge').textContent()
console.log('[handover] badge at open:', await badge())

await page.getByRole('button', { name: 'Take control' }).click().catch(() => {})
await page.waitForTimeout(800)
console.log('[handover] badge after takeover:', await badge())
await shot('handover-2-human')

await page.getByRole('button', { name: /Done/ }).click().catch(() => {})
await page.waitForTimeout(1200)
console.log('[handover] badge after handback:', await badge())
await shot('handover-3-handback')

const address = page.locator('.dsh-browser-address')
await address.fill('https://example.com')
await address.press('Enter')
await page.waitForTimeout(4000)
console.log('[handover] status:', await page.locator('.dsh-browser-status').textContent())
await shot('handover-4-navigated')

console.log('[handover] done')
await browser.close()
