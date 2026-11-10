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
} as const

/** Localized string keys. */
export type CopyKey = keyof typeof copy

/** Read one string. */
export function t(key: CopyKey): string {
  return copy[key]
}
