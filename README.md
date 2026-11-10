# dsh-browser

A real Chromium in the DSH right sidebar: the agent drives it, and you take over
whenever a step needs a human — logging in, a 2FA code, a captcha.

```
agent tools ──▶ ┌─────────────────────────────┐
                │ Host: one Chromium/Session  │
                │  CDP ── Page.startScreencast│──▶ JPEG frames ──▶ canvas
                │  CDP ◀─ Input.*             │◀── pointer / keys ─┘
                └─────────────────────────────┘
```

Both parties drive **the same browser, the same profile, the same cookies**. That
is what makes the handover useful: you sign in, hand back, and the agent carries
on in an authenticated page. Your password goes straight to Chromium and never
enters the model context, the Session log, or a screenshot.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-browser
dsh --profile web
```

Open the right sidebar, pick **Browser**, and type an address. Or ask the agent:
"open example.com and tell me what the page says".

Chromium is discovered from `DSH_BROWSER_EXECUTABLE`, then Playwright's cache
(`npx playwright install chromium`), then common system paths. Set
`executablePath` to pin it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `executablePath` | discovered | Chromium executable |
| `headed` | `true` | Show the window on the Host display; `false` uses headless |
| `persistentProfile` | `true` | Keep cookies and logins in `$DSH_HOME/browser-profiles` |
| `width`, `height` | `1280`, `800` | Initial viewport |
| `quality` | `62` | JPEG quality of the mirror |
| `maxSessions` | `2` | Concurrent browsers on one Host |
| `humanIdleMs` | `600000` | A human takeover lapses after this long idle |
| `idleTimeoutMs` | `300000` | Close a browser with no viewer and no activity |
| `startUrl` | `about:blank` | What a new browser opens |
| `chromiumArgs` | — | Extra Chromium switches |

```yaml
- id: dsh-browser
  config:
    headed: false
    idleTimeoutMs: 120000
```

## Tools the agent gets

| Tool | Purpose |
|---|---|
| `browser_open` | Open an address and return the page text |
| `browser_read` | Read the visible text of the current page |
| `browser_click` | Click a CSS selector or a point |
| `browser_type` | Insert text, optionally submitting |
| `browser_press` | Press one key (`Enter`, `Tab`, arrows…) |
| `browser_screenshot` | Capture a PNG as a durable image |
| `browser_navigate` | Back, forward, or reload |
| `browser_tabs` | List, select, create, or close tabs |
| `browser_request_human` | Ask a human to take over, and wait for the handback |

Every tool fails with an actionable message while a human holds the browser:
`a human is controlling the side-panel browser; wait for them to hand it back`.

## The handover

One lease, three states:

- **idle** — nobody is driving.
- **agent** — the agent's tools run freely.
- **human** — a monotonic guard refuses every `browser_*` tool, your input is
  forwarded, and the pane shows **You are driving**.

Press **Take control** in the toolbar to take the browser, **Done — hand back** to
return it. When the agent calls `browser_request_human`, the tab shows a banner
with its reason and the tool call stays blocked until you hand back, time out, or
the call is cancelled.

A takeover without clicks lapses after `humanIdleMs`, so a forgotten tab cannot
lock the agent out forever.

## Why it looks like this

- **A screencast, not an iframe.** `X-Frame-Options` and `frame-ancestors` block
  most login pages inside an iframe, and an iframe cannot be driven by CDP. Frames
  travel as binary websocket messages and input comes back over the same socket.
  Because no page HTML ever enters DSH's DOM, a visited site cannot reach the
  harness.
- **Exact Fetch routes and one upgrade**, not Typert Remotes. Generated Remotes
  exist only for packages inside the DSH monorepo, and the Remote stream format
  carries no binary. The upgrade reuses Connection's browser authentication
  (`requestContext(request)`), so a request without the DSH cookie gets 401.
- **A Chromium per Session**, keyed by the live Agent. Two Sessions never share
  cookies; disposal closes the browser.
- **The mirror is 1:1 with the pane.** The page is emulated at the pane's CSS size
  (at least 360×300) instead of being scaled, so the coordinates you click are the
  coordinates the page sees.

## Security

The browser has **free network access, independent of the DSH sandbox**: an agent
tool can reach anything Chromium can reach. Treat `browser_*` like shell access.

- The profile directory holds live cookies. It is created `0700`, named by a hash
  so the path leaks neither workspace nor Session, and **Clear profile** in the
  toolbar deletes it.
- No keystrokes are logged. Screenshots and `browser_read` are refused while a
  human holds the takeover, and no tool reads `<input type="password">` values.
- The CDP endpoint binds a random loopback port and is never advertised.
- Chromium runs with `--no-sandbox` when the Host runs as root, because Chromium
  refuses to start otherwise; the profile directory, not the renderer sandbox, is
  the isolation boundary here.

## Known limits

- Chromium only. Firefox and WebKit are not supported.
- Browser history, page memory, and unsaved forms do not survive a Host restart;
  cookies do, when `persistentProfile` is on.
- Reserved browser shortcuts (`Cmd+Q`, `Ctrl+N`) cannot be forwarded from a page.
- A modal dialog is auto-accepted; the mirror cannot show it.
- Only one screencast consumer per tab: a second window showing the same Session
  receives `viewer-taken`. (Not enforced yet — the last viewer wins.)
- The screencast is JPEG, so text is softer than native. Lower `quality` for speed,
  raise it for legibility.

## Development

```sh
node scripts/build.mjs          # lib/index.js (Host) + lib/client.js (browser)
npx tsc --noEmit -p tsconfig.json
node --experimental-strip-types --test tests/*.test.ts
node --experimental-strip-types tests/agent-tools.ts   # real Chromium
node --experimental-strip-types tests/idle-reclaim.ts   # no orphaned browsers
```

`spike/` holds the throwaway harness that measured the approach before the plugin
existed: raw screencast throughput (60 fps headless, 90 fps headed), 111 KiB per
frame while scrolling a real page, and 30 ms keystroke-to-frame latency.
