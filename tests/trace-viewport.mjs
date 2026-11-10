import { launchTestBrowser } from '/root/Dev/dsh-browser/tests/launch.mjs'
import { connectCdp } from '/root/Dev/dsh-browser/src/host/cdp.ts'
import { readdirSync, readFileSync } from 'node:fs'

const [dshUrl, fixtureUrl] = process.argv.slice(2)
const browser = await launchTestBrowser()
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
const sent = []
const recv = []
page.on('websocket', (socket) => {
  if (!socket.url().includes('dsh-browser')) return
  socket.on('framesent', (f) => { if (typeof f.payload === 'string') sent.push(f.payload.slice(0, 100)) })
  socket.on('framereceived', (f) => { if (typeof f.payload === 'string') recv.push(f.payload.slice(0, 100)) })
})
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
await page.waitForTimeout(4000)
const address = page.locator('.dsh-browser-address')
address.fill && await address.fill(fixtureUrl)
await address.press('Enter')
await page.waitForTimeout(4000)

let port
for (const root of readdirSync('/root/.dsh/browser-profiles')) {
  let candidate
  try { candidate = readFileSync('/root/.dsh/browser-profiles/' + root + '/chromium/DevToolsActivePort', 'utf8').split('\n')[0] } catch { continue }
  try { const probe = await fetch('http://127.0.0.1:' + candidate + '/json/version'); if (probe.ok) { port = candidate; break } } catch {}
}
const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
const target = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
const { connection } = await connectCdp(target.webSocketDebuggerUrl)
const evaluate = async (e) => (await connection.send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value
console.log('page innerWidth/innerHeight:', JSON.stringify(await evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })')))
console.log('sent resize:', sent.filter((x) => x.includes('resize')))
console.log('recv viewport:', recv.filter((x) => x.includes('viewport')))
console.log('recv errors:', recv.filter((x) => x.includes('error')))
connection.close()
await browser.close().catch(() => {})
