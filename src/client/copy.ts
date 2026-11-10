/**
 * User-facing copy. The client bundle inlines this module; the `locale/` files
 * carry the same keys for the Host's plugin catalog.
 * @module dsh-browser/copy
 */

/** Every string the browser tab shows. */
export const copy = {
  'tab.title': 'Browser',
  'guide.title': 'Browser',
  'guide.description': 'Drive a real Chromium beside this conversation, and take over to sign in.',
  'toolbar.back': 'Back',
  'toolbar.forward': 'Forward',
  'toolbar.reload': 'Reload',
  'toolbar.go': 'Go',
  'toolbar.address': 'Address',
  'control.take': 'Take control',
  'control.release': 'Hand back',
  'control.agent': 'Agent is driving',
  'control.human': 'You are driving',
  'control.request': 'The agent needs your help',
  'control.done': 'Done — hand back',
  'control.idle': 'Idle',
  'state.connecting': 'Connecting to the browser…',
  'state.reconnecting': 'Connection lost — reconnecting…',
  'state.starting': 'Starting Chromium…',
  'state.failed': 'The browser could not start',
  'state.retry': 'Retry',
  'state.closed': 'The browser was closed',
  'state.unsupported': 'This tab needs the dsh-browser Host plugin',
  'request.title': 'The agent needs your help',
  'settings.title': 'Browser settings',
  'settings.save': 'Save',
  'settings.reset': 'Reset to default',
  'settings.refused': 'The Host refused this change.',
  'settings.overridden': 'Changed',
  'row.headed': 'Show a Chromium window',
  'row.headedHelp': 'Off runs the browser headless: the mirror in the sidebar keeps working, but no window opens on the desktop.',
  'row.profile': 'Keep cookies and logins',
  'row.profileHelp': 'Stores the browser profile on disk so a sign-in survives a restart. Turned off, each browser starts clean.',
  'row.quality': 'Mirror quality',
  'row.qualityHelp': 'JPEG quality of the mirror, 20 to 95. Lower is faster over a slow link; higher keeps small text readable.',
  'row.humanIdle': 'Takeover timeout',
  'row.humanIdleHelp': 'Minutes before a forgotten human takeover hands the browser back to the agent. Zero never hands it back.',
  'row.idleTimeout': 'Idle shutdown',
  'row.idleTimeoutHelp': 'Minutes after which a browser nobody is watching closes itself. Zero keeps it open until the Session ends.',
} as const

/** Localized string keys. */
export type CopyKey = keyof typeof copy

/** Read one string. */
export function t(key: CopyKey): string {
  return copy[key]
}