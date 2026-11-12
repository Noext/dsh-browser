/**
 * One page as the compact accessibility tree an agent can act on.
 *
 * Screenshots are expensive, slow, and hard to act on: the model has to guess
 * coordinates, and one wrong guess is a failed turn. A text tree with a stable
 * ref per element is cheaper and exact — `[ref=e12]` names one node, and the
 * ref can be clicked without any coordinate arithmetic.
 *
 * The format follows agent-browser: nested bullet lines, `role "name" [ref=eN]`,
 * interactive elements only by default. Refs are Chromium backend node ids, so
 * they survive a re-render but not a navigation; callers re-snapshot after either.
 * @module dsh-browser/host/snapshot
 */
import type { CdpConnection } from './cdp.ts'

/** One rendered line of the tree. */
export interface SnapshotLine {
  readonly depth: number
  readonly role: string
  readonly name: string
  readonly ref: string | undefined
}

/** A snapshot ready for the model. */
export interface Snapshot {
  readonly text: string
  /** Ref to backend node id, for resolving an action target. */
  readonly refs: ReadonlyMap<string, number>
  readonly url: string
  readonly title: string
  readonly nodeCount: number
  readonly truncated: boolean
}

/** Options that bound one snapshot. */
export interface SnapshotOptions {
  /** Keep only roles an agent can act on; defaults to true. */
  readonly interactiveOnly?: boolean
  /** Maximum characters of output; the tree is cut and marked truncated. */
  readonly maxChars?: number
  /** Maximum rendered lines. */
  readonly maxLines?: number
}

/** Roles an agent can act on. Static text is read from its parent instead. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'searchbox',
  'spinbutton', 'textfield', 'file', 'treeitem',
])

/** Roles that carry readable content even though nothing is clickable. */
const CONTENT_ROLES = new Set([
  'heading', 'paragraph', 'list', 'listitem', 'cell', 'columnheader', 'rowheader',
  'StaticText', 'RootWebArea', 'document', 'article', 'navigation', 'main', 'form', 'dialog',
])

/** Roles present in every page that only add noise. */
const SKIPPED_ROLES = new Set(['none', 'presentation', 'InlineTextBox', 'lineBreak'])

/**
 * Read the page's accessibility tree.
 * @param connection - the CDP connection carrying the page session.
 * @param sessionId - the flattened page session.
 * @param options - filtering and size bounds.
 * @returns the snapshot text and its ref table.
 */
export async function snapshotPage(
  connection: CdpConnection,
  sessionId: string,
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const interactiveOnly = options.interactiveOnly ?? true
  const maxChars = options.maxChars ?? 16_000
  const maxLines = options.maxLines ?? 400

  await connection.send('Accessibility.enable', {}, sessionId)
  const tree = await connection.send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree', {}, sessionId)
  const nodes = tree.nodes ?? []

  const byId = new Map<string, AxNode>()
  for (const node of nodes) byId.set(node.nodeId, node)

  const pageInfo = await connection.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: '({ url: location.href, title: document.title })',
    returnByValue: true,
  }, sessionId)
  const info = pageInfo.result?.value as { url?: string; title?: string } | undefined

  const lines: SnapshotLine[] = []
  const refs = new Map<string, number>()
  let truncated = false

  /** Whether a subtree hides anything interesting; a bare container is noise. */
  const hasUsefulDescendant = (node: AxNode, seen: Set<string> = new Set()): boolean => {
    if (seen.has(node.nodeId)) return false
    seen.add(node.nodeId)
    for (const child of node.childIds ?? []) {
      const next = byId.get(child)
      if (next === undefined) continue
      const role = next.role?.value ?? ''
      if (SKIPPED_ROLES.has(role)) continue
      if (INTERACTIVE_ROLES.has(role)) return true
      if (isUseful(next) || hasUsefulDescendant(next, seen)) return true
    }
    return false
  }

  const isUseful = (node: AxNode): boolean => {
    if (node.ignored === true) return false
    const role = node.role?.value ?? ''
    if (SKIPPED_ROLES.has(role)) return false
    const name = (node.name?.value ?? '').trim()
    if (INTERACTIVE_ROLES.has(role)) return true
    if (role === 'StaticText') return name.length > 0
    if (CONTENT_ROLES.has(role)) return name.length > 0 || hasUsefulDescendant(node)
    return name.length > 0
  }

  /**
   * Render one node and its descendants.
   *
   * Depth comes from this recursion, not from the raw accessibility depth: that
   * depth counts ignored wrappers, so a text node can appear nested under an
   * unrelated element. A skipped node passes its own depth to its children so
   * they are promoted instead of indented under nothing.
   */
  const render = (node: AxNode, depth: number): void => {
    if (lines.length >= maxLines) { truncated = true; return }
    const role = node.role?.value ?? 'unknown'
    const name = (node.name?.value ?? '').replace(/\s+/gu, ' ').trim()
    const interactive = INTERACTIVE_ROLES.has(role)
    const keep = isUseful(node)
    let rendered = false
    if (keep && (!interactiveOnly || interactive || CONTENT_ROLES.has(role))) {
      const ref = node.backendDOMNodeId === undefined ? undefined : `e${node.backendDOMNodeId}`
      if (ref !== undefined && node.backendDOMNodeId !== undefined) refs.set(ref, node.backendDOMNodeId)
      // StaticText under an element repeats that element's name; skip the echo.
      const parent = node.parentId === undefined ? undefined : byId.get(node.parentId)
      // A text node repeats the accessible name of the element that owns it;
      // the element's own line already carries that text.
      const echo = role === 'StaticText' && parent !== undefined
        && (parent.name?.value ?? '').trim() === name
      if (!echo && (interactive || name.length > 0)) {
        lines.push({ depth, role, name: name.slice(0, 160), ref: interactive ? ref : undefined })
        rendered = true
      }
    }
    for (const child of node.childIds ?? []) {
      const next = byId.get(child)
      if (next !== undefined) render(next, rendered ? depth + 1 : depth)
    }
  }

  const root = nodes.find((node) => (node.role?.value ?? '') === 'RootWebArea') ?? nodes[0]
  if (root !== undefined) render(root, 0)

  // Fold the flat depths into nested bullets, then apply the character cap.
  // Re-derive indentation from the rendered sequence: raw accessibility depth
  // counts ignored wrappers, which leaves lines nested under the wrong parent.
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const label = line.name === '' ? line.role : `${line.role} "${line.name}"`
    const text = `${'  '.repeat(line.depth)}- ${label}${line.ref === undefined ? '' : ` [ref=${line.ref}]`}`
    if (used + text.length > maxChars) { truncated = true; break }
    out.push(text)
    used += text.length + 1
  }

  return {
    text: out.join('\n'),
    refs,
    url: info?.url ?? '',
    title: info?.title ?? '',
    nodeCount: lines.length,
    truncated,
  }
}

/** The subset of a CDP accessibility node this module reads. */
interface AxNode {
  readonly nodeId: string
  readonly ignored?: boolean
  readonly role?: { value?: string }
  readonly name?: { value?: string }
  readonly parentId?: string
  readonly childIds?: readonly string[]
  readonly backendDOMNodeId?: number
}