import { launchTestBrowser } from '/root/Dev/dsh-browser/tests/launch.mjs'
import { connectCdp } from '/root/Dev/dsh-browser/src/host/cdp.ts'
import { readdirSync, readFileSync } from 'node:fs'

const [dshUrl, fixtureUrl] = process.argv.slice(2)
const browser = await launchTestBrowser()
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
await page.goto(dshUrl, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)
const notice = page.getByRole('button', { name: 'Continue', exact: true })
if (await notice.count() > 0) { await notice.first().click().catch(() => {}); await page.waitForTimeout(500) }
for (let i = 0; i < 12; i++) {
  if (await page.locator('.dsh-browser-address').count() > 0) break
  const card = page.getByText('Browser', { exact: true })
  if (await card.count() > 0) { await card.last().click().catch(() => {}); await page.waitForTimeout(1200); continue }
  const t = page.getByRole('button', { name: 'Open right sidebar' })
  if (await t.count() > 0) { await t.first().click().catch(() => {}); await page.waitForTimeout(900) }
  await page.waitForTimeout(300)
}
await page.waitForTimeout(3500)
const address = page.locator('.dsh-browser-address')
await address.fill(fixtureUrl)
await address.press('Enter')
await page.waitForTimeout(4500)
await page.getByRole('button', { name: 'Take control' }).click().catch(() => {})
await page.waitForTimeout(800)

// Profiles from earlier runs keep a stale port file; probe each until one answers.
let port
for (const root of readdirSync('/root/.dsh/browser-profiles')) {
  let candidate
  try {
    candidate = readFileSync('/root/.dsh/browser-profiles/' + root + '/chromium/DevToolsActivePort', 'utf8').split('\n')[0]
  } catch { continue }
  try {
    const probe = await fetch('http://127.0.0.1:' + candidate + '/json/version')
    if (probe.ok) { port = candidate; break }
  } catch { /* dead port */ }
}
if (port === undefined) throw new Error('no live browser found; open the Browser tab first')
const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('127.0.0.1'))
const { connection } = await connectCdp(target.webSocketDebuggerUrl)
const evaluate = async (expression) => (await connection.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value

const canvas = page.locator('canvas.dsh-browser-canvas')
const box = await canvas.boundingBox()
const geo = await page.evaluate(() => {
  const element = document.querySelector('canvas.dsh-browser-canvas')
  const rect = element.getBoundingClientRect()
  return { bmp: [element.width, element.height], css: [Math.round(rect.width), Math.round(rect.height)] }
})
const size = await evaluate('({ w: innerWidth, h: innerHeight })')
console.log('canvas:', JSON.stringify(geo), 'page:', JSON.stringify(size))

let worst = 0
for (const point of [[0.2, 0.2], [0.5, 0.5], [0.8, 0.8], [0.15, 0.85], [0.9, 0.1]]) {
  const lx = Math.round(box.width * point[0])
  const ly = Math.round(box.height * point[1])
  await evaluate('window.__clicks = []')
  await canvas.click({ position: { x: lx, y: ly } })
  await page.waitForTimeout(450)
  const clicks = await evaluate('window.__clicks')
  const expectedX = Math.round((lx / box.width) * size.w)
  const expectedY = Math.round((ly / box.height) * size.h)
  if (clicks === undefined || clicks.length === 0) { console.log(point.join(','), 'NO CLICK'); continue }
  const last = clicks[clicks.length - 1]
  const error = Math.max(Math.abs(last.x - expectedX), Math.abs(last.y - expectedY))
  worst = Math.max(worst, error)
  console.log(point.join(','), 'expected', expectedX + ',' + expectedY, 'got', last.x + ',' + last.y, '->', error + 'px')
}
console.log('WORST:', worst, 'px')
connection.close()
await browser.close().catch(() => {})
process.exit(worst > 12 ? 1 : 0)
