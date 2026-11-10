# Changelog

## 0.2.2

### Changed

- `npm run typecheck` uses `tsconfig.dev.json`, which points at a sibling DSH
  checkout. The plain `tsconfig.json` no longer carries machine-specific paths.


### Fixed

- **Clicks landed away from the pointer.** The canvas kept the previous frame's
  backing size while CSS showed the new viewport, so the picture was stretched and
  a click hit where the stretched image appeared rather than where the page was.
  On a tall narrow pane this put the search box under the logo. The bitmap now
  follows the viewport in the same step, and frames are drawn into that fixed
  bitmap instead of resizing it. Measured against a grid fixture: 0 px error at
  five canvas positions, where a whole cell of drift came before.

## 0.2.1

### Added

- A settings page on the plugin's own page in **Plugins**: turn the Chromium
  window off to run headless, keep or drop the browser profile, choose the mirror
  quality, and set the takeover and idle-shutdown timeouts. Changes are written to
  the profile's patch and take effect on the next restart; nothing else has to be
  edited by hand.
- `GET /api/dsh-browser/status` reports `watching`, the number of windows
  mirroring the browser.

### Fixed

- Editable settings were declared with `.volatile()` but read as plain values,
  which turned the idle timeout into `NaN` and started Chromium with a window even
  when told not to. They are read through `get()` now.
- Number fields rendered their value in the surrounding text colour, which left
  them unreadable on the dark surface.

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