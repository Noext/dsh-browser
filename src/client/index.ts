/**
 * The sidebar's browser tab, and the bundle's settings page.
 * @module dsh-browser/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BrowserBody } from './body.tsx'
import { TAB_ID, TAB_KIND, tabDefinition } from './definition.ts'
import { SettingsController, SETTINGS_NAMESPACE } from './settings.ts'
import { SettingsPanel } from './SettingsPanel.tsx'

/** Services this plugin needs. */
export const inject = ['slots', 'sidebarRightTabs', 'configForms']

/**
 * Register the tab type, its body, and the bundle's settings page.
 *
 * The settings page exists only while the Host serves this bundle's namespace,
 * so a deployment that never loads the Host half shows no trace of it.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register(tabDefinition()), 'dsh-browser: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
  }, BrowserBody)), 'dsh-browser: tab body')

  const settings = new SettingsController(ctx)
  ctx.effect(() => () => { settings.dispose() }, 'dsh-browser: settings form')
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject(
    'plugins.bundle.config',
    () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: TAB_ID,
      inject: () => ({ settings }),
    }, SettingsPanel),
  )), 'dsh-browser: settings page')
}

/** Re-export the kind so other plugins can open this tab. */
export { TAB_KIND }
