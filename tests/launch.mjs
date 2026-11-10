/**
 * Shared launch helper for the end-to-end checks.
 *
 * A checked-in absolute path would break on every machine but the one it was
 * written on, so the executable comes from `DSH_BROWSER_EXECUTABLE`, then
 * Playwright's own discovery.
 * @module tests/launch
 */
import { chromium } from 'playwright-core'

/**
 * Launch a headless Chromium for driving the DSH page itself.
 * @param {object} [options] - extra Playwright launch options.
 * @returns {Promise<import('playwright-core').Browser>} the browser.
 */
export async function launchTestBrowser(options = {}) {
  const executablePath = process.env.DSH_BROWSER_EXECUTABLE ?? chromium.executablePath()
  const browser = await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...options,
  })
  return browser
}
