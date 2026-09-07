import { clamp, fitBoundsToViewport, screenToWorld } from "./model.js";
import { createBoardSvg } from "./svg-export.js?v=75";
import { SHARE_ID, parseSharedBoard } from "./share-model.js";
import { SHARE_API } from "./share-config.js";
import { applyTranslations, t } from "./i18n.js?v=78";

// This entry point never loads the editor, workspace, Google credentials, or browser storage.
const canvas = document.querySelector("#presentation");
const title = document.querySelector("#presentation-title");
const status = document.querySelector("#presentation-status");
const fit = document.querySelector("#presentation-fit");
const theme = document.querySelector("#presentation-theme");
const fullscreen = document.querySelector("#presentation-fullscreen");
const id = location.hash.slice(1);
let view = { x: 0, y: 0, scale: 1 };
let bounds = null;
let svg = null;
let etag = "";
let updatedAt = 0;
let stopped = false;
let busy = false;
let timer;
let gesture = null;
const pointers = new Map();

applyTranslations();
for (const button of document.querySelectorAll("[data-view-label]")) {
  const key = button.dataset.viewLabel;
  button.setAttribute("aria-label", `${t(key, {}, "zh-Hans")} / ${t(key, {}, "en")}`);
}
document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
theme.setAttribute("aria-pressed", String(document.documentElement.dataset.theme === "dark"));
fullscreen.hidden = !document.documentElement.requestFullscreen;
fit.disabled = true;
theme.addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  theme.setAttribute("aria-pressed", String(dark));
});
fullscreen.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { setStatus("shareFullscreenFailed", true); }
});
document.addEventListener("fullscreenchange", () => fullscreen.setAttribute("aria-pressed", String(Boolean(document.fullscreenElement))));
fit.addEventListener("click", fitView);
window.addEventListener("resize", paintView);
window.addEventListener("online", poll);
document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (!document.hidden) void poll();
});

function fitView() {
  if (!bounds) return;
  view = fitBoundsToViewport(bounds, { width: canvas.clientWidth, height: canvas.clientHeight }, 80);
  paintView();
}

function setStatus(key, visible = false, values = {}) {
  const message = visible ? `${t(key, values, "zh-Hans")} / ${t(key, values, "en")}` : t(key, values);
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle("sr-only", !visible);
}

function paintView() {
  if (!svg) return;
  svg.setAttribute("viewBox", `${-view.x / view.scale} ${-view.y / view.scale} ${canvas.clientWidth / view.scale} ${canvas.clientHeight / view.scale}`);
  canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
  canvas.style.backgroundSize = `${Math.max(16, 28 * view.scale)}px ${Math.max(16, 28 * view.scale)}px`;
}

function render(payload) {
  const first = !svg;
  // Only locally generated, XML-escaped SVG enters the DOM; raw remote SVG/HTML is never accepted.
  const parsed = new DOMParser().parseFromString(createBoardSvg(payload.board, payload.connectionStyle), "image/svg+xml");
  const next = parsed.documentElement;
  if (next.localName !== "svg") throw new Error("shareInvalid");
  const box = next.getAttribute("viewBox").split(" ").map(Number);
  bounds = { left: box[0], top: box[1], right: box[0] + box[2], bottom: box[1] + box[3] };
  next.setAttribute("width", "100%");
  next.setAttribute("height", "100%");
  next.setAttribute("preserveAspectRatio", "none");
  svg = document.importNode(next, true);
  canvas.replaceChildren(svg);
  title.textContent = payload.board.title;
  document.title = `${payload.board.title} · Scattered`;
  fit.disabled = false;
  if (first) fitView();
  else paintView(); // Incoming edits do not interrupt the presenter's framing.
}

async function poll() {
  clearTimeout(timer);
  if (busy || stopped || document.hidden) return;
  if (!SHARE_API || !SHARE_ID.test(id)) {
    setStatus("shareMissing", true);
    stopped = true;
    return;
  }
  busy = true;
  try {
    const response = await fetch(`${SHARE_API}/shares/${id}`, {
      cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000),
      headers: etag ? { "If-None-Match": etag } : {},
    });
    if ([404, 410].includes(response.status)) {
      canvas.replaceChildren();
      svg = null;
      fit.disabled = true;
      title.textContent = "Scattered";
      document.title = "Scattered";
      setStatus("shareMissing", true);
      stopped = true;
      return;
    }
    if (response.status !== 304) {
      if (!response.ok) throw new Error("shareUnavailable");
      const value = await response.json();
      render(parseSharedBoard(JSON.stringify({ board: value.board, connectionStyle: value.connectionStyle })));
      updatedAt = Number(value.updatedAt) || Date.now();
      etag = response.headers.get("ETag") || "";
    }
    setStatus("shareViewerLive", false, { time: new Date(updatedAt).toLocaleString() });
  } catch {
    setStatus(svg ? "shareViewerOffline" : "shareViewerFailed", true);
  } finally {
    busy = false;
    // ponytail: 3-second conditional polling is enough for presentations; no socket infrastructure.
    if (!stopped && !document.hidden) timer = setTimeout(poll, 3_000);
  }
}

function resetGesture() {
  const points = [...pointers.values()];
  gesture = points.length === 2 ? {
    center: screenToWorld({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }, view),
    distance: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)),
    scale: view.scale,
  } : points.length === 1 ? { point: points[0], view: { ...view } } : null;
}
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || pointers.size >= 2) return;
  canvas.focus({ preventScroll: true });
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvas.setPointerCapture(event.pointerId);
  resetGesture();
});
canvas.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId) || !gesture) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const points = [...pointers.values()];
  if (points.length === 2 && gesture.center) {
    view.scale = clamp(gesture.scale * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / gesture.distance, 0.1, 2);
    view.x = (points[0].x + points[1].x) / 2 - gesture.center.x * view.scale;
    view.y = (points[0].y + points[1].y) / 2 - gesture.center.y * view.scale;
  } else if (gesture.point) {
    view.x = gesture.view.x + event.clientX - gesture.point.x;
    view.y = gesture.view.y + event.clientY - gesture.point.y;
  }
  paintView();
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(type, (event) => {
  pointers.delete(event.pointerId);
  resetGesture();
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const anchor = screenToWorld({ x: event.clientX, y: event.clientY }, view);
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
  view.scale = clamp(view.scale * Math.exp(-delta * 0.002), 0.1, 2);
  view.x = event.clientX - anchor.x * view.scale;
  view.y = event.clientY - anchor.y * view.scale;
  paintView();
}, { passive: false });
canvas.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "f" || event.key === "0") { event.preventDefault(); fitView(); }
  const movement = { ArrowLeft: [50, 0], ArrowRight: [-50, 0], ArrowUp: [0, 50], ArrowDown: [0, -50] }[event.key];
  if (movement) { event.preventDefault(); view.x += movement[0]; view.y += movement[1]; paintView(); }
  if (["+", "=", "-"].includes(event.key)) {
    event.preventDefault();
    const center = screenToWorld({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, view);
    view.scale = clamp(view.scale * (event.key === "-" ? 0.8 : 1.25), 0.1, 2);
    view.x = canvas.clientWidth / 2 - center.x * view.scale;
    view.y = canvas.clientHeight / 2 - center.y * view.scale;
    paintView();
  }
});
void poll();
