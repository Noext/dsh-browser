window.__ModuleLoader__.load({ id: "@noext34/dsh-browser", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  TAB_KIND: () => TAB_KIND,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/body.tsx
var import_react2 = require("react");

// src/shared/protocol.ts
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

// src/shared/geometry.ts
var MIN_VIEWPORT = { width: 360, height: 300 };
var MAX_VIEWPORT = { width: 1920, height: 1200 };
function viewportFor(pane, fallback) {
  const width = Number.isFinite(pane.width) ? Math.floor(pane.width) : 0;
  const height = Number.isFinite(pane.height) ? Math.floor(pane.height) : 0;
  if (width < MIN_VIEWPORT.width || height < MIN_VIEWPORT.height) {
    return {
      width: Math.max(MIN_VIEWPORT.width, Math.min(MAX_VIEWPORT.width, fallback.width)),
      height: Math.max(MIN_VIEWPORT.height, Math.min(MAX_VIEWPORT.height, fallback.height))
    };
  }
  return {
    width: Math.min(MAX_VIEWPORT.width, width),
    height: Math.min(MAX_VIEWPORT.height, height)
  };
}
function bitmapSizeFor(viewport, devicePixelRatio = 1) {
  const ratio = Number.isFinite(devicePixelRatio) ? Math.min(2, Math.max(1, devicePixelRatio)) : 1;
  return {
    width: Math.max(1, Math.round(viewport.width * ratio)),
    height: Math.max(1, Math.round(viewport.height * ratio))
  };
}
function toPagePoint(event, rect, viewport) {
  if (rect.width <= 0 || rect.height <= 0) return void 0;
  const ratioX = viewport.width / rect.width;
  const ratioY = viewport.height / rect.height;
  const x = (event.x - rect.left) * ratioX;
  const y = (event.y - rect.top) * ratioY;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return void 0;
  return { x: Math.round(x), y: Math.round(y) };
}
function toPageDelta(delta, viewport, rect) {
  if (rect.height <= 0) return delta;
  return delta * (viewport.height / rect.height);
}
function modifiersOf(event) {
  return (event.altKey === true ? 1 : 0) | (event.ctrlKey === true ? 2 : 0) | (event.metaKey === true ? 4 : 0) | (event.shiftKey === true ? 8 : 0);
}

// src/client/copy.ts
var copy = {
  "tab.title": "Browser",
  "guide.title": "Browser",
  "guide.description": "Drive a real Chromium beside this conversation, and take over to sign in.",
  "toolbar.back": "Back",
  "toolbar.forward": "Forward",
  "toolbar.reload": "Reload",
  "toolbar.go": "Go",
  "toolbar.address": "Address",
  "control.take": "Take control",
  "control.release": "Hand back",
  "control.agent": "Agent is driving",
  "control.human": "You are driving",
  "control.request": "The agent needs your help",
  "control.done": "Done \u2014 hand back",
  "control.idle": "Idle",
  "state.connecting": "Connecting to the browser\u2026",
  "state.reconnecting": "Connection lost \u2014 reconnecting\u2026",
  "state.starting": "Starting Chromium\u2026",
  "state.failed": "The browser could not start",
  "state.retry": "Retry",
  "state.closed": "The browser was closed",
  "state.unsupported": "This tab needs the dsh-browser Host plugin",
  "request.title": "The agent needs your help",
  "settings.title": "Browser settings",
  "settings.save": "Save",
  "settings.reset": "Reset to default",
  "settings.refused": "The Host refused this change.",
  "settings.overridden": "Changed",
  "row.headed": "Show a Chromium window",
  "row.headedHelp": "Off runs the browser headless: the mirror in the sidebar keeps working, but no window opens on the desktop.",
  "row.profile": "Keep cookies and logins",
  "row.profileHelp": "Stores the browser profile on disk so a sign-in survives a restart. Turned off, each browser starts clean.",
  "row.quality": "Mirror quality",
  "row.qualityHelp": "JPEG quality of the mirror, 20 to 95. Lower is faster over a slow link; higher keeps small text readable.",
  "row.humanIdle": "Takeover timeout",
  "row.humanIdleHelp": "Minutes before a forgotten human takeover hands the browser back to the agent. Zero never hands it back.",
  "row.idleTimeout": "Idle shutdown",
  "row.idleTimeoutHelp": "Minutes after which a browser nobody is watching closes itself. Zero keeps it open until the Session ends."
};

// src/client/useStyle.ts
var import_react = require("react");

// src/client/style.ts
var STYLE_ID = "dsh-browser-style";
var STYLE_TEXT = '.dsh-browser-root {\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  min-height: 0;\n  background: var(--dsh-surface, #141413);\n  color: var(--dsh-text, #e8e6e3);\n  font: 12px/1.4 var(--dsh-font-sans, system-ui, sans-serif);\n}\n\n.dsh-browser-bar {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 6px 8px;\n  border-bottom: 1px solid var(--dsh-border, #2a2a28);\n}\n\n.dsh-browser-bar button {\n  background: transparent;\n  border: 1px solid transparent;\n  border-radius: 6px;\n  color: inherit;\n  cursor: pointer;\n  min-width: 24px;\n  height: 24px;\n  padding: 0 4px;\n}\n\n.dsh-browser-bar button:hover {\n  background: var(--dsh-surface-raised, #262624);\n  border-color: var(--dsh-border, #383835);\n}\n\n.dsh-browser-address {\n  flex: 1;\n  min-width: 0;\n  background: var(--dsh-surface-raised, #1e1e1c);\n  border: 1px solid var(--dsh-border, #333330);\n  border-radius: 6px;\n  color: inherit;\n  font: inherit;\n  padding: 4px 8px;\n}\n\n.dsh-browser-badge {\n  white-space: nowrap;\n  padding: 2px 6px;\n  border-radius: 999px;\n  border: 1px solid var(--dsh-border, #383835);\n  font-size: 11px;\n  color: var(--dsh-text-muted, #8a8a84);\n}\n\n.dsh-browser-badge--human {\n  color: #f0b429;\n  border-color: #f0b42955;\n}\n\n.dsh-browser-badge--agent {\n  color: #4a9fd4;\n  border-color: #4a9fd455;\n}\n\n.dsh-browser-action {\n  white-space: nowrap;\n}\n\n.dsh-browser-request {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 8px 10px;\n  background: #f0b4291a;\n  border-bottom: 1px solid #f0b42955;\n  color: #f0b429;\n}\n\n.dsh-browser-notice {\n  padding: 6px 10px;\n  color: var(--dsh-text-muted, #8a8a84);\n  border-bottom: 1px solid var(--dsh-border, #2a2a28);\n}\n\n.dsh-browser-stage {\n  flex: 1;\n  min-height: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  overflow: hidden;\n  background: #0f0f0e;\n}\n\n.dsh-browser-canvas {\n  display: block;\n  max-width: 100%;\n  max-height: 100%;\n  outline: none;\n  background: #000;\n  cursor: default;\n}\n\n.dsh-browser-canvas:focus {\n  outline: 2px solid #4a7fd4;\n  outline-offset: -2px;\n}\n\n.dsh-browser-status {\n  display: flex;\n  gap: 10px;\n  justify-content: space-between;\n  padding: 4px 8px;\n  border-top: 1px solid var(--dsh-border, #2a2a28);\n  color: var(--dsh-text-muted, #8a8a84);\n  font-size: 11px;\n  white-space: nowrap;\n  overflow: hidden;\n}\n.dsh-browser-status-title {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  flex: 1;\n  min-width: 0;\n}\n.dsh-browser-settings {\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n  padding: 4px 0;\n}\n\n.dsh-browser-settings-title {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.dsh-browser-setting {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.dsh-browser-setting label,\n.dsh-browser-setting-toggle {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: 12px;\n  font-weight: 500;\n}\n\n.dsh-browser-setting input[type="number"] {\n  width: 8em;\n  background: var(--dsh-surface-raised, #1e1e1c);\n  border: 1px solid var(--dsh-border, #333330);\n  border-radius: 6px;\n  /* An explicit colour, not `inherit`: the surrounding page sets its own text\n     colour, which leaves the value unreadable on the dark field. */\n  color: var(--dsh-text, #e8e6e3);\n  font: inherit;\n  padding: 3px 6px;\n}\n\n.dsh-browser-setting-help {\n  margin: 0;\n  color: var(--dsh-text-muted, #8a8a84);\n  font-size: 11px;\n  line-height: 1.45;\n}\n\n.dsh-browser-setting-changed {\n  color: #4a9fd4;\n  font-weight: 400;\n}\n\n.dsh-browser-setting-reset {\n  align-self: flex-start;\n  background: none;\n  border: none;\n  color: var(--dsh-text-muted, #8a8a84);\n  cursor: pointer;\n  font: inherit;\n  font-size: 11px;\n  padding: 0;\n  text-decoration: underline;\n}';

// src/client/useStyle.ts
function usePluginStyle() {
  (0, import_react.useEffect)(() => {
    if (document.getElementById(STYLE_ID) !== null) return;
    const tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.textContent = STYLE_TEXT;
    document.head.appendChild(tag);
  }, []);
}

// src/client/body.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var VK = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Escape: 27,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  " ": 32
};
function vkOf(event) {
  const named = VK[event.key];
  if (named !== void 0) return named;
  if (event.key.length === 1) return event.key.toUpperCase().charCodeAt(0);
  return event.keyCode;
}
function BrowserBody(props) {
  const { useTabInfo, sessionId } = props;
  const tabInfo = useTabInfo();
  usePluginStyle();
  const canvasRef = (0, import_react2.useRef)(null);
  const socketRef = (0, import_react2.useRef)(null);
  const viewportRef = (0, import_react2.useRef)({ width: 1280, height: 800 });
  const resizeRef = (0, import_react2.useRef)(() => {
  });
  const [address, setAddress] = (0, import_react2.useState)("");
  const [title, setTitle] = (0, import_react2.useState)("");
  const [views, setViews] = (0, import_react2.useState)([]);
  const [activeViewId, setActiveViewId] = (0, import_react2.useState)(void 0);
  const [control, setControl] = (0, import_react2.useState)("idle");
  const [request, setRequest] = (0, import_react2.useState)(void 0);
  const [status, setStatus] = (0, import_react2.useState)({ fps: 0, width: 1280, height: 800 });
  const [connection, setConnection] = (0, import_react2.useState)("connecting");
  const [failure, setFailure] = (0, import_react2.useState)(void 0);
  const [loading, setLoading] = (0, import_react2.useState)(false);
  (0, import_react2.useEffect)(() => {
    let disposed = false;
    let retry = 0;
    let timer;
    let frames = 0;
    let windowStart = performance.now();
    let bitmapQueue = Promise.resolve();
    const draw = (blob) => {
      bitmapQueue = bitmapQueue.then(async () => {
        const canvas = canvasRef.current;
        if (canvas === null || disposed) return;
        const bitmap = await createImageBitmap(blob);
        try {
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        } finally {
          bitmap.close();
        }
        frames++;
        const now = performance.now();
        if (now - windowStart >= 1e3) {
          const fps = Math.round(frames * 1e3 / (now - windowStart));
          frames = 0;
          windowStart = now;
          setStatus((previous) => previous.fps === fps ? previous : { ...previous, fps });
        }
      }).catch(() => {
      });
    };
    const connect = () => {
      if (disposed) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${location.host}${WS_PATH}?agentId=${encodeURIComponent(sessionId)}`;
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.binaryType = "arraybuffer";
      setConnection("connecting");
      socket.onopen = () => {
        retry = 0;
        setConnection("open");
        setFailure(void 0);
        socket.send(JSON.stringify({ t: "hello", proto: 1 }));
        lastSent = { width: 0, height: 0 };
        fit();
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const frame = JSON.parse(event.data);
          applyServerFrame(frame);
          return;
        }
        const buffer = event.data;
        const view = new DataView(buffer);
        if (view.getUint8(0) !== FRAME_MAGIC) return;
        const frameId = view.getUint32(1);
        draw(new Blob([new Uint8Array(buffer, FRAME_HEADER_BYTES)], { type: "image/jpeg" }));
        socket.send(JSON.stringify({ t: "ack", frameId }));
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnection("lost");
        retry++;
        timer = setTimeout(connect, Math.min(8e3, 500 * retry));
      };
      socket.onerror = () => {
        socket.close();
      };
    };
    const applyServerFrame = (frame) => {
      switch (frame.t) {
        case "ready":
          setControl(frame.state);
          setViews(frame.views);
          setActiveViewId(frame.activeViewId);
          if (lastSent.width === 0) viewportRef.current = frame.viewport;
          queueMicrotask(() => {
            resizeRef.current();
          });
          break;
        case "views":
          setViews(frame.views);
          setActiveViewId(frame.activeViewId);
          break;
        case "nav":
          setAddress(frame.url);
          setTitle(frame.title);
          setLoading(frame.loading);
          break;
        case "state":
          setControl(frame.state);
          if (frame.state !== "human") setRequest(void 0);
          break;
        case "request":
          setRequest({ reason: frame.reason });
          break;
        case "request-done":
          setRequest(void 0);
          break;
        case "viewport":
          if (frame.width !== viewportRef.current.width || frame.height !== viewportRef.current.height) {
            viewportRef.current = { width: frame.width, height: frame.height };
            lastSent = { width: frame.width, height: frame.height };
            queueMicrotask(() => {
              resizeRef.current();
            });
          }
          break;
        case "error":
          setFailure(frame.message);
          break;
        default:
          break;
      }
    };
    let lastSent = { width: 0, height: 0 };
    const send2 = (frame) => {
      const socket = socketRef.current;
      if (socket?.readyState === 1) socket.send(JSON.stringify(frame));
    };
    const RESIZE_THRESHOLD = 8;
    const fit = () => {
      const canvas = canvasRef.current;
      const stage2 = canvas?.parentElement;
      if (canvas === null || stage2 === null || stage2 === void 0) return;
      const box = stage2.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const viewport = viewportFor({ width: box.width, height: box.height }, viewportRef.current);
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      const bitmap = bitmapSizeFor(viewport, dpr);
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      setStatus((previous) => previous.width === viewport.width && previous.height === viewport.height ? previous : { ...previous, width: viewport.width, height: viewport.height });
      if (Math.abs(viewport.width - lastSent.width) < RESIZE_THRESHOLD && Math.abs(viewport.height - lastSent.height) < RESIZE_THRESHOLD) return;
      viewportRef.current = viewport;
      lastSent = viewport;
      send2({
        t: "resize",
        cssWidth: viewport.width,
        cssHeight: viewport.height,
        devicePixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      });
    };
    resizeRef.current = fit;
    const observer = new ResizeObserver(() => {
      fit();
    });
    const stage = canvasRef.current?.parentElement;
    if (stage !== null && stage !== void 0) observer.observe(stage);
    fit();
    connect();
    return () => {
      disposed = true;
      if (timer !== void 0) clearTimeout(timer);
      observer.disconnect();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [sessionId]);
  const send = (0, import_react2.useCallback)((frame) => {
    const socket = socketRef.current;
    if (socket?.readyState === 1) socket.send(JSON.stringify(frame));
  }, []);
  const acceptsInput = control === "human";
  const point = (event) => {
    const canvas = event.currentTarget;
    return toPagePoint(
      { x: event.clientX, y: event.clientY },
      canvas.getBoundingClientRect(),
      viewportRef.current
    );
  };
  const onPointerDown = (event) => {
    event.currentTarget.focus();
    if (!acceptsInput) return;
    const mapped = point(event);
    if (mapped === void 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const button = event.button === 2 ? 2 : event.button === 1 ? 1 : 0;
    send({ t: "mouse", type: "down", ...mapped, button, clickCount: 1, modifiers: modifiersOf(event) });
  };
  const onPointerUp = (event) => {
    if (!acceptsInput) return;
    const mapped = point(event);
    if (mapped === void 0) return;
    const button = event.button === 2 ? 2 : event.button === 1 ? 1 : 0;
    send({ t: "mouse", type: "up", ...mapped, button, clickCount: 1, modifiers: modifiersOf(event) });
  };
  const onPointerMove = (event) => {
    if (!acceptsInput) return;
    const mapped = point(event);
    if (mapped === void 0) return;
    send({ t: "mouse", type: "move", ...mapped, button: 0, clickCount: 0, modifiers: modifiersOf(event) });
  };
  const onWheel = (event) => {
    if (!acceptsInput) return;
    const mapped = toPagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), viewportRef.current);
    if (mapped === void 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    send({
      t: "wheel",
      ...mapped,
      dx: Math.round(toPageDelta(-event.deltaX, viewportRef.current, rect)),
      dy: Math.round(toPageDelta(-event.deltaY, viewportRef.current, rect))
    });
  };
  const onKeyDown = (event) => {
    if (!acceptsInput) return;
    const printable = event.key.length === 1;
    send({
      t: "key",
      type: "down",
      key: event.key,
      code: event.code,
      vk: vkOf(event.nativeEvent),
      ...printable && !event.ctrlKey && !event.metaKey ? { text: event.key } : {},
      modifiers: modifiersOf(event)
    });
    if ([" ", "Tab", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace"].includes(event.key)) {
      event.preventDefault();
    }
  };
  const onKeyUp = (event) => {
    if (!acceptsInput) return;
    send({ t: "key", type: "up", key: event.key, code: event.code, vk: vkOf(event.nativeEvent), modifiers: modifiersOf(event) });
  };
  const onPaste = (event) => {
    if (!acceptsInput) return;
    const text = event.clipboardData.getData("text");
    if (text === "") return;
    event.preventDefault();
    send({ t: "text", text });
  };
  const submitAddress = () => {
    const url = normalizeAddress(address);
    if (url === void 0) {
      setFailure("only http and https addresses are supported");
      return;
    }
    send({ t: "navigate", url });
  };
  const controlLabel = (0, import_react2.useMemo)(() => {
    if (control === "human") return copy["control.human"];
    if (control === "agent") return copy["control.agent"];
    return copy["control.idle"];
  }, [control]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-browser-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-browser-bar", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", title: copy["toolbar.back"], onClick: () => send({ t: "back" }), children: "\u2190" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", title: copy["toolbar.forward"], onClick: () => send({ t: "forward" }), children: "\u2192" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", title: copy["toolbar.reload"], onClick: () => send({ t: "reload" }), children: loading ? "\xD7" : "\u27F3" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          className: "dsh-browser-address",
          value: address,
          spellCheck: false,
          "aria-label": copy["toolbar.address"],
          placeholder: "https://\u2026",
          onChange: (event) => setAddress(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") submitAddress();
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dsh-browser-badge dsh-browser-badge--${control}`, children: controlLabel }),
      control === "human" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-browser-action", onClick: () => {
        setRequest(void 0);
        send({ t: "human-done" });
      }, children: copy["control.done"] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-browser-action", onClick: () => send({ t: "control", action: "take" }), children: copy["control.take"] })
    ] }),
    request !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-browser-request", role: "status", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: copy["request.title"] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: request.reason })
    ] }),
    failure !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-browser-notice", role: "alert", children: failure }),
    connection !== "open" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-browser-notice", children: connection === "connecting" ? copy["state.connecting"] : copy["state.reconnecting"] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-browser-stage", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "canvas",
      {
        ref: canvasRef,
        className: "dsh-browser-canvas",
        tabIndex: 0,
        onPointerDown,
        onPointerUp,
        onPointerMove,
        onWheel,
        onKeyDown,
        onKeyUp,
        onPaste,
        onContextMenu: (event) => {
          event.preventDefault();
        }
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-browser-status", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-browser-status-title", children: title || address }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
        status.fps > 0 ? `${status.fps} fps \xB7 ` : "",
        status.width,
        "\xD7",
        status.height
      ] }),
      views.length > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
        views.length,
        " tabs",
        activeViewId === void 0 ? "" : ""
      ] })
    ] })
  ] });
}

