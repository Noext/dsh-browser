import { chromium } from 'playwright-core'
const url = process.argv[2]
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const sent = [], recv = []
page.on('websocket', (s) => {
  if (!s.url().includes('dsh-browser')) return
  s.on('framesent', (f) => { if (typeof f.payload === 'string') sent.push(f.payload.slice(0, 100)) })
  s.on('framereceived', (f) => { if (typeof f.payload === 'string') recv.push(f.payload.slice(0, 100)) })
})
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
for (const b of await page.locator('button').all()) { const box = await b.boundingBox().catch(()=>null); if (box && box.y < 70 && box.x > 1450) { await b.click().catch(()=>{}); await page.waitForTimeout(800); break } }
await page.getByText('Browser', { exact: true }).last().click().catch(()=>{})
await page.waitForTimeout(7000)
console.log('sent:', sent.filter(s => s.includes('resize')))
console.log('recv viewport:', recv.filter(s => s.includes('viewport')))
console.log('recv errors:', recv.filter(s => s.includes('error')))
console.log('state', JSON.stringify(await page.evaluate(() => { const c = document.querySelector('canvas.dsh-browser-canvas'); return { w: c?.width, h: c?.height } })))
await browser.close()
