/** The handover contract: exactly one party may drive, and expiry is not a crash. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ControlMachine } from '../src/shared/control.ts'

const machine = (humanIdleMs = 1000): ControlMachine => new ControlMachine({ humanIdleMs })

test('a fresh browser is idle and open to the agent', () => {
  const control = machine()
  assert.equal(control.current.state, 'idle')
  assert.equal(control.allowsAgent(0), true)
  assert.equal(control.allowsHuman(0), false)
})

test('claiming for the agent is idempotent and blocks human input', () => {
  const control = machine()
  assert.equal(control.claimAgent(10).changed, true)
  assert.equal(control.claimAgent(20).changed, false)
  assert.equal(control.allowsAgent(20), true)
  assert.equal(control.allowsHuman(20), false)
})

test('a human takeover displaces the agent and reports it', () => {
  const control = machine()
  control.claimAgent(0)
  const transition = control.claimHuman(5)
  assert.equal(transition.changed, true)
  assert.equal(transition.before.state, 'agent')
  assert.equal(transition.after.state, 'human')
  assert.equal(control.allowsAgent(5), false)
  assert.equal(control.allowsHuman(5), true)
})

test('the human lease lapses after the idle window', () => {
  const control = machine(1000)
  control.claimHuman(0)
  assert.equal(control.allowsHuman(999), true)
  assert.equal(control.allowsHuman(1000), false)
  assert.equal(control.allowsAgent(1000), true)
})

test('observed input extends the lease', () => {
  const control = machine(1000)
  control.claimHuman(0)
  assert.equal(control.touch(900), true)
  assert.equal(control.allowsHuman(1500), true)
  assert.equal(control.allowsHuman(1901), false)
})

test('an idle window of zero never expires', () => {
  const control = machine(0)
  control.claimHuman(0)
  assert.equal(control.touch(100), false)
  assert.equal(control.allowsHuman(Number.MAX_SAFE_INTEGER), true)
})

test('expiry reports a transition exactly once', () => {
  const control = machine(100)
  control.claimHuman(0)
  assert.equal(control.expire(50), undefined)
  const transition = control.expire(200)
  assert.equal(transition?.after.state, 'agent')
  assert.equal(control.expire(300), undefined)
})

test('releasing returns the browser to the agent', () => {
  const control = machine(1000)
  control.claimHuman(0)
  assert.equal(control.release(10).changed, true)
  assert.equal(control.allowsAgent(10), true)
  assert.equal(control.release(20).changed, false)
})
