# Changelog

## 0.3.0

### Added

- **`browser_snapshot`: read a page as an accessibility tree with refs.** The
  agent used to read raw `innerText` and click by CSS selector or coordinates,
  which meant guessing where something was. `browser_snapshot` returns the
  compact tree used by agent-browser — `button "Submit" [ref=e12]` — and
  `browser_click` and `browser_type` accept that ref. A ref is exact, cheap, and
  re-read after every navigation; a stale ref is refused instead of landing on
  whatever occupies that spot now.
- A refused action explains itself: hidden, disabled, or covered by a consent
  banner, rather than reporting a click that did nothing.

### Changed

- Screenshots are no longer the way to read a page. The tree is the default;
  `browser_screenshot` remains for visual checks the tree cannot express.

## 0.2.6

### Fixed

- **Google still refused to sign in after the User-Agent fix.** Sign-in
  providers read more than the UA string. Headless Chromium also exposed
  `navigator.webdriver === true` and sent `sec-ch-ua` branding itself as
  "Chromium" rather than "Google Chrome"; either is enough to refuse an account
  login. The launcher disables the automation flag, and each page now carries a
  CDP identity override that sets the User-Agent, its client hints, and the
  metadata they derive from. `tests/google-signin.ts` submits a throwaway
  identifier through a real session and fails if Google refuses.

## 0.2.5

### Fixed

- **A browser that died left the session claiming it was healthy.** Nothing
  observed the CDP socket ending, so `ensureStarted` kept answering "ready" and
  every tool failed with "the browser connection closed" until the Host was
  restarted. The connection now reports its own end, the session resets to a
  retryable failure, and the next call launches a fresh browser with a new tab.
  `tests/connection-loss.ts` kills Chromium from outside and requires the session
  to recover and run a command again.

## 0.2.4

### Fixed

- **Every browser tool was missing after an upgrade.** The tool definitions set
  `required` inside their output schemas, and DSH's value-schema DSL accepts
  `required` only in parameter schemas. `defineTool` threw on the first
  definition, which aborted `registerTools` and silently dropped all nine tools,
  so the agent had no `browser_open` and the sidebar still worked. The output
  schemas no longer declare it; `tests/live-tools.mjs` now registers the real
  definitions against a real `ToolsService` and fails if any tool is lost.
- **Google refused to sign in.** Headless Chromium reports `HeadlessChrome` in
  its User-Agent, which Google answers with "this browser or app may not be
  secure". Headless now presents the matching Chrome User-Agent;
  `tests/google-signin.mjs` checks both modes against the live sign-in page.

## 0.2.3

### Fixed

- **The first resize was dropped, so the page kept a padded viewport.** Input
  frames were only routed after Chromium finished starting, which takes seconds,
  and the viewer measures the pane during exactly that window. The page stayed at
  1280×800 inside a 674×897 pane, so the mirror was stretched and every click
  landed away from the pointer — the search box under the logo. Frames that
  arrive during startup are now buffered and replayed in order.
  Measured against a grid fixture: 0 px error at five canvas positions.
- A second, empty tab no longer opens beside the real one: the tab is created by
  whichever party needs it first, instead of eagerly at startup.

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