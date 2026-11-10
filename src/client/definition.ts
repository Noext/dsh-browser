/**
 * Static tab-type registration for the browser.
 *
 * `id` must be the package name: the keyed tab-body slot dispatches by it.
 * @module dsh-browser/definition
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { copy } from './copy.ts'

/** Tab kind, used by `openTab` callers and the guide. */
export const TAB_KIND = 'dshbrowser'
/** Registration identity; must equal the package name so slots dispatch. */
export const TAB_ID = 'dsh-browser'

/** Build the tab definition. */
export function tabDefinition(): SidebarRightTabDefinition {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    multiple: true,
    priority: 'extension',
    keepMounted: true,
    title: () => copy['tab.title'],
    guide: [{
      id: 'new',
      order: 25,
      title: () => copy['guide.title'],
      description: () => copy['guide.description'],
    }],
  }
}
