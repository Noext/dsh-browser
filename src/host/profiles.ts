/**
 * Browser profile directories.
 *
 * A profile holds cookies, storage and the Chromium login database, so it is a
 * secret: created 0700, named by a hash so the path leaks neither the workspace
 * nor the Session id, and removable from the UI.
 * @module dsh-browser/host/profiles
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What a profile owner looks like to this module. */
export interface ProfileOwner {
  readonly id: string
  /** The Session's working directory, when the composition provides one. */
  readonly workspace?: { readonly cwd?: string }
}

/** Profile directory policy. */
export interface ProfileOptions {
  /** Keep profiles across restarts; false stores them under a temporary root. */
  readonly persistent: boolean
  /** Root directory; defaults to `$DSH_HOME/browser-profiles` or a temp directory. */
  readonly root?: string
}

/**
 * Key used when a deployment names no working directory.
 *
 * It must be stable across Sessions and restarts. The session id is the opposite
 * of stable: it changes with every new conversation, so keying on it gave each
 * Session an empty profile and silently discarded every cookie and login. One
 * shared profile is the honest default for a deployment that cannot name a
 * workspace, and it matches how a person expects "the browser" to behave.
 */
const FALLBACK_KEY = 'dsh-browser-default-profile'

/** Resolve and create per-owner profile directories. */
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
      const key = owner.workspace?.cwd ?? FALLBACK_KEY
      const digest = createHash('sha256').update(`${key}\u0000${options.persistent ? 'p' : 'e'}`).digest('hex').slice(0, 16)
      const directory = join(root, digest)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      // Adopt a profile written before this key became stable, so a sign-in that
      // already happened is not thrown away by the rename.
      adoptLegacyProfile(root, directory)
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

/**
 * Copy a legacy session-keyed profile into the stable directory.
 *
 * Releases before 0.4.2 keyed the profile on the session id, so a login was
 * stored under a directory nothing would ever look at again. Copying it forward
 * once is what keeps an existing sign-in usable instead of asking for it again.
 * @param root - the profile root.
 * @param target - the stable directory for this workspace or deployment.
 */
function adoptLegacyProfile(root: string, target: string): void {
  if (existsSync(join(target, 'chromium'))) return
  const marker = join(target, '.adopted')
  if (existsSync(marker)) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const candidate = join(root, entry)
    if (candidate === target) continue
    if (!existsSync(join(candidate, 'chromium'))) continue
    try {
      cpSync(candidate, target, { recursive: true })
      writeFileSync(marker, 'adopted\n')
    } catch {
      // A failed copy leaves the target empty, which is no worse than before.
    }
    return
  }
}

/** Default profile root, honouring DSH_HOME. */
function defaultRoot(persistent: boolean): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return persistent
    ? join(home, 'browser-profiles')
    : join(process.env.TMPDIR ?? '/tmp', 'dsh-browser-profiles')
}
