/** Address handling and the human-request contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedAddress, normalizeAddress } from '../src/shared/protocol.ts'
import { createProfiles } from '../src/host/profiles.ts'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a bare host becomes https', () => {
  assert.equal(normalizeAddress('example.com'), 'https://example.com/')
  assert.equal(normalizeAddress('  example.com/path  '), 'https://example.com/path')
})

test('loopback services stay reachable on http', () => {
  assert.equal(normalizeAddress('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/')
  assert.equal(normalizeAddress('localhost:8080'), 'https://localhost:8080/')
})

test('non-http schemes and embedded credentials are refused', () => {
  assert.equal(normalizeAddress('file:///etc/passwd'), undefined)
  assert.equal(normalizeAddress('javascript:alert(1)'), undefined)
  assert.equal(normalizeAddress('data:text/html,x'), undefined)
  assert.equal(normalizeAddress('https://user:secret@example.com/'), undefined)
  assert.equal(normalizeAddress(''), undefined)
  assert.equal(isAllowedAddress('blob:https://example.com/x'), false)
})

test('profile directories are private and stable per workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-browser-test-'))
  try {
    const profiles = createProfiles({ persistent: true, root })
    const first = profiles.directoryFor({ id: 'session-a', workspace: { cwd: '/work/alpha' } })
    const again = profiles.directoryFor({ id: 'session-a', workspace: { cwd: '/work/alpha' } })
    const other = profiles.directoryFor({ id: 'session-b', workspace: { cwd: '/work/beta' } })
    assert.equal(first, again)
    assert.notEqual(first, other)
    assert.equal(statSync(first).mode & 0o777, 0o700)
    // The workspace path must not be recoverable from the directory name.
    assert.equal(first.includes('alpha'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clearing removes only the directories handed to that owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-browser-test-'))
  const profiles = createProfiles({ persistent: false, root })
  const a = profiles.directoryFor({ id: 'a', workspace: { cwd: '/one' } })
  const b = profiles.directoryFor({ id: 'b', workspace: { cwd: '/two' } })
  await profiles.clear('a')
  assert.equal(statSync(b).isDirectory(), true)
  assert.throws(() => statSync(a))
  rmSync(root, { recursive: true, force: true })
})
