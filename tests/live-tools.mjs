/**
 * Register the plugin's tools into a real ToolsService.
 *
 * defineTool is what rejects a bad schema, and a throw inside registerTools
 * loses every browser tool at once. This runs the real definitions through the
 * real compiler so that failure cannot reach a user.
 * @module tests/live-tools
 */
import { Context } from '@deepseek-ai/cordis'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { registerTools } from '../src/host/tools.ts'

const ctx = new Context()
// ToolsService injects systemPrompt, so it must be mounted first.
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolsService)

const registered = []
const original = ctx.tools.register.bind(ctx.tools)
ctx.tools.register = (definition) => { registered.push(definition.name); return original(definition) }

registerTools(ctx, {
  log: { debug() {}, info() {}, warn() {}, error() {} },
  config: { startUrl: 'about:blank' },
  getSession: () => { throw new Error('unused') },
  requireSession: () => { throw new Error('unused') },
  executableAvailable: () => true,
})

const visible = ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith('browser_'))
console.log('registered:', registered.length, '|', registered.join(', '))
console.log('visible to the model:', visible.length)

if (registered.length !== 10) { console.error('expected 10 tools, got', registered.length); process.exit(1) }
if (visible.length !== 10) { console.error('only', visible.length, 'visible'); process.exit(1) }
console.log('all ten browser tools register and are model-visible')