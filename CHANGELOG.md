# Changelog

## 0.2.0 — unreleased improvements

The version was never bumped while the first three commits landed, so this entry
covers everything since the plugin first ran. `0.1.0` was never tagged or
published.

### Added

- Idle reclamation: a browser nobody is watching closes itself after
  `idleTimeoutMs` (default 5 minutes). Agent activity, human input, and work in
  flight all defer it.
- Orphan adoption at startup: a profile whose `SingletonLock` names a live
  Chromium on this machine is reclaimed, so a `kill -9`'d Host no longer leaves
  windows behind or blocks its own next launch.
- `watching` in the status response reports how many windows mirror a browser.

### Changed

- The mirror is 1:1 with the pane: the page is emulated at the pane's CSS size
  (minimum 360×300) instead of being scaled down, so clicks land where they look.
- A failed browser is no longer cached, so the next open retries instead of
  reporting a disposed session forever.
- Browsers are closed when the Host shuts down.

### Fixed

- A stale `DevToolsActivePort` from a previous run was read before Chromium
  rewrote it, and its port was already dead.
- `Page.startScreencast` was called before a fresh target committed its first
  navigation.
- Two viewport updates in flight could stop the screencast twice and start it
  once.
- "Done — hand back" only resolved the Agent's pending request, so a takeover the
  Agent had not asked for was never released.
- `SingletonLock` is a dangling symlink, which `existsSync` reports as absent.

### Tests

- The end-to-end checks never drove the UI: a coordinate-based click hit the
  Preview Notice mask, and the failure surfaced later as "target closed". They now
  dismiss the notice and use accessible names.
- Every check cleans up the browser it starts, including when an assertion fails.
