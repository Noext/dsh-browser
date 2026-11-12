/** dsh-browser host half v0.3.0 */

// src/host/index.ts
import Schema from "@deepseek-ai/schemastery";
import { WebSocketServer } from "ws";

// src/shared/protocol.ts
var ROUTE_STATUS = "/api/dsh-browser/status";
var ROUTE_VIEWS = "/api/dsh-browser/views";
var ROUTE_PROFILE = "/api/dsh-browser/profile";
var WS_PATH = "/api/dsh-browser/ws";
var FRAME_MAGIC = 1;
var FRAME_HEADER_BYTES = 5;
function isAllowedAddress(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return url.hostname !== "";
}
function normalizeAddress(input) {
  const trimmed = input.trim();
  if (trimmed === "") return void 0;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!isAllowedAddress(candidate)) return void 0;
  return new URL(candidate).href;
}

// src/host/launcher.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// src/host/cdp.ts
import { WebSocket } from "ws";
var CdpError = class extends Error {
  name = "CdpError";
  method;
  constructor(method, message2) {
    super(`${method}: ${message2}`);
    this.method = method;
  }
};
var CdpClosedError = class extends Error {
  name = "CdpClosedError";
  constructor() {
    super("the browser connection closed");
  }
};
var CdpConnection = class {
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  closeListeners = /* @__PURE__ */ new Set();
  closeError;
  closed = false;
  transport;
  constructor(transport) {
    this.transport = transport;
    transport.on("message", (data) => {
      this.receive(typeof data === "string" ? data : data.toString("utf8"));
    });
    transport.on("close", () => {
      this.failAll(new CdpClosedError());
    });
    transport.on("error", (error) => {
      this.failAll(error);
    });
  }
  /** Whether the underlying socket is still usable. */
  get open() {
    return !this.closed;
  }
  /**
   * Send one command.
   * @param method - CDP method name, for example `Page.navigate`.
   * @param params - method parameters.
   * @param sessionId - flattened session to address, or omitted for the browser target.
   * @returns the method's result object.
   */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new CdpClosedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.transport.send(JSON.stringify(sessionId === void 0 ? { id, method, params } : { id, method, params, sessionId }));
    });
  }
  /**
   * Observe the connection ending.
   *
   * A browser can vanish under a live command — a crash, a closed window, an
   * external kill. Owners need to learn about that to reset their own state;
   * without it a session keeps reporting "ready" and every later command fails
   * against a dead socket.
   * @param listener - called once with the cause, immediately if already closed.
   * @returns an unsubscribe function.
   */
  onClose(listener) {
    if (this.closeError !== void 0) {
      listener(this.closeError);
      return () => {
      };
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  /**
   * Observe every event on this connection, including session-scoped ones.
   * @param listener - called for each event message.
   * @returns an unsubscribe function.
   */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Close the socket; in-flight commands reject. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new CdpClosedError());
    this.transport.close();
  }
  receive(raw) {
    let message2;
    try {
      message2 = JSON.parse(raw);
    } catch {
      return;
    }
    if (message2.id !== void 0) {
      const entry = this.pending.get(message2.id);
      if (entry === void 0) return;
      this.pending.delete(message2.id);
      if (message2.error !== void 0) {
        entry.reject(new CdpError(entry.method, message2.error.message ?? message2.error.data ?? "unknown error"));
      } else {
        entry.resolve(message2.result ?? {});
      }
      return;
    }
    if (message2.method === void 0) return;
    const event = { method: message2.method, params: message2.params, sessionId: message2.sessionId };
    for (const listener of this.listeners) listener(event);
  }
  failAll(error) {
    if (this.closed && this.closeError !== void 0) return;
    this.closed = true;
    this.closeError = error;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
    const closeListeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of closeListeners) {
      try {
        listener(error);
      } catch {
      }
    }
  }
};
async function connectCdp(url, signal) {
  const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
  const abort = () => {
    socket.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", () => {
        resolve();
      });
      socket.once("error", (error) => {
        reject(error);
      });
      if (signal?.aborted === true) reject(new Error("aborted"));
    });
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    throw error;
  }
  signal?.removeEventListener("abort", abort);
  const connection = new CdpConnection({
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
    on: (event, handler) => socket.on(event, handler)
  });
  return { connection, socket };
}
async function browserEndpoint(port, host = "127.0.0.1") {
  const response = await fetch(`http://${host}:${port}/json/version`);
  if (!response.ok) throw new Error(`CDP version endpoint answered ${response.status}`);
  const body = await response.json();
  if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("CDP version endpoint returned no websocket URL");
  return { webSocketDebuggerUrl: body.webSocketDebuggerUrl, browser: body.Browser ?? "unknown" };
}

// src/host/launcher.ts
var LaunchError = class extends Error {
  name = "LaunchError";
  hint;
  constructor(message2, hint, options) {
    super(message2, options);
    this.hint = hint;
  }
};
var PROFILE_IN_USE = /SingletonLock|profile.*in use|cannot create.*lock/iu;
async function launchBrowser(options) {
  if (!existsSync(options.executablePath)) {
    throw new LaunchError(
      `Chromium was not found at "${options.executablePath}"`,
      `set dsh-browser's executablePath, or set DSH_BROWSER_EXECUTABLE, or run "npx playwright install chromium"`
    );
  }
  mkdirSync(options.profileDir, { recursive: true, mode: 448 });
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${options.profileDir}`,
    `--window-size=${options.viewport.width},${options.viewport.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    // Chromium's own crash reporter would upload; the profile is a user secret.
    "--disable-breakpad",
    // Sign-in providers look at more than the User-Agent string. Headless
    // Chromium also reports "HeadlessChrome" in its UA, exposes
    // `navigator.webdriver`, and sends a `sec-ch-ua` branding of "Chromium".
    // These switches make all three agree with the Chrome version actually
    // running; without them Google answers "this browser or app may not be
    // secure" even when the UA string looks normal.
    ...options.headed ? [] : ["--headless=new"],
    `--user-agent=${chromeUserAgent()}`,
    `--brand=${chromeBranding()}`,
    "--disable-blink-features=AutomationControlled",
    // Chromium refuses to start as root with its sandbox enabled; the plugin's
    // own confinement story is the profile directory, not the renderer sandbox.
    ...process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    ...options.args ?? [],
    "about:blank"
  ];
  const child = spawn(options.executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Chromium must never inherit the Host's credential environment.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? options.profileDir,
      ...process.env.DISPLAY === void 0 ? {} : { DISPLAY: process.env.DISPLAY },
      ...process.env.WAYLAND_DISPLAY === void 0 ? {} : { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY },
      ...process.env.XDG_RUNTIME_DIR === void 0 ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
    }
  });
  const stderr = [];
  child.stderr?.on("data", (chunk) => {
    stderr.push(chunk.toString("utf8"));
    if (stderr.length > 40) stderr.shift();
  });
  let exitCode;
  child.once("exit", (code) => {
    exitCode = code;
  });
  const portFile = join(options.profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const deadline = Date.now() + options.startTimeoutMs;
  while (!existsSync(portFile)) {
    if (exitCode !== void 0) {
      const detail = stderr.join("");
      throw new LaunchError(
        `Chromium exited with code ${exitCode} during startup`,
        PROFILE_IN_USE.test(detail) ? "the browser profile is already in use by another Chromium; close it, or let dsh-browser manage this profile" : `check the browser profile at ${options.profileDir}`
      );
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new LaunchError(
        "Chromium did not publish its debugging port in time",
        "if this is a remote or containerized environment, ensure a display is available or set headed: false"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const [portLine] = readFileSync(portFile, "utf8").trim().split("\n");
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0) {
    child.kill("SIGKILL");
    throw new LaunchError("Chromium published an unreadable debugging port", `delete ${options.profileDir} and retry`);
  }
  const readyBy = Date.now() + options.startTimeoutMs;
  while (Date.now() < readyBy) {
    try {
      await browserEndpoint(port);
      break;
    } catch (error) {
      if (Date.now() >= readyBy) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  let endpoint;
  try {
    endpoint = await browserEndpoint(port);
  } catch (error) {
    child.kill("SIGKILL");
    throw new LaunchError("Chromium started but its debugging endpoint did not answer", "retry; if it persists, delete the browser profile", { cause: error });
  }
  return {
    pid: child.pid,
    profileDir: options.profileDir,
    port,
    webSocketDebuggerUrl: endpoint.webSocketDebuggerUrl,
    version: endpoint.browser,
    async close() {
      await stop(child, options.profileDir);
    }
  };
}
function chromeUserAgent() {
  const platform = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  const version = process.versions.chrome ?? "156.0.0.0";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}
function chromeBranding() {
  return `Google Chrome`;
}
async function stop(child, profileDir) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    child.kill("SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 5e3))
    ]);
    if (timedOut) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(profileDir, name), { force: true });
  }
}
function discoverExecutable() {
  if (process.env.DSH_BROWSER_EXECUTABLE !== void 0) return process.env.DSH_BROWSER_EXECUTABLE;
  const candidates = [
    // Playwright's own cache is the most likely source on a dev machine.
    ...playwrightCandidates(),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
function playwrightCandidates() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.HOME ?? "", ".cache", "ms-playwright"),
    join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright")
  ].filter((root) => typeof root === "string" && root !== "");
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      entries = [];
    }
    const revisions = entries.filter((name) => name.startsWith("chromium-") && !name.includes("headless_shell") && !name.includes("tip-of-tree")).sort().reverse();
    for (const revision of revisions) {
      found.push(
        join(root, revision, "chrome-linux64", "chrome"),
        join(root, revision, "chrome-linux", "chrome"),
        join(root, revision, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        join(root, revision, "chrome-win", "chrome.exe")
      );
    }
  }
  return found;
}

