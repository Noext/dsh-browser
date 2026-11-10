/**
 * Browser profile directories.
 *
 * A profile holds cookies, storage and the Chromium login database, so it is a
 * secret: created 0700, named by a hash so the path leaks neither the workspace
 * nor the Session id, and removable from the UI.
 * @module dsh-browser/host/profiles
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What a profile owner looks like to this module. */
export interface ProfileOwner {
  readonly id: string
  readonly workspace?: { readonly cwd?: string }
}

/** Profile directory policy. */
export interface ProfileOptions {
  /** Keep profiles across restarts; false stores them under a temporary root. */
  readonly persistent: boolean
  /** Root directory; defaults to `$DSH_HOME/browser-profiles` or a temp directory. */
  readonly root?: string
}

/** Resolve and create per-Session profile directories. */
export function createProfiles(options: ProfileOptions) {
  const root = options.root ?? defaultRoot(options.persistent)
  /** Directories handed out, so a clear affects exactly what this Host created. */
  const issued = new Map<string, Set<string>>()
  return {
    /** Root under which every profile lives; shown in the UI. */
    root,
    /**
     * Profile directory for one Agent.
     * @param owner - the Agent whose browser this profile belongs to.
     * @returns an existing, 0700 directory.
     */
    directoryFor(owner: ProfileOwner): string {
      const key = owner.workspace?.cwd ?? owner.id
      const digest = createHash('sha256').update(`${key}\u0000${options.persistent ? 'p' : 'e'}`).digest('hex').slice(0, 16)
      const directory = join(root, digest)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const forOwner = issued.get(owner.id) ?? new Set<string>()
      forOwner.add(directory)
      issued.set(owner.id, forOwner)
      return directory
    },
    /**
     * Remove the profiles handed out to one Agent.
     * @param agentId - the Agent whose directories to delete.
     */
    async clear(agentId: string): Promise<void> {
      const directories = issued.get(agentId)
      if (directories === undefined) return
      for (const directory of directories) rmSync(directory, { recursive: true, force: true })
      issued.delete(agentId)
    },
    /** Remove the entire profile root, for an explicit "forget everything" action. */
    async clearAll(): Promise<void> {
      rmSync(root, { recursive: true, force: true })
      issued.clear()
    },
  }
}

/** Default profile root, honouring DSH_HOME. */
function defaultRoot(persistent: boolean): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return persistent
    ? join(home, 'browser-profiles')
    : join(process.env.TMPDIR ?? '/tmp', 'dsh-browser-profiles')
}
