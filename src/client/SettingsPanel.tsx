/**
 * The browser bundle's settings page.
 *
 * Draws the rows the Host exposes, and writes through the controller. Durations
 * are stored in milliseconds but shown in minutes, which is the unit a person
 * thinks in for a timeout.
 * @module dsh-browser/client/SettingsPanel
 */
import { useState, useSyncExternalStore } from 'react'
import { copy } from './copy.ts'
import { usePluginStyle } from './useStyle.ts'
import { ROWS, type SettingsController } from './settings.ts'
import type { BrowserSettings } from './settings.ts'

/** Props the slot supplies. */
export interface SettingsPanelProps {
  readonly settings: SettingsController
}

/** Render one number field, converting a duration to minutes. */
function NumberRow(props: {
  controller: SettingsController
  row: (typeof ROWS)[number]
  value: number | undefined
  overridden: boolean
}): React.ReactElement {
  const { controller, row, value, overridden } = props
  const minutes = row.unit === 'ms' && value !== undefined ? value / 60_000 : undefined
  const shown = minutes === undefined ? (value ?? '') : minutes
  return (
    <div className="dsh-browser-setting">
      <label htmlFor={`dsh-browser-${row.key}`}>
        {copy[row.labelKey as keyof typeof copy]}
        {overridden && <span className="dsh-browser-setting-changed"> · {copy['settings.overridden']}</span>}
      </label>
      <input
        id={`dsh-browser-${row.key}`}
        type="number"
        inputMode="numeric"
        min={row.min}
        max={row.max}
        value={shown}
        onChange={(event) => {
          const raw = Number(event.target.value)
          if (!Number.isFinite(raw)) return
          const stored = row.unit === 'ms' ? Math.round(raw * 60_000) : raw
          void controller.set(row.key, stored)
        }}
      />
      <p className="dsh-browser-setting-help">{copy[row.helpKey as keyof typeof copy]}</p>
      {overridden && (
        <button type="button" className="dsh-browser-setting-reset" onClick={() => { void controller.clear(row.key) }}>
          {copy['settings.reset']}
        </button>
      )}
    </div>
  )
}

/** Render the settings page. */
export function SettingsPanel({ settings }: SettingsPanelProps): React.ReactElement {
  usePluginStyle()
  const snapshot = useSyncExternalStore(
    (listener) => settings.subscribe(listener),
    () => settings.snapshot(),
  )
  const [failure] = useState(() => settings.lastError)
  const value: BrowserSettings = snapshot.value ?? {}
  const user = (snapshot.user ?? {}) as BrowserSettings

  if (snapshot.status === 'loading') return <p className="dsh-browser-setting-help">Loading…</p>
  if (snapshot.status === 'unavailable') return <p className="dsh-browser-setting-help">{copy['settings.refused']}</p>

  return (
    <div className="dsh-browser-settings">
      <h3 className="dsh-browser-settings-title">{copy['settings.title']}</h3>
      {failure !== undefined && <p className="dsh-browser-setting-help" role="alert">{failure}</p>}
      {ROWS.map((row) => {
        const current = value[row.key]
        const overridden = Object.hasOwn(user, row.key)
        if (row.kind === 'toggle') {
          const on = current === true
          return (
            <div className="dsh-browser-setting" key={row.key}>
              <label className="dsh-browser-setting-toggle">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!snapshot.writable}
                  onChange={(event) => { void settings.set(row.key, event.target.checked) }}
                />
                <span>{copy[row.labelKey as keyof typeof copy]}</span>
                {overridden && <span className="dsh-browser-setting-changed"> · {copy['settings.overridden']}</span>}
              </label>
              <p className="dsh-browser-setting-help">{copy[row.helpKey as keyof typeof copy]}</p>
              {overridden && (
                <button type="button" className="dsh-browser-setting-reset" onClick={() => { void settings.clear(row.key) }}>
                  {copy['settings.reset']}
                </button>
              )}
            </div>
          )
        }
        return <NumberRow key={row.key} controller={settings} row={row} value={typeof current === 'number' ? current : undefined} overridden={overridden} />
      })}
    </div>
  )
}