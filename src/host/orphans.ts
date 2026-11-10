/**
 * Reclaiming browsers a previous Host left behind.
 *
 * Chromium survives its parent. When the Host is killed (a crash, `kill -9`, a
 * container restart) its browsers keep running: they hold the profile lock, and
 * on a desktop they leave windows the user has to close by hand. Chromium records
 * the owning process in `SingletonLock` as `<hostname>-<pid>`, so a new Host can
 * find and adopt them.
 * @module dsh-browser/host/orphans
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

/** What an adoption pass did, for logging and tests. */
export interface OrphanSweep {
  /** Profile directories inspected. */
  readonly scanned: number
  /** Browsers that were still running and killed. */
  readonly killed: readonly number[]
  /** Profile directories whose lock named a dead or foreign process, and were cleaned. */
  readonly stale: readonly string[]
}

/**
 * Whether a path exists, including a dangling symlink.
 *
 * Chromium makes `SingletonLock` a symlink to `<hostname>-<pid>`, which never
 * resolves to a real file, so `existsSync` reports `false` for a lock that is
 * very much there. `lstat` answers for the link itself.
 * @param path - path to test.
 * @returns true when the directory entry exists.
 */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Whether a process with this id exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to another user; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Read the pid Chromium recorded in a profile's lock.
 * @param profileDir - profile root that may contain `SingletonLock`.
 * @returns the pid, or `undefined` when the lock is absent or unreadable.
 */
export function lockOwner(profileDir: string): number | undefined {
  const lock = join(profileDir, 'SingletonLock')
  if (!present(lock)) return undefined
  try {
    // Chromium makes it a symlink whose target is "<hostname>-<pid>".
    const match = /-(\d+)$/u.exec(readlinkSync(lock))
    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

/**
 * Kill browsers a previous Host owned, and clean the profile locks they left.
 *
 * Only browsers on this machine are adopted: a lock naming another hostname is
 * left alone, because its process id could belong to anything local.
 * @param root - directory holding one subdirectory per profile.
 * @returns what the pass found.
 */
export async function adoptOrphans(root: string): Promise<OrphanSweep> {
  if (!existsSync(root)) return { scanned: 0, killed: [], stale: [] }
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return { scanned: 0, killed: [], stale: [] }
  }

  const killed: number[] = []
  const stale: string[] = []
  let scanned = 0

  for (const entry of entries) {
    const profileDir = join(root, entry, 'chromium')
    if (!existsSync(profileDir)) continue
    scanned++
    const lock = join(profileDir, 'SingletonLock')
    if (!present(lock)) continue

    const target = (() => {
      try {
        return readlinkSync(lock)
      } catch {
        return ''
      }
    })()
    const [lockHost, lockPidText] = (() => {
      const index = target.lastIndexOf('-')
      return index < 0 ? ['', ''] : [target.slice(0, index), target.slice(index + 1)]
    })()
    const pid = Number(lockPidText)

    if (lockHost !== hostname() || !Number.isInteger(pid) || pid <= 0) {
      // A foreign or unreadable lock cannot be adopted; clearing it lets the next
      // launch fail loudly instead of waiting on a lock nobody owns.
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        rmSync(join(profileDir, name), { force: true })
      }
      stale.push(profileDir)
      continue
    }

    if (alive(pid) && isChromium(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
        killed.push(pid)
      } catch {
        // Already gone between the check and the signal.
      }
    }
    // The lock is stale either way: its owner is gone, or we just ended it.
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      rmSync(join(profileDir, name), { force: true })
    }
    stale.push(profileDir)
  }

  return { scanned, killed, stale }
}

/**
 * Whether a pid looks like the Chromium we launched.
 *
 * A recycled pid must never be shot: the profile lock outlives the process, so a
 * stale lock can name an unrelated program.
 * @param pid - process to inspect.
 * @returns true only when its command line names a Chromium binary.
 */
function isChromium(pid: number): boolean {
  try {
    // Linux only; elsewhere the process is left alone rather than guessed at.
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return /chrome|chromium/iu.test(command)
  } catch {
    return false
  }
}
