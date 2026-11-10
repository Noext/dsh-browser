/**
 * Settings form for the browser bundle.
 *
 * The Plugins page renders no form of its own: a plugin that wants controls on
 * its page registers into `plugins.bundle.config` and drives the namespace
 * itself. This controller owns that wiring, and stays React-free so the state
 * is testable without a DOM.
 * @module dsh-browser/client/settings
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Namespace the Host entry registers under: its profile entry id. */
export const SETTINGS_NAMESPACE = 'dsh-browser'

/** Values this page edits, as the Host stores them. */
export interface BrowserSettings {
  headed?: boolean
  persistentProfile?: boolean
  quality?: number
  humanIdleMs?: number
  idleTimeoutMs?: number
}

/** One row the page draws. */
export interface SettingRow {
  readonly key: keyof BrowserSettings
  readonly kind: 'toggle' | 'number'
  readonly labelKey: string
  readonly helpKey: string
  readonly min?: number
  readonly max?: number
  /** Milliseconds for a duration field, so the UI can show minutes. */
  readonly unit?: 'ms'
}

/** The rows in display order. */
export const ROWS: readonly SettingRow[] = [
  { key: 'headed', kind: 'toggle', labelKey: 'row.headed', helpKey: 'row.headedHelp' },
  { key: 'persistentProfile', kind: 'toggle', labelKey: 'row.profile', helpKey: 'row.profileHelp' },
  { key: 'quality', kind: 'number', labelKey: 'row.quality', helpKey: 'row.qualityHelp', min: 20, max: 95 },
  { key: 'humanIdleMs', kind: 'number', labelKey: 'row.humanIdle', helpKey: 'row.humanIdleHelp', min: 0, unit: 'ms' },
  { key: 'idleTimeoutMs', kind: 'number', labelKey: 'row.idleTimeout', helpKey: 'row.idleTimeoutHelp', min: 0, unit: 'ms' },
]

/** What the React face receives. */
export interface SettingsFace {
  readonly useSettings: () => ConfigFormSnapshot<BrowserSettings>
  readonly set: (key: keyof BrowserSettings, value: unknown) => void
  readonly clear: (key: keyof BrowserSettings) => void
}

/** Outcome of one write, surfaced to the page. */
export type WriteResult = 'accepted' | 'refused' | 'failed'

/** Owns the namespace form and the page's own error state. */
export class SettingsController {
  private readonly form: ConfigForm<BrowserSettings>
  private readonly disposed: () => void
  private failure: string | undefined
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    this.form = ctx.configForms.get<BrowserSettings>(SETTINGS_NAMESPACE)
    // The form subscribes to the shared mirror; this controller forwards changes
    // so the page re-renders without knowing the settings service exists.
    const unsubscribe = this.form.subscribe(() => { this.notify() })
    this.disposed = () => { unsubscribe() }
  }

  /** Current snapshot. */
  snapshot(): ConfigFormSnapshot<BrowserSettings> {
    return this.form.getSnapshot()
  }

  /** Subscribe to snapshot replacements. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The last write failure, or undefined. */
  get lastError(): string | undefined { return this.failure }

  /**
   * Write one field.
   * @param key - the settings field.
   * @param value - new value.
   * @returns how the Host answered.
   */
  async set(key: keyof BrowserSettings, value: unknown): Promise<WriteResult> {
    return await this.write(() => this.form.set(key, value))
  }

  /**
   * Clear one field, so it falls back to the composition default.
   * @param key - the settings field.
   * @returns how the Host answered.
   */
  async clear(key: keyof BrowserSettings): Promise<WriteResult> {
    return await this.write(() => this.form.unset(key))
  }

  /** Release the subscription. */
  dispose(): void {
    this.disposed()
    this.listeners.clear()
  }

  private async write(run: () => Promise<boolean>): Promise<WriteResult> {
    try {
      const accepted = await run()
      this.failure = accepted ? undefined : 'the Host refused this change'
      this.notify()
      return accepted ? 'accepted' : 'refused'
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
      this.notify()
      return 'failed'
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