// src/host/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var HUMAN_CONTROL = "the human is controlling this browser; ask them to hand it back, then retry";
var MAX_TEXT = 2e4;
function registerTools(ctx, deps) {
  const claim = async (agent, signal) => {
    if (agent === void 0) throw new Error("browser tools must run inside a Session");
    if (!deps.executableAvailable()) {
      throw new Error('no Chromium executable is available: set dsh-browser executablePath, or set DSH_BROWSER_EXECUTABLE, or run "npx playwright install chromium"');
    }
    const session = deps.getSession(agent);
    await session.claimAgent(signal);
    if (!session.allowsAgent) throw new Error(HUMAN_CONTROL);
    return session;
  };
  const view = (session) => {
    const active = session.activeView;
    if (active === void 0) throw new Error("the browser has no open tab");
    return active;
  };
  ctx.tools.register(defineTool({
    name: "browser_open",
    description: "Open the side-panel browser on an HTTP(S) address and return the page it loaded.",
    parameters: {
      url: { type: "string", required: true, description: "HTTP(S) address, or a bare host name" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          text: { type: "string" },
          truncated: { type: "boolean" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [{ type: "text", text: `${value.title}
${value.url}

${value.text}` }]
    },
    async execute(args, exec) {
      const url = normalizeAddress(args.url);
      if (url === void 0) throw new Error("url must be an http or https address");
      const session = await claim(exec.agent, exec.signal);
      const active = session.activeView ?? await session.createView(url);
      await active.navigate(url);
      const page = await waitForLoad(active, exec.signal);
      return { url: page.url, title: page.title, text: page.text, truncated: page.truncated };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_read",
    description: "Read the visible text of the page in the side-panel browser.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          text: { type: "string" },
          truncated: { type: "boolean" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [{ type: "text", text: `${value.title}
${value.url}

${value.text}` }]
    },
    async execute(_args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const page = await view(session).readText(MAX_TEXT);
      return { url: page.url, title: page.title, text: page.text, truncated: page.truncated };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_snapshot",
    description: "Read the page as a compact accessibility tree. Each interactive element gets a ref like [ref=e12]; pass that ref to browser_click, browser_type or browser_check. This is the normal way to look at a page: it is exact, cheap, and needs no coordinates.",
    parameters: {
      interactive: { type: "boolean", description: "Only actionable elements; defaults to true" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          tree: { type: "string" },
          elements: { type: "number" },
          truncated: { type: "boolean" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [{
        type: "text",
        text: `${value.title}
${value.url}

${value.tree}${value.truncated ? "\n(tree truncated)" : ""}`
      }]
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const active = view(session);
      const snapshot = await active.snapshot({ interactiveOnly: args.interactive !== false });
      return {
        url: snapshot.url,
        title: snapshot.title,
        tree: snapshot.text,
        elements: snapshot.refs.size,
        truncated: snapshot.truncated
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_click",
    description: "Click an element from browser_snapshot, or a CSS selector, or a point.",
    parameters: {
      ref: { type: "string", description: "Ref from browser_snapshot, for example e12" },
      selector: { type: "string", description: "CSS selector of the element to click" },
      x: { type: "number", description: "Page x coordinate, when no selector is given" },
      y: { type: "number", description: "Page y coordinate, when no selector is given" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          clicked: { type: "string" },
          url: { type: "string" },
          title: { type: "string" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [{ type: "text", text: `clicked ${value.clicked} \u2192 ${value.url}` }]
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const active = view(session);
      if (args.ref !== void 0) {
        const result = await active.clickRef(args.ref);
        const page2 = await active.readText(400);
        return { clicked: result.detail || args.ref, url: page2.url, title: page2.title };
      }
      if (args.selector !== void 0) {
        const result = await active.clickSelector(args.selector);
        const page2 = await active.readText(400);
        return { clicked: result.text || args.selector, url: page2.url, title: page2.title };
      }
      if (args.x === void 0 || args.y === void 0) throw new Error("give a selector, or both x and y");
      await active.mouse({ type: "move", x: args.x, y: args.y, button: 0, clickCount: 0, modifiers: 0 });
      await active.mouse({ type: "down", x: args.x, y: args.y, button: 0, clickCount: 1, modifiers: 0 });
      await active.mouse({ type: "up", x: args.x, y: args.y, button: 0, clickCount: 1, modifiers: 0 });
      const page = await active.readText(400);
      return { clicked: `(${args.x}, ${args.y})`, url: page.url, title: page.title };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_type",
    description: "Type text into an element from browser_snapshot, or the focused field, and optionally press Enter.",
    parameters: {
      text: { type: "string", required: true, description: "Text to insert" },
      ref: { type: "string", description: "Ref from browser_snapshot, for example e12" },
      selector: { type: "string", description: "CSS selector of the field to focus first" },
      submit: { type: "boolean", description: "Press Enter after typing" }
    },
    output: {
      schema: { type: "object", properties: { typed: { type: "boolean" } }, additionalProperties: false },
      render: (_args, value) => [{ type: "text", text: value.typed ? "typed" : "nothing typed" }]
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const active = view(session);
      if (args.ref !== void 0) {
        await active.focusRef(args.ref);
      } else if (args.selector !== void 0) {
        await active.clickSelector(args.selector);
      }
      await active.insertText(args.text);
      if (args.submit === true) {
        await active.key({ type: "down", key: "Enter", code: "Enter", vk: 13, text: "\r", modifiers: 0 });
        await active.key({ type: "up", key: "Enter", code: "Enter", vk: 13, modifiers: 0 });
      }
      return { typed: args.text.length > 0 };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_press",
    description: "Press one key, such as Enter, Tab, Escape, or a named arrow key.",
    parameters: {
      key: { type: "string", required: true, description: "DOM key value, for example Enter or ArrowDown" }
    },
    output: {
      schema: { type: "object", properties: { pressed: { type: "string" } }, additionalProperties: false },
      render: (_args, value) => [{ type: "text", text: `pressed ${value.pressed}` }]
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const active = view(session);
      const spec = KEY_SPECS[args.key] ?? FLAT_KEY(args.key);
      await active.key({ type: "down", ...spec, modifiers: 0 });
      await active.key({ type: "up", ...spec, modifiers: 0 });
      return { pressed: args.key };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_screenshot",
    description: "Capture the visible page in the side-panel browser as an image.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: { mediaType: { type: "string" }, bytes: { type: "number" }, width: { type: "number" }, height: { type: "number" }, url: { type: "string" } },
        additionalProperties: false
      },
      render: (_args, value) => [{ type: "text", text: `captured ${value.width}\xD7${value.height} PNG of ${value.url}` }]
    },
    async execute(_args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const active = view(session);
      const attachments = ctx.get("attachments");
      if (attachments === void 0) throw new Error("screenshots need the attachment service, which this composition does not mount");
      const png = await active.screenshot();
      const limits = attachments.imageLimits;
      if (!limits.mediaTypes.includes("image/png")) throw new Error("this deployment does not admit PNG images");
      const ref = await attachments.saveImage({ data: png, mediaType: "image/png", name: "browser-screenshot.png" });
      return { mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, url: active.currentUrl };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_tabs",
    description: "List the browser tabs, or select, create, or close one.",
    parameters: {
      action: { type: "string", enum: ["list", "select", "create", "close"], required: true },
      viewId: { type: "string", description: "Tab id for select or close" },
      url: { type: "string", description: "Address for create" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          views: {
            type: "array",
            items: {
              type: "object",
              properties: { viewId: { type: "string" }, url: { type: "string" }, title: { type: "string" } },
              additionalProperties: false
            }
          },
          activeViewId: { type: "string" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [{
        type: "text",
        text: (value.views ?? []).map((entry) => `${entry.viewId === value.activeViewId ? "*" : " "} ${entry.viewId} ${entry.title} \u2014 ${entry.url}`).join("\n") || "no tabs"
      }]
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal);
      if (args.action === "create") {
        const url = args.url === void 0 ? "about:blank" : normalizeAddress(args.url);
        if (url === void 0) throw new Error("url must be an http or https address");
        await session.createView(url);
      } else if (args.action === "select") {
        if (args.viewId === void 0) throw new Error("select needs a viewId");
        await session.selectView(args.viewId);
      } else if (args.action === "close") {
        if (args.viewId === void 0) throw new Error("close needs a viewId");
        await session.closeView(args.viewId);
      }
      const snapshot = session.snapshot();
      return {
        views: snapshot.views.map((entry) => ({ viewId: entry.viewId, url: entry.url, title: entry.title })),
        ...snapshot.activeViewId === void 0 ? {} : { activeViewId: snapshot.activeViewId }
      };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_navigate",
    description: "Go back, forward, or reload in the side-panel browser.",
    parameters: {
      action: { type: "string", enum: ["back", "forward", "reload"], required: true }
    },
    output: {
      schema: { type: "object", properties: { url: { type: "string" } }, additionalProperties: false },
      render: (_args, value) => [{ type: "text", text: `now at ${value.url}` }]
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const active = view(session);
      if (args.action === "back") await active.back();
      else if (args.action === "forward") await active.forward();
      else await active.reload();
      const page = await waitForLoad(active, exec.signal);
      return { url: page.url };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_request_human",
    description: "Ask the human to take over the side-panel browser \u2014 to sign in, clear a captcha, or approve something \u2014 and wait until they hand control back.",
    parameters: {
      reason: { type: "string", required: true, description: "What the human needs to do, in one sentence" },
      timeoutSeconds: { type: "number", description: "How long to wait; defaults to the deployment timeout" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["released", "timeout", "cancelled"] },
          url: { type: "string" },
          title: { type: "string" }
        },
        additionalProperties: false
      },
      render: (_args, value) => [{
        type: "text",
        text: value.outcome === "released" ? `the human finished and handed the browser back; the page is now "${value.title}" (${value.url})` : value.outcome === "timeout" ? "the human did not respond in time" : "the request was cancelled"
      }]
    },
    async execute(args, exec) {
      const session = await claim(exec.agent, exec.signal);
      const active = view(session);
      const outcome = await session.requestHuman(args.reason, args.timeoutSeconds ?? 600, exec.signal);
      const page = await active.readText(300);
      return { outcome, url: page.url, title: page.title };
    }
  }));
}
var KEY_SPECS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  " ": { key: " ", code: "Space", vk: 32, text: " " }
};
function FLAT_KEY(key) {
  const single = key.length === 1;
  const vk = single ? key.toUpperCase().charCodeAt(0) : 0;
  return { key, code: single ? `Key${key.toUpperCase()}` : key, vk, ...single ? { text: key } : {} };
}
async function waitForLoad(view, signal) {
  const deadline = Date.now() + 1e4;
  while (view.isLoading && Date.now() < deadline && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await view.readText(MAX_TEXT);
}

// src/host/session.ts
import { mkdirSync as mkdirSync2, rmSync as rmSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/shared/control.ts
var IDLE = { state: "idle", holder: void 0, expiresAt: void 0 };
var ControlMachine = class {
  lease = IDLE;
  options;
  constructor(options) {
    this.options = options;
  }
  /** Current lease. */
  get current() {
    return this.lease;
  }
  /** Whether browser tools may run now. */
  allowsAgent(now) {
    const lease = this.effective(now);
    return lease.state === "idle" || lease.state === "agent";
  }
  /** Whether human input may be forwarded now. */
  allowsHuman(now) {
    return this.effective(now).state === "human";
  }
  /**
   * Claim the browser for the Agent.
   * @param now - current epoch milliseconds.
   * @param reason - diagnostic label for the transition.
   * @returns the transition, telling the caller whether a human was displaced.
   */
  claimAgent(now) {
    const before = this.effective(now);
    if (before.state === "agent") return { before, after: before, changed: false };
    this.lease = { state: "agent", holder: "agent", expiresAt: void 0 };
    return { before, after: this.lease, changed: true };
  }
  /**
   * Claim the browser for the human, displacing the Agent.
   * @param now - current epoch milliseconds.
   * @returns the transition; `before.state === 'agent'` means the Agent was interrupted.
   */
  claimHuman(now) {
    const before = this.effective(now);
    this.lease = {
      state: "human",
      holder: "human",
      expiresAt: this.options.humanIdleMs > 0 ? now + this.options.humanIdleMs : void 0
    };
    return { before, after: this.lease, changed: before.state !== "human" };
  }
  /**
   * Give the browser back to the Agent, or to idle.
   * @param now - current epoch milliseconds.
   * @returns the transition.
   */
  release(now) {
    const before = this.effective(now);
    this.lease = { state: "agent", holder: "agent", expiresAt: void 0 };
    return { before, after: this.lease, changed: before.state !== "agent" };
  }
  /**
   * Extend a human lease after observed input, so an active user is never cut off.
   * @param now - current epoch milliseconds.
   * @returns true when the lease was extended.
   */
  touch(now) {
    const lease = this.effective(now);
    if (lease.state !== "human" || this.options.humanIdleMs <= 0) return false;
    this.lease = { ...lease, expiresAt: now + this.options.humanIdleMs };
    return true;
  }
  /**
   * Drop an expired human lease.
   * @param now - current epoch milliseconds.
   * @returns the transition when expiry changed the state.
   */
  expire(now) {
    const before = this.lease;
    if (before.state !== "human" || before.expiresAt === void 0 || now < before.expiresAt) return void 0;
    this.lease = { state: "agent", holder: "agent", expiresAt: void 0 };
    return { before, after: this.lease, changed: true };
  }
  /** Treat an expired lease as already released. */
  effective(now) {
    if (this.lease.state === "human" && this.lease.expiresAt !== void 0 && now >= this.lease.expiresAt) {
      return { state: "agent", holder: "agent", expiresAt: void 0 };
    }
    return this.lease;
  }
};

// src/host/refs.ts
async function resolveClickPoint(connection, sessionId, backendNodeId) {
  await connection.send("DOM.enable", {}, sessionId);
  let objectId;
  try {
    const resolved = await connection.send(
      "DOM.resolveNode",
      { backendNodeId },
      sessionId
    );
    objectId = resolved.object?.objectId;
  } catch (error) {
    return { refusal: "detached", detail: `the element is gone (${message(error)}); take a new snapshot` };
  }
  if (objectId === void 0) {
    return { refusal: "unknown-ref", detail: "the ref does not name an element; take a new snapshot" };
  }
  const measured = await connection.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function () {
      this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = this.getBoundingClientRect()
      const style = getComputedStyle(this)
      const disabled = this.disabled === true || this.getAttribute('aria-disabled') === 'true'
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') return { hidden: true }
      if (disabled) return { disabled: true }
      const cx = Math.round(r.x + r.width / 2)
      const cy = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(cx, cy)
      const covered = hit === null ? false : !(this === hit || this.contains(hit))
      return { x: cx, y: cy, width: r.width, height: r.height, covered, label: (this.innerText || this.getAttribute('aria-label') || this.value || '').slice(0, 60) }
    }`,
    returnByValue: true
  }, sessionId);
  const value = measured.result?.value ?? {};
  if (value.hidden === true) return { refusal: "hidden", detail: "the element is not visible; take a new snapshot" };
  if (value.disabled === true) return { refusal: "disabled", detail: "the element is disabled" };
  if (value.covered === true) return { refusal: "covered", detail: "another element covers it, often a consent banner; dismiss it and take a new snapshot" };
  const point = {
    x: Number(value.x ?? 0),
    y: Number(value.y ?? 0),
    width: Number(value.width ?? 0),
    height: Number(value.height ?? 0)
  };
  return { point, detail: String(value.label ?? "").trim() };
}
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/host/snapshot.ts
var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "searchbox",
  "spinbutton",
  "textfield",
  "file",
  "treeitem"
]);
var CONTENT_ROLES = /* @__PURE__ */ new Set([
  "heading",
  "paragraph",
  "list",
  "listitem",
  "cell",
  "columnheader",
  "rowheader",
  "StaticText",
  "RootWebArea",
  "document",
  "article",
  "navigation",
  "main",
  "form",
  "dialog"
]);
var SKIPPED_ROLES = /* @__PURE__ */ new Set(["none", "presentation", "InlineTextBox", "lineBreak"]);
async function snapshotPage(connection, sessionId, options = {}) {
  const interactiveOnly = options.interactiveOnly ?? true;
  const maxChars = options.maxChars ?? 16e3;
  const maxLines = options.maxLines ?? 400;
  await connection.send("Accessibility.enable", {}, sessionId);
  const tree = await connection.send("Accessibility.getFullAXTree", {}, sessionId);
  const nodes = tree.nodes ?? [];
  const byId = /* @__PURE__ */ new Map();
  for (const node of nodes) byId.set(node.nodeId, node);
  const pageInfo = await connection.send("Runtime.evaluate", {
    expression: "({ url: location.href, title: document.title })",
    returnByValue: true
  }, sessionId);
  const info = pageInfo.result?.value;
  const lines = [];
  const refs = /* @__PURE__ */ new Map();
  let truncated = false;
  const hasUsefulDescendant = (node, seen = /* @__PURE__ */ new Set()) => {
    if (seen.has(node.nodeId)) return false;
    seen.add(node.nodeId);
    for (const child of node.childIds ?? []) {
      const next = byId.get(child);
      if (next === void 0) continue;
      const role = next.role?.value ?? "";
      if (SKIPPED_ROLES.has(role)) continue;
      if (INTERACTIVE_ROLES.has(role)) return true;
      if (isUseful(next) || hasUsefulDescendant(next, seen)) return true;
    }
    return false;
  };
  const isUseful = (node) => {
    if (node.ignored === true) return false;
    const role = node.role?.value ?? "";
    if (SKIPPED_ROLES.has(role)) return false;
    const name = (node.name?.value ?? "").trim();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (role === "StaticText") return name.length > 0;
    if (CONTENT_ROLES.has(role)) return name.length > 0 || hasUsefulDescendant(node);
    return name.length > 0;
  };
  const render = (node, depth) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const role = node.role?.value ?? "unknown";
    const name = (node.name?.value ?? "").replace(/\s+/gu, " ").trim();
    const interactive = INTERACTIVE_ROLES.has(role);
    const keep = isUseful(node);
    let rendered = false;
    if (keep && (!interactiveOnly || interactive || CONTENT_ROLES.has(role))) {
      const ref = node.backendDOMNodeId === void 0 ? void 0 : `e${node.backendDOMNodeId}`;
      if (ref !== void 0 && node.backendDOMNodeId !== void 0) refs.set(ref, node.backendDOMNodeId);
      const parent = node.parentId === void 0 ? void 0 : byId.get(node.parentId);
      const echo = role === "StaticText" && parent !== void 0 && (parent.name?.value ?? "").trim() === name;
      if (!echo && (interactive || name.length > 0)) {
        lines.push({ depth, role, name: name.slice(0, 160), ref: interactive ? ref : void 0 });
        rendered = true;
      }
    }
    for (const child of node.childIds ?? []) {
      const next = byId.get(child);
      if (next !== void 0) render(next, rendered ? depth + 1 : depth);
    }
  };
  const root = nodes.find((node) => (node.role?.value ?? "") === "RootWebArea") ?? nodes[0];
  if (root !== void 0) render(root, 0);
  const out = [];
  let used = 0;
  for (const line of lines) {
    const label = line.name === "" ? line.role : `${line.role} "${line.name}"`;
    const text = `${"  ".repeat(line.depth)}- ${label}${line.ref === void 0 ? "" : ` [ref=${line.ref}]`}`;
    if (used + text.length > maxChars) {
      truncated = true;
      break;
    }
    out.push(text);
    used += text.length + 1;
  }
  return {
    text: out.join("\n"),
    refs,
    url: info?.url ?? "",
    title: info?.title ?? "",
    nodeCount: lines.length,
    truncated
  };
}

// src/host/view.ts
var BrowserView = class {
  targetId;
  sessionId;
  options;
  log;
  frames = 0;
  bytes = 0;
  acked = 0;
  pendingFrameId;
  screencastSessionId;
  active = false;
  closed = false;
  url = "about:blank";
  title = "";
  loading = true;
  viewport;
  deviceScaleFactor = 1;
  /** Latest snapshot; a ref only means something against the tree it came from. */
  lastSnapshot;
  /** Serialises viewport updates: stop/start of the screencast must not interleave. */
  viewportQueue = Promise.resolve();
  disposeEvents;
  inflight;
  constructor(options) {
    this.options = options;
    this.log = options.log;
    this.targetId = options.targetId;
    this.sessionId = options.sessionId;
    this.viewport = options.viewport;
  }
  /** Current address, as last reported by the page. */
  get currentUrl() {
    return this.url;
  }
  /** Current document title. */
  get currentTitle() {
    return this.title;
  }
  /** Whether a document load is in flight. */
  get isLoading() {
    return this.loading;
  }
  /** Whether the screencast is running. */
  get streaming() {
    return this.active;
  }
  /** Viewport the target is emulated at. */
  get currentViewport() {
    return this.viewport;
  }
  /** Enable the domains and wire events. Safe to call once. */
  async start(initialUrl) {
    this.disposeEvents = this.options.connection.onEvent((event) => {
      this.handleEvent(event);
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await this.applyChromeIdentity();
    await this.applyViewport(this.viewport, this.deviceScaleFactor);
    await this.navigate(initialUrl);
  }
  /**
   * Start the screencast, replacing any previous consumer.
   * @returns nothing; frames arrive through the sink.
   */
  async startStreaming() {
    if (this.closed || this.active) return;
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await this.send("Page.startScreencast", {
          format: "jpeg",
          quality: this.options.quality,
          // Chromium only scales frames down to this cap, so it must match the
          // emulated viewport; a larger cap would upscale the frame and blur it.
          maxWidth: Math.round(this.viewport.width * this.deviceScaleFactor),
          maxHeight: Math.round(this.viewport.height * this.deviceScaleFactor),
          everyNthFrame: 1
        });
        lastError = void 0;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (lastError !== void 0) throw lastError;
    this.active = true;
    this.frames = 0;
    this.bytes = 0;
  }
  /** Stop the screencast; the page keeps running. */
  async stopStreaming() {
    if (!this.active) return;
    this.active = false;
    await this.send("Page.stopScreencast").catch((error) => {
      this.log.debug("stopScreencast failed", error);
    });
  }
  /**
   * Acknowledge one delivered frame, which is what paces the next one.
   * @param frameId - the id carried by the frame.
   * @returns true when the ack matched the frame we were waiting for.
   */
  ackFrame(frameId) {
    if (this.pendingFrameId !== frameId) return false;
    this.pendingFrameId = void 0;
    this.acked++;
    const sessionId = this.screencastSessionId;
    if (sessionId === void 0) return true;
    void this.send("Page.screencastFrameAck", { sessionId }).catch((error) => {
      this.log.debug("screencastFrameAck failed", error);
    });
    return true;
  }
  /** Frame statistics since streaming started, for diagnostics. */
  stats() {
    return { frames: this.frames, bytes: this.bytes, acked: this.acked };
  }
  /** Navigate to an absolute URL. */
  async navigate(url) {
    this.loading = true;
    await this.send("Page.navigate", { url });
  }
  /** Go back in the page's own history. */
  async back() {
    await this.send("Runtime.evaluate", { expression: "history.back()", userGesture: true });
  }
  /** Go forward in the page's own history. */
  async forward() {
    await this.send("Runtime.evaluate", { expression: "history.forward()", userGesture: true });
  }
  /** Reload the current document. */
  async reload() {
    this.loading = true;
    await this.send("Page.reload", {});
  }
  /**
   * Resize the emulated viewport to match the pane.
   *
   * @param viewport - page pixels.
   * @param devicePixelRatio - device pixel ratio to emulate; defaults to 1.
   */
  async setViewport(viewport, devicePixelRatio = 1) {
    if (viewport.width === this.viewport.width && viewport.height === this.viewport.height && devicePixelRatio === this.deviceScaleFactor) return;
    this.viewport = viewport;
    this.deviceScaleFactor = devicePixelRatio;
    this.viewportQueue = this.viewportQueue.then(async () => {
      if (this.closed) return;
      await this.applyViewport(this.viewport, this.deviceScaleFactor);
      if (!this.active) return;
      await this.stopStreaming();
      await this.startStreaming();
    }).catch((error) => {
      this.log.warn(`view ${this.sessionId}: viewport update failed`, error);
    });
    await this.viewportQueue;
  }
  /** Dispatch one pointer event. */
  async mouse(event) {
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    const buttons = event.type === "down" ? event.button === 2 ? 2 : event.button === 1 ? 4 : 1 : 0;
    await this.send("Input.dispatchMouseEvent", {
      type: event.type === "down" ? "mousePressed" : event.type === "up" ? "mouseReleased" : "mouseMoved",
      x: event.x,
      y: event.y,
      button,
      buttons,
      clickCount: event.type === "move" ? 0 : event.clickCount,
      modifiers: event.modifiers,
      pointerType: "mouse"
    });
  }
  /** Dispatch one wheel event. */
  async wheel(event) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: event.x,
      y: event.y,
      deltaX: event.dx,
      deltaY: event.dy,
      modifiers: 0
    });
  }
  /** Dispatch one key event. */
  async key(event) {
    const isText = event.type === "down" && event.text !== void 0 && event.text !== "";
    await this.send("Input.dispatchKeyEvent", {
      type: event.type === "down" ? isText ? "keyDown" : "rawKeyDown" : "keyUp",
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.vk,
      nativeVirtualKeyCode: event.vk,
      ...isText ? { text: event.text, unmodifiedText: event.text } : {},
      modifiers: event.modifiers
    });
  }
  /** Insert text without key events, which is how IME and paste must work. */
  async insertText(text) {
    await this.send("Input.insertText", { text });
  }
  /**
   * Read a bounded text snapshot of the page for the model.
   * @param maxChars - hard cap on returned length.
   * @returns the page's visible text and title.
   */
  async readText(maxChars) {
    const result = await this.send("Runtime.evaluate", {
      expression: `(() => {
        const body = document.body
        const text = (body ? body.innerText : '') || ''
        return { title: document.title, url: location.href, text }
      })()`,
      returnByValue: true,
      awaitPromise: false
    });
    const value = result.result?.value;
    if (typeof value !== "object" || value === null) return { title: this.title, url: this.url, text: "", truncated: false };
    const record = value;
    const text = typeof record.text === "string" ? record.text.replace(/\n{3,}/g, "\n\n").trim() : "";
    return {
      title: typeof record.title === "string" ? record.title : this.title,
      url: typeof record.url === "string" ? record.url : this.url,
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars
    };
  }
  /**
   * Read the page as a compact accessibility tree with a ref per element.
   *
   * The default way an agent should look at a page: a text tree is exact and
   * cheap, where a screenshot forces the model to guess coordinates.
   * @param options - filtering and size bounds.
   * @returns the tree and its ref table.
   */
  async snapshot(options) {
    const snapshot = await snapshotPage(this.options.connection, this.sessionId, options);
    this.lastSnapshot = snapshot;
    return snapshot;
  }
  /**
   * Click the element a snapshot ref names.
   *
   * A refused action throws with the reason, so a click that cannot land never
   * looks like success.
   * @param ref - ref such as `e12` from the latest snapshot.
   * @returns what was clicked.
   */
  async clickRef(ref) {
    const nodeId = this.lastSnapshot?.refs.get(ref);
    if (nodeId === void 0) throw new Error(`unknown ref "${ref}"; take a new browser_snapshot`);
    const target = await resolveClickPoint(this.options.connection, this.sessionId, nodeId);
    if ("refusal" in target) throw new Error(`cannot click ${ref}: ${target.detail}`);
    await this.mouse({ type: "move", x: target.point.x, y: target.point.y, button: 0, clickCount: 0, modifiers: 0 });
    await this.mouse({ type: "down", x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 });
    await this.mouse({ type: "up", x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 });
    return { detail: target.detail === "" ? ref : `${target.detail} (${ref})` };
  }
  /**
   * Focus the element a snapshot ref names, so a following insert goes into it.
   * @param ref - ref such as `e12` from the latest snapshot.
   */
  async focusRef(ref) {
    const nodeId = this.lastSnapshot?.refs.get(ref);
    if (nodeId === void 0) throw new Error(`unknown ref "${ref}"; take a new browser_snapshot`);
    const target = await resolveClickPoint(this.options.connection, this.sessionId, nodeId);
    if ("refusal" in target) throw new Error(`cannot focus ${ref}: ${target.detail}`);
    await this.mouse({ type: "move", x: target.point.x, y: target.point.y, button: 0, clickCount: 0, modifiers: 0 });
    await this.mouse({ type: "down", x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 });
    await this.mouse({ type: "up", x: target.point.x, y: target.point.y, button: 0, clickCount: 1, modifiers: 0 });
  }
  /** The most recent snapshot, whose refs a later action resolves against. */
  get snapshotState() {
    return this.lastSnapshot;
  }
  /**
   * Capture the visible page as a PNG.
   * @returns PNG bytes.
   */
  async screenshot() {
    const result = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    if (result.data === void 0) throw new Error("the page returned no screenshot data");
    return Buffer.from(result.data, "base64");
  }
  /**
   * Run a click at a point or on a selector-resolved element.
   * @param selector - CSS selector to click.
   * @returns the element's description, useful in the model result.
   */
  async clickSelector(selector) {
    const rect = await this.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (el.innerText || el.getAttribute('aria-label') || el.value || '').slice(0, 80) }
      })()`,
      returnByValue: true
    });
    const value = rect.result?.value;
    if (typeof value !== "object" || value === null) throw new Error(`no element matches ${JSON.stringify(selector)}`);
    const point = value;
    const x = Math.round(Number(point.x ?? 0));
    const y = Math.round(Number(point.y ?? 0));
    await this.mouse({ type: "move", x, y, button: 0, clickCount: 0, modifiers: 0 });
    await this.mouse({ type: "down", x, y, button: 0, clickCount: 1, modifiers: 0 });
    await this.mouse({ type: "up", x, y, button: 0, clickCount: 1, modifiers: 0 });
    return { text: typeof point.text === "string" ? point.text : "", url: this.url };
  }
  /** Close the page target and release the screencast. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.stopStreaming().catch(() => {
    });
    this.disposeEvents?.();
    this.disposeEvents = void 0;
    await this.options.connection.send("Target.closeTarget", { targetId: this.targetId }).catch((error) => {
      this.log.debug("closeTarget failed", error);
    });
    this.options.sink.onClosed(this, "closed by request");
  }
  /** True after {@link close} or after the target disappeared. */
  get isClosed() {
    return this.closed;
  }
  /**
   * Present this page as Google Chrome rather than plain Chromium.
   *
   * Sign-in providers read the User-Agent Client Hints, not only the UA string.
   * `--user-agent` leaves the hint branding as "Chromium", and Google answers
   * that with "this browser or app may not be secure". The CDP override is the
   * supported way to set the metadata those hints are derived from; it is scoped
   * to this target, so it survives navigation and is dropped with the page.
   */
  async applyChromeIdentity() {
    const version = process.versions.chrome ?? "156.0.0.0";
    const major = version.split(".")[0];
    await this.send("Emulation.setUserAgentOverride", {
      userAgent: chromeUserAgent(),
      acceptLanguage: "en-US,en",
      platform: process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64",
      userAgentMetadata: {
        brands: [
          { brand: "Not:A-Brand", version: "8" },
          { brand: "Chromium", version: major },
          { brand: "Google Chrome", version: major }
        ],
        fullVersionList: [
          { brand: "Not:A-Brand", version: "8.0.0.0" },
          { brand: "Chromium", version },
          { brand: "Google Chrome", version }
        ],
        fullVersion: version,
        platform: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux",
        platformVersion: "6.8.0",
        architecture: "x86",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false
      }
    });
  }
  async applyViewport(viewport, deviceScaleFactor) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`view ${this.sessionId} is closed`));
    return this.options.connection.send(method, params, this.sessionId);
  }
  handleEvent(event) {
    if (event.sessionId !== this.sessionId) return;
    const params = event.params ?? {};
    switch (event.method) {
      case "Page.screencastFrame": {
        if (!this.active) return;
        const data = params.data;
        const frameSession = params.sessionId;
        const metadata = params.metadata;
        if (typeof data !== "string") return;
        const jpeg = Buffer.from(data, "base64");
        this.frames++;
        this.bytes += jpeg.length;
        this.screencastSessionId = typeof frameSession === "number" ? frameSession : void 0;
        const width = metadata?.deviceWidth ?? this.viewport.width;
        const height = metadata?.deviceHeight ?? this.viewport.height;
        this.pendingFrameId = this.screencastSessionId;
        this.options.sink.onFrame(this, {
          frameId: this.screencastSessionId ?? this.frames,
          jpeg,
          width,
          height
        });
        break;
      }
      case "Page.frameNavigated": {
        const frame = params.frame;
        if (frame === void 0 || frame.parentId !== void 0) return;
        this.url = frame.url ?? this.url;
        this.loading = true;
        this.options.sink.onNavigation(this, { url: this.url, title: this.title, loading: true });
        break;
      }
      case "Page.loadEventFired": {
        this.loading = false;
        void this.readText(0).then(({ title, url }) => {
          this.title = title;
          this.url = url;
          this.options.sink.onNavigation(this, { url, title, loading: false });
        }).catch((error) => {
          this.log.debug("title read failed", error);
        });
        break;
      }
      case "Page.javascriptDialogOpening": {
        void this.send("Page.handleJavaScriptDialog", { accept: true }).catch((error) => {
          this.log.debug("dialog auto-accept failed", error);
        });
        break;
      }
      case "Target.targetDestroyed": {
        if (!this.closed) {
          this.closed = true;
          this.active = false;
          this.options.sink.onClosed(this, "the page was closed");
        }
        break;
      }
      default:
        break;
    }
  }
};

// src/host/session.ts
var BrowserSession = class {
  options;
  control;
  views = /* @__PURE__ */ new Map();
  launch;
  connection;
  starting;
  state = "starting";
  failure;
  activeViewId;
  viewport;
  viewers = 0;
  disposed = false;
  /** Last time either party did something; drives idle reclamation. */
  lastActivityAt = Date.now();
  idleTimer;
  /** Work in flight that must not be interrupted by reclamation. */
  busy = 0;
  onDispose;
  request;
  requestResolve;
  constructor(options, onDispose) {
    this.options = options;
    this.onDispose = onDispose;
    this.viewport = options.viewport;
    this.control = new ControlMachine({ humanIdleMs: options.humanIdleMs });
  }
  /** Current lease. */
  get lease() {
    return this.control.current;
  }
  /** The live view a viewer should show. */
  get activeView() {
    return this.activeViewId === void 0 ? void 0 : this.views.get(this.activeViewId);
  }
  /** Whether the browser process is up. */
  get ready() {
    return this.state === "ready";
  }
  /** Why the session failed, when it did. */
  get error() {
    return this.failure;
  }
  /** How many windows are mirroring this browser right now. */
  get watchers() {
    return this.viewers;
  }
  /** The Agent's outstanding request for human help, if any. */
  get pendingRequest() {
    return this.request;
  }
  /**
   * Hand the browser to the human and wait for them to hand it back.
   *
   * The Agent's tool call stays blocked for the whole takeover, which is what
   * makes the handover observable: a silent release would let the Agent race a
   * person who is still typing a password.
   * @param reason - what the human needs to do.
   * @param timeoutSeconds - give up after this long.
   * @param signal - cancels the wait without taking the browser back.
   * @returns how the wait ended.
   */
  async requestHuman(reason, timeoutSeconds, signal) {
    if (this.request !== void 0) throw new Error("a human request is already pending for this browser");
    await this.claimHuman(signal);
    this.request = { reason, startedAt: Date.now() };
    this.options.sink.onViews(this);
    let timedOut = false;
    const outcome = await new Promise((resolve) => {
      const settle = (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.requestResolve = void 0;
        resolve(value);
      };
      const abort = () => {
        settle("cancelled");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        settle("timeout");
      }, timeoutSeconds * 1e3);
      this.requestResolve = (value) => {
        settle(value);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      void timedOut;
    });
    this.request = void 0;
    this.requestResolve = void 0;
    this.releaseToAgent();
    this.options.sink.onViews(this);
    return outcome;
  }
  /** Resolve a pending human request, from the UI's "I'm done" action. */
  finishHumanRequest(outcome) {
    const resolve = this.requestResolve;
    if (resolve === void 0) return false;
    resolve(outcome);
    return true;
  }
  /** Snapshot for status responses. */
  snapshot() {
    return {
      state: this.state,
      lease: this.control.current,
      views: [...this.views.values()].map((view) => ({
        viewId: view.sessionId,
        url: view.currentUrl,
        title: view.currentTitle,
        loading: view.isLoading
      })),
      activeViewId: this.activeViewId,
      viewport: this.viewport,
      error: this.failure
    };
  }
  /**
   * Start the browser if it is not up; concurrent callers share one launch.
   * @param signal - cancels the wait, not the launch.
   */
  async ensureStarted(signal) {
    if (this.disposed) throw new Error("the browser session has been disposed");
    if (this.state === "ready") {
      if (this.connection !== void 0 && this.connection.open) return;
      this.handleConnectionLost(new Error("the browser connection is no longer open"));
    }
    if (this.state === "failed") {
      this.state = "starting";
      this.failure = void 0;
    }
    if (this.starting === void 0) this.starting = this.start();
    return await withSignal(this.starting, signal);
  }
  /** Register a viewer; the first one starts the screencast. */
  async attachViewer(signal) {
    await this.ensureStarted(signal);
    this.viewers++;
    const view = this.activeView ?? await this.createView(this.options.initialUrl, signal);
    await view.startStreaming();
  }
  /** Release a viewer; the last one stops the screencast. */
  detachViewer() {
    this.viewers = Math.max(0, this.viewers - 1);
    this.touch();
    if (this.viewers > 0) return;
    for (const view of this.views.values()) void view.stopStreaming();
    void this.control.release(Date.now());
  }
  /** Claim the browser for the Agent, creating it when needed. */
  async claimAgent(signal) {
    await this.ensureStarted(signal);
    this.touch();
    const transition = this.control.claimAgent(Date.now());
    if (transition.changed) this.options.sink.onLease(this, transition);
    return transition.after;
  }
  /** Claim the browser for the human. */
  async claimHuman(signal) {
    await this.ensureStarted(signal);
    this.touch();
    const transition = this.control.claimHuman(Date.now());
    if (transition.changed) this.options.sink.onLease(this, transition);
    return transition.after;
  }
  /** Give the browser back to the Agent. */
  releaseToAgent() {
    const transition = this.control.release(Date.now());
    if (transition.changed) this.options.sink.onLease(this, transition);
    return transition.after;
  }
  /** Extend a human lease on observed input. */
  touchHuman() {
    this.control.touch(Date.now());
  }
  /** Drop an expired human lease. */
  expireLease() {
    const transition = this.control.expire(Date.now());
    if (transition !== void 0) this.options.sink.onLease(this, transition);
  }
  /** Whether browser tools may run right now. */
  get allowsAgent() {
    return this.control.allowsAgent(Date.now());
  }
  /** Whether human input may be forwarded right now. */
  get allowsHuman() {
    return this.control.allowsHuman(Date.now());
  }
  /**
   * Resize every view to a new pane size.
   * @param viewport - page pixels.
   */
  async resize(viewport, devicePixelRatio = 1) {
    this.viewport = viewport;
    for (const view of this.views.values()) await view.setViewport(viewport, devicePixelRatio);
    this.options.sink.onViews(this);
  }
  /** Create another tab and make it active. */
  async createView(url, signal) {
    await this.ensureStarted(signal);
    const connection = this.connection;
    if (connection === void 0) throw new Error("the browser connection is not open");
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    const view = new BrowserView({
      connection,
      targetId,
      sessionId,
      sink: this.viewSink(),
      log: this.options.log,
      quality: this.options.quality,
      viewport: this.viewport
    });
    this.views.set(sessionId, view);
    this.activeViewId = sessionId;
    try {
      await view.start(url);
    } catch (error) {
      this.views.delete(sessionId);
      await view.close().catch(() => {
      });
      throw error;
    }
    this.options.sink.onViews(this);
    return view;
  }
  /**
   * Make an existing tab the one viewers see.
   * @param viewId - the view's CDP session id.
   */
  async selectView(viewId) {
    if (!this.views.has(viewId)) throw new Error(`no browser view "${viewId}"`);
    const previous = this.activeView;
    this.activeViewId = viewId;
    if (previous !== void 0 && previous.sessionId !== viewId) await previous.stopStreaming();
    const view = this.views.get(viewId);
    if (view !== void 0 && this.viewers > 0) await view.startStreaming();
    this.options.sink.onViews(this);
  }
  /**
   * Close one tab.
   * @param viewId - the view to close.
   */
  async closeView(viewId) {
    const view = this.views.get(viewId);
    if (view === void 0) return;
    this.views.delete(viewId);
    await view.close();
    if (this.activeViewId === viewId) {
      const next = [...this.views.keys()].at(-1);
      this.activeViewId = next;
      const view2 = next === void 0 ? void 0 : this.views.get(next);
      if (view2 !== void 0 && this.viewers > 0) await view2.startStreaming();
    }
    this.options.sink.onViews(this);
  }
  /** Record that a party used the browser, which defers idle reclamation. */
  touch() {
    this.lastActivityAt = Date.now();
  }
  /**
   * React to the browser connection ending.
   *
   * Every view is gone with it, and `state` must stop claiming "ready": the
   * next `ensureStarted` relaunches Chromium rather than answering from a dead
   * session. A dispose already in progress is left alone.
   * @param error - why the connection ended.
   */
  handleConnectionLost(error) {
    if (this.disposed || this.state === "closed") return;
    this.options.log.warn("the browser connection closed", error);
    this.state = "failed";
    this.failure = "the browser connection closed; the next call starts a new browser";
    this.connection = void 0;
    this.views.clear();
    this.activeViewId = void 0;
    this.starting = void 0;
    this.options.sink.onViews(this);
  }
  /**
   * Reclaim a browser nobody is watching.
   *
   * A viewer that stops existing (a closed tab, a closed browser window, a
   * crash) must not leave a Chromium process running forever: that is how
   * abandoned windows pile up on the user's desktop. The grace is generous
   * because collapsing the sidebar and switching Sessions both drop the viewer
   * while the user still considers the browser theirs.
   */
  startIdleWatch() {
    if (this.options.idleTimeoutMs <= 0) return;
    const interval = Math.max(5e3, Math.min(3e4, Math.floor(this.options.idleTimeoutMs / 4)));
    this.idleTimer = setInterval(() => {
      if (this.disposed || this.viewers > 0 || this.busy > 0) return;
      if (Date.now() - this.lastActivityAt < this.options.idleTimeoutMs) return;
      this.options.log.info("closing an idle browser nobody is watching");
      void this.dispose("idle reclamation");
    }, interval);
    this.idleTimer.unref?.();
  }
  /** Close the browser and every view. Idempotent. */
  async dispose(reason) {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer !== void 0) {
      clearInterval(this.idleTimer);
      this.idleTimer = void 0;
    }
    this.state = "closed";
    this.options.log.info(`closing browser session (${reason})`);
    for (const view of [...this.views.values()]) {
      this.views.delete(view.sessionId);
      await view.close().catch((error) => {
        this.options.log.debug("view close failed", error);
      });
    }
    this.connection?.close();
    this.connection = void 0;
    const launch = this.launch;
    this.launch = void 0;
    if (launch !== void 0) {
      await launch.close().catch((error) => {
        this.options.log.warn("browser close failed", error);
      });
      if (this.options.profileKind === "ephemeral") {
        rmSync2(launch.profileDir, { recursive: true, force: true });
      }
    }
    this.onDispose?.();
  }
  async start() {
    try {
      mkdirSync2(this.options.profileRoot, { recursive: true, mode: 448 });
      const launch = await launchBrowser({
        executablePath: this.options.executablePath,
        profileDir: join2(this.options.profileRoot, "chromium"),
        headed: this.options.headed,
        viewport: this.options.viewport,
        startTimeoutMs: this.options.startTimeoutMs
      });
      this.launch = launch;
      this.options.log.info(`browser started: ${launch.version} on port ${launch.port}`);
      const { connection } = await connectCdp(launch.webSocketDebuggerUrl);
      this.connection = connection;
      connection.onClose((error) => {
        this.handleConnectionLost(error);
      });
      connection.onEvent((event) => {
        if (event.method === "Target.targetDestroyed") {
          const targetId = event.params?.targetId;
          const view = [...this.views.values()].find((candidate) => candidate.targetId === targetId);
          if (view !== void 0) void this.closeView(view.sessionId);
        }
      });
      this.state = "ready";
      this.startIdleWatch();
      await this.createView(this.options.initialUrl);
    } catch (error) {
      this.state = "failed";
      this.failure = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && "hint" in error && typeof error.hint === "string") {
        this.failure = `${this.failure} \u2014 ${error.hint}`;
      }
      this.starting = void 0;
      this.options.log.error("browser session failed to start", error);
      this.options.sink.onError(this, error instanceof Error ? error : new Error(String(error)));
      await this.dispose("startup failed").catch(() => {
      });
      throw error;
    }
  }
  viewSink() {
    return {
      onFrame: (view, frame) => {
        this.options.sink.onFrame(this, view, frame);
      },
      onNavigation: (view) => {
        this.options.sink.onViews(this);
        void view;
      },
      onCursor: () => {
      },
      onClosed: (view, reason) => {
        this.views.delete(view.sessionId);
        if (this.activeViewId === view.sessionId) this.activeViewId = [...this.views.keys()].at(-1);
        this.options.log.debug(`view closed: ${reason}`);
        this.options.sink.onViews(this);
      },
      onError: (view, error) => {
        this.options.log.warn(`view ${view.sessionId} reported an error`, error);
      }
    };
  }
};
async function withSignal(promise, signal) {
  if (signal === void 0) return await promise;
  if (signal.aborted) throw new Error("cancelled");
  return await new Promise((resolve, reject) => {
    const abort = () => {
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

// src/host/profiles.ts
import { createHash } from "node:crypto";
import { mkdirSync as mkdirSync3, rmSync as rmSync3 } from "node:fs";
import { homedir } from "node:os";
import { join as join3 } from "node:path";
function createProfiles(options) {
  const root = options.root ?? defaultRoot(options.persistent);
  const issued = /* @__PURE__ */ new Map();
  return {
    /** Root under which every profile lives; shown in the UI. */
    root,
    /**
     * Profile directory for one Agent.
     * @param owner - the Agent whose browser this profile belongs to.
     * @returns an existing, 0700 directory.
     */
    directoryFor(owner) {
      const key = owner.workspace?.cwd ?? owner.id;
      const digest = createHash("sha256").update(`${key}\0${options.persistent ? "p" : "e"}`).digest("hex").slice(0, 16);
      const directory = join3(root, digest);
      mkdirSync3(directory, { recursive: true, mode: 448 });
      const forOwner = issued.get(owner.id) ?? /* @__PURE__ */ new Set();
      forOwner.add(directory);
      issued.set(owner.id, forOwner);
      return directory;
    },
    /**
     * Remove the profiles handed out to one Agent.
     * @param agentId - the Agent whose directories to delete.
     */
    async clear(agentId) {
      const directories = issued.get(agentId);
      if (directories === void 0) return;
      for (const directory of directories) rmSync3(directory, { recursive: true, force: true });
      issued.delete(agentId);
    },
    /** Remove the entire profile root, for an explicit "forget everything" action. */
    async clearAll() {
      rmSync3(root, { recursive: true, force: true });
      issued.clear();
    }
  };
}
function defaultRoot(persistent) {
  const home = process.env.DSH_HOME ?? join3(homedir(), ".dsh");
  return persistent ? join3(home, "browser-profiles") : join3(process.env.TMPDIR ?? "/tmp", "dsh-browser-profiles");
}

// src/host/orphans.ts
import { existsSync as existsSync2, lstatSync, readdirSync as readdirSync2, readFileSync as readFileSync2, readlinkSync, rmSync as rmSync4 } from "node:fs";
import { hostname } from "node:os";
import { join as join4 } from "node:path";
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function adoptOrphans(root) {
  if (!existsSync2(root)) return { scanned: 0, killed: [], stale: [] };
  let entries;
  try {
    entries = readdirSync2(root);
  } catch {
    return { scanned: 0, killed: [], stale: [] };
  }
  const killed = [];
  const stale = [];
  let scanned = 0;
  for (const entry of entries) {
    const profileDir = join4(root, entry, "chromium");
    if (!existsSync2(profileDir)) continue;
    scanned++;
    const lock = join4(profileDir, "SingletonLock");
    if (!present(lock)) continue;
    const target = (() => {
      try {
        return readlinkSync(lock);
      } catch {
        return "";
      }
    })();
    const [lockHost, lockPidText] = (() => {
      const index = target.lastIndexOf("-");
      return index < 0 ? ["", ""] : [target.slice(0, index), target.slice(index + 1)];
    })();
    const pid = Number(lockPidText);
    if (lockHost !== hostname() || !Number.isInteger(pid) || pid <= 0) {
      for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        rmSync4(join4(profileDir, name), { force: true });
      }
      stale.push(profileDir);
      continue;
    }
    if (alive(pid) && isChromium(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        killed.push(pid);
      } catch {
      }
    }
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      rmSync4(join4(profileDir, name), { force: true });
    }
    stale.push(profileDir);
  }
  return { scanned, killed, stale };
}
function isChromium(pid) {
  try {
    const command = readFileSync2(`/proc/${pid}/cmdline`, "utf8");
    return /chrome|chromium/iu.test(command);
  } catch {
    return false;
  }
}

// src/host/index.ts
var Config = Schema.object({
  executablePath: Schema.string().description("Chromium executable"),
  headed: Schema.boolean().default(true).volatile().description("Show a Chromium window on the Host display; turn off to run headless"),
  persistentProfile: Schema.boolean().default(true).volatile().description("Keep cookies and logins across restarts"),
  width: Schema.number().min(360).max(1920).default(1280).description("Browser viewport width"),
  height: Schema.number().min(300).max(1200).default(800).description("Browser viewport height"),
  quality: Schema.number().min(20).max(95).default(62).volatile().description("Mirror JPEG quality: lower is faster, higher is sharper"),
  maxSessions: Schema.number().min(1).max(8).default(2).description("Concurrent browsers"),
  humanIdleMs: Schema.number().min(0).default(6e5).volatile().description("Milliseconds before a forgotten human takeover lapses; 0 never lapses"),
  idleTimeoutMs: Schema.number().min(0).default(3e5).volatile().description("Close a browser with no viewer and no activity after this long; 0 keeps it open"),
  startUrl: Schema.string().default("about:blank").description("Address a new browser opens"),
  chromiumArgs: Schema.array(Schema.string()).description("Extra Chromium switches")
});
var VERSION = true ? "0.3.0" : "development";
function apply(ctx, config) {
  const log = {
    debug: (message2, error) => {
      ctx.logger.debug(message2, error);
    },
    info: (message2) => {
      ctx.logger.info(message2);
    },
    warn: (message2, error) => {
      ctx.logger.warn(message2, error);
    },
    error: (message2, error) => {
      ctx.logger.error(message2, error);
    }
  };
  const setting = {
    headed: () => config.headed.get() ?? true,
    persistentProfile: () => config.persistentProfile.get() ?? true,
    quality: () => config.quality.get() ?? 62,
    humanIdleMs: () => config.humanIdleMs.get() ?? 6e5,
    idleTimeoutMs: () => config.idleTimeoutMs.get() ?? 3e5
  };
  log.info(`dsh-browser ${VERSION} starting`);
  const executablePath = config.executablePath ?? discoverExecutable();
  if (executablePath === void 0) {
    log.warn("no Chromium executable found; dsh-browser stays inert until one is configured");
  }
  const profiles = createProfiles({ persistent: setting.persistentProfile() });
  void adoptOrphans(profiles.root).then((sweep) => {
    if (sweep.killed.length > 0) log.warn(`closed ${sweep.killed.length} browser(s) left by a previous Host`);
  }).catch((error) => {
    log.warn("could not adopt browsers left by a previous Host", error);
  });
  const entries = /* @__PURE__ */ new Map();
  const viewers = /* @__PURE__ */ new Map();
  const statusFor = (agentId) => {
    const entry = entries.get(agentId);
    if (entry === void 0) return void 0;
    const snapshot = entry.session.snapshot();
    return {
      protocol: 1,
      version: VERSION,
      state: snapshot.lease.state,
      holder: snapshot.lease.holder,
      leaseExpiresAt: snapshot.lease.expiresAt,
      views: snapshot.views,
      activeViewId: snapshot.activeViewId,
      viewport: snapshot.viewport,
      request: entry.session.pendingRequest,
      profile: setting.persistentProfile() ? "persistent" : "ephemeral",
      watching: viewers.get(agentId)?.size ?? 0,
      runs: { active: entries.size, max: config.maxSessions }
    };
  };
  const broadcast = (agentId, frame) => {
    const sockets = viewers.get(agentId);
    if (sockets === void 0) return;
    const text = JSON.stringify(frame);
    for (const socket of sockets) if (socket.readyState === 1) socket.send(text);
  };
  const sessionFor = (agent, agentId) => {
    const existing = entries.get(agentId);
    if (existing !== void 0) return existing.session;
    if (entries.size >= config.maxSessions) {
      throw new Error(`dsh-browser already runs ${entries.size} browsers; close one before opening another (limit: ${config.maxSessions})`);
    }
    if (executablePath === void 0) {
      throw new Error('no Chromium executable is available: set dsh-browser executablePath, or set DSH_BROWSER_EXECUTABLE, or run "npx playwright install chromium"');
    }
    const profileRoot = profiles.directoryFor(agent);
    const session = new BrowserSession({
      log,
      executablePath,
      profileRoot,
      profileKind: setting.persistentProfile() ? "persistent" : "ephemeral",
      headed: setting.headed(),
      viewport: { width: config.width, height: config.height },
      quality: setting.quality(),
      startTimeoutMs: 2e4,
      humanIdleMs: setting.humanIdleMs(),
      idleTimeoutMs: setting.idleTimeoutMs(),
      initialUrl: normalizeAddress(config.startUrl) ?? "about:blank",
      sink: {
        onFrame(_session, view, frame) {
          const sockets = viewers.get(agentId);
          if (sockets === void 0 || sockets.size === 0) return;
          const header = Buffer.alloc(FRAME_HEADER_BYTES);
          header.writeUInt8(FRAME_MAGIC, 0);
          header.writeUInt32BE(frame.frameId >>> 0, 1);
          const payload = Buffer.concat([header, frame.jpeg]);
          for (const socket of sockets) if (socket.readyState === 1) socket.send(payload, { binary: true });
          void view;
        },
        onViews(owner) {
          const snapshot = owner.snapshot();
          broadcast(agentId, { t: "views", views: snapshot.views, activeViewId: snapshot.activeViewId });
        },
        onLease(_owner, transition) {
          broadcast(agentId, {
            t: "state",
            state: transition.after.state,
            holder: transition.after.holder,
            leaseExpiresAt: transition.after.expiresAt
          });
        },
        onError(_owner, error) {
          broadcast(agentId, { t: "error", code: "browser/error", message: error.message });
        }
      }
    });
    entries.set(agentId, { session, disposal: void 0 });
    return session;
  };
  const requireSession = (agentId) => {
    const entry = entries.get(agentId);
    if (entry === void 0) throw new Error("no browser is open for this Session; open one from the sidebar, or call browser_open");
    return entry.session;
  };
  ctx.inject(["tools"], (toolCtx) => registerTools(toolCtx, {
    log,
    config,
    getSession: (agent) => sessionFor(agent, agent.id),
    requireSession: (agentId) => requireSession(agentId),
    executableAvailable: () => executablePath !== void 0
  }));
  ctx.inject(["tools"], (toolsCtx) => {
    toolsCtx.effect(() => toolsCtx.tools.guard((exec) => {
      if (!exec.name.startsWith("browser_")) return void 0;
      const agent = exec.agent;
      if (agent === void 0) return void 0;
      const entry = entries.get(agent.id);
      if (entry === void 0) return void 0;
      if (entry.session.allowsAgent) return void 0;
      return "a human is controlling the side-panel browser; wait for them to hand it back";
    }), "dsh-browser: control guard");
  });
  ctx.effect(() => () => {
    for (const entry of entries.values()) void entry.session.dispose("the Host shut down");
  }, "dsh-browser: shutdown cleanup");
  ctx.on("agent/disposed", ({ agent }) => {
    const entry = entries.get(agent.id);
    if (entry === void 0) return;
    entries.delete(agent.id);
    viewers.delete(agent.id);
    void entry.session.dispose("the Session was disposed");
  });
  ctx.inject(["connection"], (connectionCtx) => {
    const connection = connectionCtx.connection;
    connectionCtx.effect(() => connection.fetch.register({
      path: ROUTE_STATUS,
      methods: ["GET"],
      requestBody: "buffered",
      async fetch(request) {
        const agentId = new URL(request.url).searchParams.get("agentId") ?? "";
        const status = statusFor(agentId);
        if (status === void 0) return Response.json({ protocol: 1, version: VERSION, state: "idle", views: [], watching: 0, runs: { active: 0, max: config.maxSessions } });
        return Response.json(status);
      }
    }), "dsh-browser: status route");
    connectionCtx.effect(() => connection.fetch.register({
      path: ROUTE_VIEWS,
      methods: ["GET"],
      requestBody: "buffered",
      async fetch(request) {
        const agentId = new URL(request.url).searchParams.get("agentId") ?? "";
        const status = statusFor(agentId);
        return Response.json({ views: status?.views ?? [], activeViewId: status?.activeViewId });
      }
    }), "dsh-browser: views route");
    connectionCtx.effect(() => connection.fetch.register({
      path: ROUTE_PROFILE,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const body = await request.json().catch(() => ({}));
        if (body.agentId === void 0 || body.action !== "clear") return new Response("bad request", { status: 400 });
        const entry = entries.get(body.agentId);
        if (entry !== void 0) {
          entries.delete(body.agentId);
          await entry.session.dispose("profile cleared");
        }
        await profiles.clear(body.agentId);
        return Response.json({ cleared: true });
      }
    }), "dsh-browser: profile route");
  });
  ctx.inject(["webServer", "connection", "agents"], (webCtx) => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    webCtx.effect(() => webCtx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: (req, socket, head) => {
        const rejection = webCtx.connection.requestRejection(req);
        if (rejection !== void 0) {
          socket.end(`HTTP/1.1 ${rejection} ${rejection === 401 ? "Unauthorized" : "Forbidden"}\r
Connection: close\r
Content-Length: 0\r
\r
`);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const url = new URL(req.url ?? "/", "http://dsh.invalid");
          const agentId = url.searchParams.get("agentId") ?? "";
          void handleViewer(ws, agentId);
        });
      }
    }), "dsh-browser: screencast upgrade");
    const handleViewer = async (ws, agentId) => {
      if (agentId === "") {
        ws.close(4400, "agentId is required");
        return;
      }
      const agent = webCtx.agents.get(agentId);
      if (agent === void 0) {
        ws.close(4404, "unknown Session");
        return;
      }
      const early = [];
      let live = false;
      const onEarly = (raw) => {
        if (!live) early.push(raw.toString());
      };
      ws.on("message", onEarly);
      let session;
      try {
        session = sessionFor(agent, agentId);
        await session.attachViewer();
      } catch (error) {
        if (entries.get(agentId)?.session === session) entries.delete(agentId);
        ws.send(JSON.stringify({ t: "error", code: "browser/start", message: describe(error) }));
        ws.close();
        return;
      }
      const sockets = viewers.get(agentId) ?? /* @__PURE__ */ new Set();
      viewers.set(agentId, sockets);
      sockets.add(ws);
      const snapshot = session.snapshot();
      ws.send(JSON.stringify({
        t: "ready",
        proto: 1,
        state: snapshot.lease.state,
        views: snapshot.views,
        activeViewId: snapshot.activeViewId,
        viewport: snapshot.viewport
      }));
      ws.on("close", () => {
        sockets.delete(ws);
        if (sockets.size === 0) {
          viewers.delete(agentId);
          session.detachViewer();
        }
      });
      ws.on("error", (error) => {
        log.debug("viewer socket error", error);
      });
      ws.off("message", onEarly);
      live = true;
      ws.on("message", async (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }
        try {
          await handleClientFrame(session, ws, frame);
        } catch (error) {
          ws.send(JSON.stringify({ t: "error", code: "browser/failed", message: describe(error) }));
        }
      });
      for (const raw of early) {
        try {
          await handleClientFrame(session, ws, JSON.parse(raw));
        } catch {
        }
      }
    };
    const handleClientFrame = async (session, ws, frame) => {
      const view = session.activeView;
      switch (frame.t) {
        case "hello":
          if (frame.proto !== 1) ws.close(4400, "protocol mismatch");
          break;
        case "ack":
          view?.ackFrame(frame.frameId);
          break;
        case "resize": {
          await session.resize({ width: frame.cssWidth, height: frame.cssHeight }, frame.devicePixelRatio ?? 1);
          const viewport = session.snapshot().viewport;
          ws.send(JSON.stringify({ t: "viewport", width: viewport.width, height: viewport.height }));
          break;
        }
        case "navigate": {
          const url = normalizeAddress(frame.url);
          if (url === void 0) {
            ws.send(JSON.stringify({ t: "error", code: "address/rejected", message: "only http and https addresses are supported" }));
            return;
          }
          await view?.navigate(url);
          break;
        }
        case "back":
          await view?.back();
          break;
        case "forward":
          await view?.forward();
          break;
        case "reload":
          await view?.reload();
          break;
        case "control":
          if (frame.action === "take") await session.claimHuman();
          else session.releaseToAgent();
          break;
        case "human-done":
          session.finishHumanRequest("released");
          session.releaseToAgent();
          break;
        case "view":
          if (frame.action === "create") await session.createView("about:blank");
          else if (frame.action === "close" && frame.viewId !== void 0) await session.closeView(frame.viewId);
          else if (frame.action === "select" && frame.viewId !== void 0) await session.selectView(frame.viewId);
          break;
        case "mouse":
        case "wheel":
        case "key":
        case "text": {
          if (!session.allowsHuman) {
            ws.send(JSON.stringify({ t: "error", code: "control/denied", message: "the Agent holds the browser; take control first" }));
            return;
          }
          session.touchHuman();
          if (frame.t === "mouse") await view?.mouse(frame);
          else if (frame.t === "wheel") await view?.wheel(frame);
          else if (frame.t === "key") await view?.key(frame);
          else await view?.insertText(frame.text);
          break;
        }
        default:
          break;
      }
    };
    const agentIdOf = (session) => {
      for (const [id, entry] of entries) if (entry.session === session) return id;
      return "";
    };
  });
}
function describe(error) {
  if (error instanceof LaunchError) return `${error.message} \u2014 ${error.hint}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
export {
  Config,
  apply
};
