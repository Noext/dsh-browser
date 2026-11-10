/**
 * Pointer-accuracy fixture: a grid of numbered cells plus a click log.
 *
 * A mis-scaled pointer is invisible on a normal page; here every click reports
 * exactly which cell the page believes it received.
 * @module tests/fixture/pointer
 */
import { createServer } from 'node:http'

/** Render the fixture page. */
function page() {
  const cells = []
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 4; col++) {
      cells.push(`<button class="cell" data-cell="${row * 4 + col}" style="grid-row:${row + 1};grid-column:${col + 1}">${row},${col}</button>`)
    }
  }
  return `<!doctype html><meta charset="utf-8"><title>Pointer fixture</title>
<style>
  html,body{margin:0;height:100%;font:14px system-ui}
  #grid{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(6,1fr);height:100vh;gap:2px;background:#222}
  .cell{background:#4a7fd4;color:#fff;border:0;font:inherit}
  #log{position:fixed;top:0;right:0;background:#000c;color:#0f0;font:12px monospace;padding:4px;max-width:45%;white-space:pre-wrap}
</style>
<div id="grid">${cells.join('')}</div>
<div id="log">no clicks</div>
<script>
  const log = document.getElementById('log')
  window.__clicks = []
  document.addEventListener('click', (event) => {
    const cell = event.target.closest('.cell')
    const entry = {
      cell: cell === null ? null : Number(cell.dataset.cell),
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio,
    }
    window.__clicks.push(entry)
    log.textContent = 'last: ' + JSON.stringify(entry) + '\\ncount: ' + window.__clicks.length
  }, true)
</script>`
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page())
})
const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { resolve(server.address().port) })
})
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/` }))
