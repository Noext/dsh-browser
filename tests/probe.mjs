/**
 * Diagnostic: report what the tab's websocket actually sent and received.
 *
 * Usage: node tests/probe.mjs <dsh-url-with-token>
 * @module tests/probe
 */
import { launchTestBrowser } from './launch.mjs'

const url = process.argv[2]
if (url === undefined) throw new Error('usage: node tests/probe.mjs <dsh-url-with-token>')

const browser = await launchTestBrowser()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const sent = []
const received = []
page.on('websocket', (socket) => {
  if (!socket.url().includes('dsh-browser')) return
  socket.on('framesent', (payload) => { if (typeof payload.payload === 'string') sent.push(payload.payload.slice(0, 120)) })
  socket.on('framereceived', (payload) => { if (typeof payload.payload === 'string') received.push(payload.payload.slice(0, 120)) })
})

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
for (const button of await page.locator('button').all()) {
  const box = await button.boundingBox().catch(() => null)
  if (box !== null && box.y < 80 && box.x > page.viewportSize().width - 120) { await button.click().catch(() => {}); break }
}
await page.waitForTimeout(800)
await page.getByText('Browser', { exact: true }).last().click().catch(() => {})
await page.waitForTimeout(7000)

console.log('state:', JSON.stringify(await page.evaluate(() => {
  const stage = document.querySelector('.dsh-browser-stage')
  const canvas = document.querySelector('canvas.dsh-browser-canvas')
  const rect = stage?.getBoundingClientRect()
  return {
    stage: rect === undefined ? null : { w: Math.round(rect.width), h: Math.round(rect.height) },
    bitmap: canvas === null ? null : { w: canvas.width, h: canvas.height },
    css: canvas === null ? null : { w: canvas.style.width, h: canvas.style.height },
    status: document.querySelector('.dsh-browser-status')?.textContent,
  }
})))
console.log('sent resize:', sent.filter((line) => line.includes('resize')))
console.log('received viewport:', received.filter((line) => line.includes('viewport')))
console.log('received errors:', received.filter((line) => line.includes('error')))
await browser.close()
