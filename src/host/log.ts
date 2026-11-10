/**
 * Logging shim so the Host half can be exercised without a Cordis context.
 * @module dsh-browser/host/log
 */

/** The slice of DSH's logger this plugin uses. */
export interface Log {
  debug(message: string, error?: unknown): void
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

/** Print to stdout with a stable prefix; used by tests and the standalone spike. */
export const consoleLog: Log = {
  debug(message, error) {
    if (process.env.DSH_BROWSER_DEBUG === undefined) return
    console.debug(`[dsh-browser] ${message}`, error ?? '')
  },
  info(message) { console.log(`[dsh-browser] ${message}`) },
  warn(message, error) { console.warn(`[dsh-browser] ${message}`, error ?? '') },
  error(message, error) { console.error(`[dsh-browser] ${message}`, error ?? '') },
}

/** Discard everything; the default before a Cordis logger is bound. */
export const silentLog: Log = {
  debug() {}, info() {}, warn() {}, error() {},
}
