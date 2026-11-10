/**
 * The sidebar's browser tab: a canvas mirror plus the control handover.
 * @module dsh-browser/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BrowserBody } from './body.tsx'
import { TAB_ID, TAB_KIND, tabDefinition } from './definition.ts'

/** Services this plugin needs. */
export const inject = ['slots', 'sidebarRightTabs']

/** Register the tab type and its body. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(tabDefinition()), 'dsh-browser: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
  }, BrowserBody)), 'dsh-browser: tab body')
}

/** Re-export the kind so other plugins can open this tab. */
export { TAB_KIND }
