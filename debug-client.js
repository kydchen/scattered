const FLUSH_DELAY = 100;
const MAX_BATCH = 24;

export function startPointerDebug(surface, getState) {
  const session = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const buffer = [];
  let flushTimer = 0;

  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, MAX_BATCH);
    fetch("/__debug", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: true,
    }).catch(() => buffer.unshift(...batch));
    if (buffer.length > 0) flushTimer = setTimeout(flush, FLUSH_DELAY);
  };

  const enqueue = (entry) => {
    buffer.push({ session, ...entry });
    if (buffer.length >= MAX_BATCH) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY);
  };

  enqueue({
    kind: "session",
    wallTime: Date.now(),
    userAgent: navigator.userAgent,
    viewport: [innerWidth, innerHeight],
    devicePixelRatio,
  });

  const record = (event) => enqueue({
    kind: "pointer",
    wallTime: Date.now(),
    time: Math.round(performance.now() * 10) / 10,
    event: event.type,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    buttons: event.buttons,
    pressure: event.pressure,
    width: Math.round(event.width * 10) / 10,
    height: Math.round(event.height * 10) / 10,
    x: Math.round(event.clientX * 10) / 10,
    y: Math.round(event.clientY * 10) / 10,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    coalesced: event.getCoalescedEvents?.().length || 0,
    detail: event.detail || 0,
    target: targetRole(event.target),
    state: getState(),
  });

  ["pointerdown", "pointermove", "pointerup", "pointercancel", "click", "dblclick"].forEach((type) => {
    surface.addEventListener(type, record, { passive: true });
  });
  addEventListener("pagehide", flush);
  enqueue({ kind: "ready", wallTime: Date.now(), state: getState() });
  return session;
}

function targetRole(target) {
  if (!(target instanceof Element)) return "unknown";
  if (target.closest(".resize-handle")) return "resize";
  if (target.closest(".link-handle")) return "link";
  if (target.closest(".node-editor")) return "editor";
  if (target.closest(".node")) return "node";
  return "canvas";
}
