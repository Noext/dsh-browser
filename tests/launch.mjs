/**
 * Shared launch helper for the end-to-end checks.
 *
 * A checked-in absolute path would break on every machine but the one it was
 * written on, and Playwright's own `executablePath()` names the revision its
 * version expects — which may not be the one installed. Discovery therefore goes
 * through the plugin's launcher, which only returns a path that exists.
 * @module tests/launch
 */
import { chromium } from 'playwright-core'
import { discoverExecutable } from '../src/host/launcher.ts'

/**
 * Launch a headless Chromium for driving the DSH page itself.
 * @param {object} [options] - extra Playwright launch options.
 * @returns {Promise<import('playwright-core').Browser>} the browser.
 */
export async function launchTestBrowser(options = {}) {
  const executablePath = discoverExecutable()
  if (executablePath === undefined) {
    throw new Error('no Chromium found: set DSH_BROWSER_EXECUTABLE or run "npx playwright install chromium"')
  }
  return await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...options,
  })
}
/**
 * Dismiss the preview notice that covers the app on a fresh profile.
 * @param {import('playwright-core').Page} page - the DSH page.
 */
export async function dismissPreviewNotice(page) {
  const notice = page.getByRole('button', { name: 'Continue', exact: true })
  if (await notice.count() > 0) {
    await notice.first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(600)
  }
}

/**
 * Open the right sidebar, then the Browser card.
 * @param {import('playwright-core').Page} page - the DSH page.
 * @returns {Promise<boolean>} whether the tab's address bar appeared.
 */
export async function openBrowserTab(page) {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await page.locator('.dsh-browser-address').count() > 0) return true
    const card = page.getByText('Browser', { exact: true })
    if (await card.count() > 0) {
      await card.last().click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1200)
      continue
    }
    // The toggle has a stable accessible name; a coordinate test does not.
    const toggle = page.getByRole('button', { name: 'Open right sidebar' })
    if (await toggle.count() > 0) {
      await toggle.first().click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(900)
    }
    await page.waitForTimeout(400)
  }
  return await page.locator('.dsh-browser-address').count() > 0
}

/**
 * Launch a Chromium, open the DSH app, and get past the notices.
 * @param {string} url - the DSH URL including its token.
 * @returns {Promise<{ browser: import('playwright-core').Browser, page: import('playwright-core').Page }>}
 */
export async function openDsh(url) {
  const browser = await launchTestBrowser()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  await dismissPreviewNotice(page)
  return { browser, page }
}