// src/client/definition.ts
var TAB_KIND = "dshbrowser";
var TAB_ID = "@noext34/dsh-browser";
function tabDefinition() {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    multiple: true,
    priority: "extension",
    keepMounted: true,
    title: () => copy["tab.title"],
    guide: [{
      id: "new",
      order: 25,
      title: () => copy["guide.title"],
      description: () => copy["guide.description"]
    }]
  };
}

// src/client/settings.ts
var SETTINGS_NAMESPACE = "dsh-browser";
var ROWS = [
  { key: "headed", kind: "toggle", labelKey: "row.headed", helpKey: "row.headedHelp" },
  { key: "persistentProfile", kind: "toggle", labelKey: "row.profile", helpKey: "row.profileHelp" },
  { key: "quality", kind: "number", labelKey: "row.quality", helpKey: "row.qualityHelp", min: 20, max: 95 },
  { key: "humanIdleMs", kind: "number", labelKey: "row.humanIdle", helpKey: "row.humanIdleHelp", min: 0, unit: "ms" },
  { key: "idleTimeoutMs", kind: "number", labelKey: "row.idleTimeout", helpKey: "row.idleTimeoutHelp", min: 0, unit: "ms" }
];
var SettingsController = class {
  form;
  disposed;
  failure;
  listeners = /* @__PURE__ */ new Set();
  constructor(ctx) {
    this.form = ctx.configForms.get(SETTINGS_NAMESPACE);
    const unsubscribe = this.form.subscribe(() => {
      this.notify();
    });
    this.disposed = () => {
      unsubscribe();
    };
  }
  /** Current snapshot. */
  snapshot() {
    return this.form.getSnapshot();
  }
  /** Subscribe to snapshot replacements. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** The last write failure, or undefined. */
  get lastError() {
    return this.failure;
  }
  /**
   * Write one field.
   * @param key - the settings field.
   * @param value - new value.
   * @returns how the Host answered.
   */
  async set(key, value) {
    return await this.write(() => this.form.set(key, value));
  }
  /**
   * Clear one field, so it falls back to the composition default.
   * @param key - the settings field.
   * @returns how the Host answered.
   */
  async clear(key) {
    return await this.write(() => this.form.unset(key));
  }
  /** Release the subscription. */
  dispose() {
    this.disposed();
    this.listeners.clear();
  }
  async write(run) {
    try {
      const accepted = await run();
      this.failure = accepted ? void 0 : "the Host refused this change";
      this.notify();
      return accepted ? "accepted" : "refused";
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.notify();
      return "failed";
    }
  }
  notify() {
    for (const listener of this.listeners) listener();
  }
};

