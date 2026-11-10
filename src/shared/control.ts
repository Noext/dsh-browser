/**
 * Pure control-state machine: who may drive the browser, and for how long.
 *
 * Kept free of I/O and timers so the whole handover contract is testable with
 * plain values. The Host owns the clock and calls {@link ControlMachine}'s
 * methods; the Client only renders the resulting state.
 * @module dsh-browser/control
 */
import type { ControlState } from './protocol.ts'

/** One party's claim on the browser. */
export interface Lease {
  readonly state: ControlState
  readonly holder: 'agent' | 'human' | undefined
  /** Epoch milliseconds, or `undefined` for an unbounded claim. */
  readonly expiresAt: number | undefined
}

/** Result of a transition that a caller must act on. */
export interface Transition {
  readonly before: Lease
  readonly after: Lease
  /** True when the lease actually changed hands or state. */
  readonly changed: boolean
}

/** Options that bound a human takeover. */
export interface ControlOptions {
  /** Idle time after which a human claim lapses; `0` disables expiry. */
  readonly humanIdleMs: number
}

/** The idle lease: nobody holds the browser. */
export const IDLE: Lease = { state: 'idle', holder: undefined, expiresAt: undefined }

/**
 * Owns the single-writer invariant: at most one party may send browser input or
 * run browser tools at a time.
 */
export class ControlMachine {
  private lease: Lease = IDLE
  private readonly options: ControlOptions

  constructor(options: ControlOptions) {
    this.options = options
  }

  /** Current lease. */
  get current(): Lease {
    return this.lease
  }

  /** Whether browser tools may run now. */
  allowsAgent(now: number): boolean {
    const lease = this.effective(now)
    return lease.state === 'idle' || lease.state === 'agent'
  }

  /** Whether human input may be forwarded now. */
  allowsHuman(now: number): boolean {
    return this.effective(now).state === 'human'
  }

  /**
   * Claim the browser for the Agent.
   * @param now - current epoch milliseconds.
   * @param reason - diagnostic label for the transition.
   * @returns the transition, telling the caller whether a human was displaced.
   */
  claimAgent(now: number): Transition {
    const before = this.effective(now)
    if (before.state === 'agent') return { before, after: before, changed: false }
    this.lease = { state: 'agent', holder: 'agent', expiresAt: undefined }
    return { before, after: this.lease, changed: true }
  }

  /**
   * Claim the browser for the human, displacing the Agent.
   * @param now - current epoch milliseconds.
   * @returns the transition; `before.state === 'agent'` means the Agent was interrupted.
   */
  claimHuman(now: number): Transition {
    const before = this.effective(now)
    this.lease = {
      state: 'human',
      holder: 'human',
      expiresAt: this.options.humanIdleMs > 0 ? now + this.options.humanIdleMs : undefined,
    }
    return { before, after: this.lease, changed: before.state !== 'human' }
  }

  /**
   * Give the browser back to the Agent, or to idle.
   * @param now - current epoch milliseconds.
   * @returns the transition.
   */
  release(now: number): Transition {
    const before = this.effective(now)
    this.lease = { state: 'agent', holder: 'agent', expiresAt: undefined }
    return { before, after: this.lease, changed: before.state !== 'agent' }
  }

  /**
   * Extend a human lease after observed input, so an active user is never cut off.
   * @param now - current epoch milliseconds.
   * @returns true when the lease was extended.
   */
  touch(now: number): boolean {
    const lease = this.effective(now)
    if (lease.state !== 'human' || this.options.humanIdleMs <= 0) return false
    this.lease = { ...lease, expiresAt: now + this.options.humanIdleMs }
    return true
  }

  /**
   * Drop an expired human lease.
   * @param now - current epoch milliseconds.
   * @returns the transition when expiry changed the state.
   */
  expire(now: number): Transition | undefined {
    const before = this.lease
    if (before.state !== 'human' || before.expiresAt === undefined || now < before.expiresAt) return undefined
    this.lease = { state: 'agent', holder: 'agent', expiresAt: undefined }
    return { before, after: this.lease, changed: true }
  }

  /** Treat an expired lease as already released. */
  private effective(now: number): Lease {
    if (this.lease.state === 'human' && this.lease.expiresAt !== undefined && now >= this.lease.expiresAt) {
      return { state: 'agent', holder: 'agent', expiresAt: undefined }
    }
    return this.lease
  }
}
