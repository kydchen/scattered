export const BOARD_VERSION = 3;
const NOTE_COLORS = new Set(["plain", "yellow", "mint", "blue", "rose"]);

export function blankBoard() {
  return {
    version: BOARD_VERSION,
    title: "Untitled",
    nodes: [],
    edges: [],
    view: { x: 0, y: 0, scale: 1 },
  };
}

export function normalizeBoard(value) {
  if (!value || typeof value !== "object") throw new Error("备份格式不正确");

  const ids = new Set();
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.flatMap((node) => {
        if (!node || typeof node.id !== "string" || ids.has(node.id)) return [];
        ids.add(node.id);
        return [{
          id: node.id,
          text: typeof node.text === "string" ? node.text.slice(0, 20_000) : "",
          x: finiteNumber(node.x, 0),
          y: finiteNumber(node.y, 0),
          color: NOTE_COLORS.has(node.color) ? node.color : "plain",
          width: clamp(finiteNumber(node.width, 218), 160, 520),
        }];
      })
    : [];

  const seenEdges = new Set();
  const edgeIds = new Set();
  const edges = Array.isArray(value.edges)
    ? value.edges.flatMap((edge) => {
        if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) return [];
        const key = edgeKey(edge.from, edge.to);
        if (seenEdges.has(key)) return [];
        seenEdges.add(key);
        const id = typeof edge.id === "string" && edge.id && !edgeIds.has(edge.id) ? edge.id : key;
        edgeIds.add(id);
        return [{
          id,
          from: edge.from,
          to: edge.to,
          arrow: edge.arrow === true,
          label: typeof edge.label === "string" ? edge.label.slice(0, 120) : "",
        }];
      })
    : [];

  const sourceView = value.view && typeof value.view === "object" ? value.view : {};
  return {
    version: BOARD_VERSION,
    title: typeof value.title === "string" && value.title.trim()
      ? value.title.trim().slice(0, 120)
      : "Untitled",
    nodes,
    edges,
    view: {
      x: finiteNumber(sourceView.x, 0),
      y: finiteNumber(sourceView.y, 0),
      scale: clamp(finiteNumber(sourceView.scale, 1), 0.35, 2),
    },
  };
}

export function toggleConnection(edges, from, to, idFactory = createId) {
  if (!from || !to || from === to) return edges;
  const key = edgeKey(from, to);
  const existing = edges.findIndex((edge) => edgeKey(edge.from, edge.to) === key);
  if (existing >= 0) return edges.filter((_, index) => index !== existing);
  return [...edges, { id: idFactory(), from, to, arrow: false, label: "" }];
}

export function toggleConnectionsToTarget(edges, sourceIds, target, idFactory = createId) {
  const sources = [...new Set(sourceIds)].filter((id) => id && id !== target);
  if (!target || sources.length === 0) return edges;
  const sourceKeys = new Set(sources.map((source) => edgeKey(source, target)));
  const allConnected = sources.every((source) => edges.some((edge) => edgeKey(edge.from, edge.to) === edgeKey(source, target)));
  if (allConnected) return edges.filter((edge) => !sourceKeys.has(edgeKey(edge.from, edge.to)));

  const existing = new Set(edges.map((edge) => edgeKey(edge.from, edge.to)));
  return sources.reduce((next, source) => {
    const key = edgeKey(source, target);
    return existing.has(key) ? next : [...next, { id: idFactory(), from: source, to: target, arrow: false, label: "" }];
  }, edges);
}

export function removeConnectionsForNodes(edges, nodeIds) {
  const ids = new Set(nodeIds);
  return edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function screenToWorld(point, view) {
  return {
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale,
  };
}

export function fitBoundsToViewport(bounds, viewport, padding = 64) {
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clamp(Math.min(availableWidth / width, availableHeight / height), 0.35, 1);
  return {
    x: (viewport.width - width * scale) / 2 - bounds.left * scale,
    y: (viewport.height - height * scale) / 2 - bounds.top * scale,
    scale,
  };
}

export function shouldPinch(pointerTypes) {
  return pointerTypes.filter((type) => type === "touch").length === 2;
}

export function shouldResetPointers(pointerTypes, pointerType, isPrimary) {
  return isPrimary && (
    pointerTypes.includes(pointerType)
    || (pointerType === "pen" && pointerTypes.includes("touch"))
  );
}

export function hasDragIntent(pointerType, dx, dy) {
  const threshold = pointerType === "pen" ? 16 : pointerType === "touch" ? 8 : 4;
  return Math.hypot(dx, dy) > threshold;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function shouldDiscardDraft(text, isNew, explicitCancel) {
  return explicitCancel && isNew && !text.trim();
}

export function applyLassoSelection(currentIds, enclosedIds, toggle) {
  const next = new Set(toggle ? currentIds : []);
  enclosedIds.forEach((id) => {
    if (toggle && next.has(id)) next.delete(id);
    else next.add(id);
  });
  return next;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function connectionCurve(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001) {
    return { path: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, midpoint: { ...from } };
  }
  const canonicalDirection = dx > 0 || (dx === 0 && dy >= 0) ? 1 : -1;
  const curve = clamp(distance * 0.08, 10, 36);
  const offsetX = -dy / distance * curve * canonicalDirection;
  const offsetY = dx / distance * curve * canonicalDirection;
  const control1 = { x: from.x + dx / 3 + offsetX, y: from.y + dy / 3 + offsetY };
  const control2 = { x: from.x + dx * 2 / 3 + offsetX, y: from.y + dy * 2 / 3 + offsetY };
  return {
    path: `M ${from.x} ${from.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${to.x} ${to.y}`,
    midpoint: {
      x: (from.x + 3 * control1.x + 3 * control2.x + to.x) / 8,
      y: (from.y + 3 * control1.y + 3 * control2.y + to.y) / 8,
    },
  };
}

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function edgeKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