// src/client/SettingsPanel.tsx
var import_react3 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
function NumberRow(props) {
  const { controller, row, value, overridden } = props;
  const minutes = row.unit === "ms" && value !== void 0 ? value / 6e4 : void 0;
  const shown = minutes === void 0 ? value ?? "" : minutes;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-browser-setting", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { htmlFor: `dsh-browser-${row.key}`, children: [
      copy[row.labelKey],
      overridden && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dsh-browser-setting-changed", children: [
        " \xB7 ",
        copy["settings.overridden"]
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "input",
      {
        id: `dsh-browser-${row.key}`,
        type: "number",
        inputMode: "numeric",
        min: row.min,
        max: row.max,
        value: shown,
        onChange: (event) => {
          const raw = Number(event.target.value);
          if (!Number.isFinite(raw)) return;
          const stored = row.unit === "ms" ? Math.round(raw * 6e4) : raw;
          void controller.set(row.key, stored);
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-browser-setting-help", children: copy[row.helpKey] }),
    overridden && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsh-browser-setting-reset", onClick: () => {
      void controller.clear(row.key);
    }, children: copy["settings.reset"] })
  ] });
}
function SettingsPanel({ settings }) {
  usePluginStyle();
  const snapshot = (0, import_react3.useSyncExternalStore)(
    (listener) => settings.subscribe(listener),
    () => settings.snapshot()
  );
  const [failure] = (0, import_react3.useState)(() => settings.lastError);
  const value = snapshot.value ?? {};
  const user = snapshot.user ?? {};
  if (snapshot.status === "loading") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-browser-setting-help", children: "Loading\u2026" });
  if (snapshot.status === "unavailable") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-browser-setting-help", children: copy["settings.refused"] });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-browser-settings", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "dsh-browser-settings-title", children: copy["settings.title"] }),
    failure !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-browser-setting-help", role: "alert", children: failure }),
    ROWS.map((row) => {
      const current = value[row.key];
      const overridden = Object.hasOwn(user, row.key);
      if (row.kind === "toggle") {
        const on = current === true;
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dsh-browser-setting", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "dsh-browser-setting-toggle", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "input",
              {
                type: "checkbox",
                checked: on,
                disabled: !snapshot.writable,
                onChange: (event) => {
                  void settings.set(row.key, event.target.checked);
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { children: copy[row.labelKey] }),
            overridden && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "dsh-browser-setting-changed", children: [
              " \xB7 ",
              copy["settings.overridden"]
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "dsh-browser-setting-help", children: copy[row.helpKey] }),
          overridden && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "dsh-browser-setting-reset", onClick: () => {
            void settings.clear(row.key);
          }, children: copy["settings.reset"] })
        ] }, row.key);
      }
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(NumberRow, { controller: settings, row, value: typeof current === "number" ? current : void 0, overridden }, row.key);
    })
  ] });
}

// src/client/index.ts
var inject = ["slots", "sidebarRightTabs", "configForms"];
function apply(ctx) {
  ctx.effect(() => ctx.sidebarRightTabs.register(tabDefinition()), "dsh-browser: tab type");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TAB_ID
  }, BrowserBody)), "dsh-browser: tab body");
  const settings = new SettingsController(ctx);
  ctx.effect(() => () => {
    settings.dispose();
  }, "dsh-browser: settings form");
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject(
    "plugins.bundle.config",
    () => ctx.slots.register({
      name: "plugins.bundle.config",
      key: TAB_ID,
      inject: () => ({ settings })
    }, SettingsPanel)
  )), "dsh-browser: settings page");
}
return module.exports; } });
