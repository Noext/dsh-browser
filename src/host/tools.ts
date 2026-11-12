/**
 * The model-facing browser tools.
 *
 * Every tool takes the same first step: ask the session whether the Agent still
 * holds the browser. A human takeover therefore fails closed with an actionable
 * message instead of silently interleaving with a person's typing.
 * @module dsh-browser/host/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { normalizeAddress } from '../shared/protocol.ts'
import type { BrowserSession } from './session.ts'
import type { Log } from './log.ts'

/** What the tool group needs from the Host plugin. */
export interface ToolDeps {
  readonly log: Log
  readonly config: { readonly startUrl: string }
  readonly getSession: (agent: Agent) => BrowserSession
  readonly requireSession: (agentId: string) => BrowserSession
  readonly executableAvailable: () => boolean
}

/** Refusal text used by every tool when the human is driving. */
const HUMAN_CONTROL = 'the human is controlling this browser; ask them to hand it back, then retry'

/** Max page text returned to the model, in characters. */
const MAX_TEXT = 20_000

/** Register every browser tool for this plugin's lifetime. */
export function registerTools(ctx: Context, deps: ToolDeps): void {
  /** Resolve the calling Agent's session and claim it for the Agent. */
  const claim = async (agent: Agent | undefined, signal: AbortSignal): Promise<BrowserSession> => {
    if (agent === undefined) throw new Error('browser tools must run inside a Session')
    if (!deps.executableAvailable()) {
      throw new Error('no Chromium executable is available: set dsh-browser executablePath, or set DSH_BROWSER_EXECUTABLE, or run "npx playwright install chromium"')
    }
    const session = deps.getSession(agent)
    await session.claimAgent(signal)
    if (!session.allowsAgent) throw new Error(HUMAN_CONTROL)
    return session
  }

  const view = (session: BrowserSession) => {
    const active = session.activeView
    if (active === undefined) throw new Error('the browser has no open tab')
    return active
  }

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open the side-panel browser on an HTTP(S) address and return the page it loaded.',
    parameters: {
      url: { type: 'string', required: true, description: 'HTTP(S) address, or a bare host name' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `${value.title}\n${value.url}\n\n${value.text}` }],
    },
    async execute(args, exec) {
      const url = normalizeAddress(args.url)
      if (url === undefined) throw new Error('url must be an http or https address')
      const session = await claim(exec.agent, exec.signal)
      const active = session.activeView ?? await session.createView(url)
      await active.navigate(url)
      const page = await waitForLoad(active, exec.signal)
      return { url: page.url, title: page.title, text: page.text, truncated: page.truncated }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_read',
    description: 'Read the visible text of the page in the side-panel browser.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `${value.title}\n${value.url}\n\n${value.text}` }],
    },
    async execute(_args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const page = await view(session).readText(MAX_TEXT)
      return { url: page.url, title: page.title, text: page.text, truncated: page.truncated }
    },
  }))

ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Read the page as a compact accessibility tree. Each interactive element gets a ref like [ref=e12]; pass that ref to browser_click, browser_type or browser_check. This is the normal way to look at a page: it is exact, cheap, and needs no coordinates.',
    parameters: {
      interactive: { type: 'boolean', description: 'Only actionable elements; defaults to true' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          tree: { type: 'string' },
          elements: { type: 'number' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.title}\n${value.url}\n\n${value.tree}${value.truncated ? '\n(tree truncated)' : ''}`,
      }],
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const active = view(session)
      const snapshot = await active.snapshot({ interactiveOnly: args.interactive !== false })
      return {
        url: snapshot.url,
        title: snapshot.title,
        tree: snapshot.text,
        elements: snapshot.refs.size,
        truncated: snapshot.truncated,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element from browser_snapshot, or a CSS selector, or a point.',
    parameters: {
      ref: { type: 'string', description: 'Ref from browser_snapshot, for example e12' },
      selector: { type: 'string', description: 'CSS selector of the element to click' },
      x: { type: 'number', description: 'Page x coordinate, when no selector is given' },
      y: { type: 'number', description: 'Page y coordinate, when no selector is given' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          clicked: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `clicked ${value.clicked} → ${value.url}` }],
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const active = view(session)
      if (args.ref !== undefined) {
        const result = await active.clickRef(args.ref)
        const page = await active.readText(400)
        return { clicked: result.detail || args.ref, url: page.url, title: page.title }
      }
      if (args.selector !== undefined) {
        const result = await active.clickSelector(args.selector)
        const page = await active.readText(400)
        return { clicked: result.text || args.selector, url: page.url, title: page.title }
      }
      if (args.x === undefined || args.y === undefined) throw new Error('give a selector, or both x and y')
      await active.mouse({ type: 'move', x: args.x, y: args.y, button: 0, clickCount: 0, modifiers: 0 })
      await active.mouse({ type: 'down', x: args.x, y: args.y, button: 0, clickCount: 1, modifiers: 0 })
      await active.mouse({ type: 'up', x: args.x, y: args.y, button: 0, clickCount: 1, modifiers: 0 })
      const page = await active.readText(400)
      return { clicked: `(${args.x}, ${args.y})`, url: page.url, title: page.title }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an element from browser_snapshot, or the focused field, and optionally press Enter.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to insert' },
      ref: { type: 'string', description: 'Ref from browser_snapshot, for example e12' },
      selector: { type: 'string', description: 'CSS selector of the field to focus first' },
      submit: { type: 'boolean', description: 'Press Enter after typing' },
    },
    output: {
      schema: { type: 'object', properties: { typed: { type: 'boolean' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.typed ? 'typed' : 'nothing typed' }],
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const active = view(session)
      if (args.ref !== undefined) {
        await active.focusRef(args.ref)
      } else if (args.selector !== undefined) {
        await active.clickSelector(args.selector)
      }
      await active.insertText(args.text)
      if (args.submit === true) {
        await active.key({ type: 'down', key: 'Enter', code: 'Enter', vk: 13, text: '\r', modifiers: 0 })
        await active.key({ type: 'up', key: 'Enter', code: 'Enter', vk: 13, modifiers: 0 })
      }
      return { typed: args.text.length > 0 }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: 'Press one key, such as Enter, Tab, Escape, or a named arrow key.',
    parameters: {
      key: { type: 'string', required: true, description: 'DOM key value, for example Enter or ArrowDown' },
    },
    output: {
      schema: { type: 'object', properties: { pressed: { type: 'string' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `pressed ${value.pressed}` }],
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const active = view(session)
      const spec = KEY_SPECS[args.key] ?? FLAT_KEY(args.key)
      await active.key({ type: 'down', ...spec, modifiers: 0 })
      await active.key({ type: 'up', ...spec, modifiers: 0 })
      return { pressed: args.key }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the visible page in the side-panel browser as an image.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: { mediaType: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, url: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `captured ${value.width}×${value.height} PNG of ${value.url}` }],
    },
    async execute(_args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const active = view(session)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('screenshots need the attachment service, which this composition does not mount')
      const png = await active.screenshot()
      const limits = attachments.imageLimits
      if (!limits.mediaTypes.includes('image/png')) throw new Error('this deployment does not admit PNG images')
      const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: 'browser-screenshot.png' })
      return { mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, url: active.currentUrl }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List the browser tabs, or select, create, or close one.',
    parameters: {
      action: { type: 'string', enum: ['list', 'select', 'create', 'close'], required: true },
      viewId: { type: 'string', description: 'Tab id for select or close' },
      url: { type: 'string', description: 'Address for create' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          views: {
            type: 'array',
            items: {
              type: 'object',
              properties: { viewId: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' } },
              additionalProperties: false,
            },
          },
          activeViewId: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.views ?? []).map((entry) => `${entry.viewId === value.activeViewId ? '*' : ' '} ${entry.viewId} ${entry.title} — ${entry.url}`).join('\n') || 'no tabs',
      }],
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal)
      if (args.action === 'create') {
        const url = args.url === undefined ? 'about:blank' : normalizeAddress(args.url)
        if (url === undefined) throw new Error('url must be an http or https address')
        await session.createView(url)
      } else if (args.action === 'select') {
        if (args.viewId === undefined) throw new Error('select needs a viewId')
        await session.selectView(args.viewId)
      } else if (args.action === 'close') {
        if (args.viewId === undefined) throw new Error('close needs a viewId')
        await session.closeView(args.viewId)
      }
      const snapshot = session.snapshot()
      return {
        views: snapshot.views.map((entry) => ({ viewId: entry.viewId, url: entry.url, title: entry.title })),
        ...(snapshot.activeViewId === undefined ? {} : { activeViewId: snapshot.activeViewId }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Go back, forward, or reload in the side-panel browser.',
    parameters: {
      action: { type: 'string', enum: ['back', 'forward', 'reload'], required: true },
    },
    output: {
      schema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `now at ${value.url}` }],
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const active = view(session)
      if (args.action === 'back') await active.back()
      else if (args.action === 'forward') await active.forward()
      else await active.reload()
      const page = await waitForLoad(active, exec.signal)
      return { url: page.url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_request_human',
    description: 'Ask the human to take over the side-panel browser — to sign in, clear a captcha, or approve something — and wait until they hand control back.',
    parameters: {
      reason: { type: 'string', required: true, description: 'What the human needs to do, in one sentence' },
      timeoutSeconds: { type: 'number', description: 'How long to wait; defaults to the deployment timeout' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['released', 'timeout', 'cancelled'] },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'released'
          ? `the human finished and handed the browser back; the page is now "${value.title}" (${value.url})`
          : value.outcome === 'timeout' ? 'the human did not respond in time' : 'the request was cancelled',
      }],
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal)
      const active = view(session)
      const outcome = await session.requestHuman(args.reason, args.timeoutSeconds ?? 600, exec.signal)
      const page = await active.readText(300)
      return { outcome, url: page.url, title: page.title }
    },
  }))
}

/** Key descriptions for {@link browser_press}. */
const KEY_SPECS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
}

/** Describe a single printable character as a key event. */
function FLAT_KEY(key: string): { key: string; code: string; vk: number; text?: string } {
  const single = key.length === 1
  const vk = single ? key.toUpperCase().charCodeAt(0) : 0
  return { key, code: single ? `Key${key.toUpperCase()}` : key, vk, ...(single ? { text: key } : {}) }
}

/** Wait until the document reports itself settled, or the deadline passes. */
async function waitForLoad(view: { isLoading: boolean; readText: (max: number) => Promise<{ url: string; title: string; text: string; truncated: boolean }> }, signal: AbortSignal): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
  const deadline = Date.now() + 10_000
  while (view.isLoading && Date.now() < deadline && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return await view.readText(MAX_TEXT)
}