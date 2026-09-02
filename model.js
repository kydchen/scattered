export const BOARD_VERSION = 4;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_NODES = 500;
export const MAX_IMPORT_EDGES = 1_000;
export const MIN_VIEW_SCALE = 0.02;
const OVERVIEW_START_SCALE = 9 / 17;
const OVERVIEW_COMPACT_SCALE = 0.3;
export const EMPTY_NOTE_PROMPTS = [
  "遇有所得，即书投囊中",
  "Catch the thought.",
  "Anota lo que aparece.",
  "Notez ce qui vient.",
  "ひらめきを、ここに。",
];
export const EMPTY_NOTE_PROMPT_LANGS = ["zh-Hans", "en", "es", "fr", "ja"];
const NOTE_COLORS = new Set(["plain", "yellow", "mint", "blue", "rose"]);
const IMPORT_VERSIONS = new Set([3, 4]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_IMPORT_COORDINATE = 1_000_000;

export function overviewLevel(scale) {
  const renderScale = Math.max(scale, OVERVIEW_COMPACT_SCALE);
  const progress = clamp(
    (OVERVIEW_START_SCALE - scale) / (OVERVIEW_START_SCALE - OVERVIEW_COMPACT_SCALE),
    0,
    1,
  );
  return {
    active: scale < OVERVIEW_START_SCALE,
    compact: scale < OVERVIEW_COMPACT_SCALE,
    progress,
    renderScale,
    markerScale: renderScale / scale,
  };
}

export function blankBoard() {
  return {
    version: BOARD_VERSION,
    title: "Untitled",
    nodes: [],
    edges: [],
    view: { x: 0, y: 0, scale: 1 },
  };
}

export function parseImportedBoard(encoded, limits = {}) {
  const maxBytes = limits.maxBytes ?? MAX_IMPORT_BYTES;
  const maxNodes = limits.maxNodes ?? MAX_IMPORT_NODES;
  const maxEdges = limits.maxEdges ?? MAX_IMPORT_EDGES;
  if (typeof encoded !== "string") throw new Error("import.invalid");
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new Error("import.tooLarge");
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("import.invalid");
  }
  validateImportedBoard(value, maxNodes, maxEdges);
  return normalizeBoard(value);
}

function validateImportedBoard(value, maxNodes, maxEdges) {
  if (!isPlainObject(value) || !IMPORT_VERSIONS.has(value.version)) throw new Error("import.unsupportedVersion");
  if (
    typeof value.title !== "string"
    || !value.title.trim()
    || value.title !== value.title.trim()
    || value.title.length > 120
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !isPlainObject(value.view)
  ) throw new Error("import.invalid");
  if (value.nodes.length > maxNodes || value.edges.length > maxEdges) throw new Error("import.tooMuchContent");

  const nodeIds = new Set();
  value.nodes.forEach((node) => {
    if (
      !isPlainObject(node)
      || !validImportId(node.id)
      || nodeIds.has(node.id)
      || typeof node.text !== "string"
      || node.text.length > 20_000
      || !validImportCoordinate(node.x)
      || !validImportCoordinate(node.y)
      || !NOTE_COLORS.has(node.color)
      || !Number.isFinite(node.width)
      || node.width < 160
      || node.width > 520
    ) throw new Error("import.invalid");
    nodeIds.add(node.id);
  });

  const edgeIds = new Set();
  const pairs = new Set();
  value.edges.forEach((edge) => {
    const pair = edgeKey(edge?.from, edge?.to);
    const validArrow = value.version === 3
      ? typeof edge?.arrow === "boolean"
      : edge?.arrow === false || edge?.arrow === "forward" || edge?.arrow === "reverse";
    if (
      !isPlainObject(edge)
      || !validImportEdgeId(edge.id, edge.from, edge.to)
      || edgeIds.has(edge.id)
      || !nodeIds.has(edge.from)
      || !nodeIds.has(edge.to)
      || edge.from === edge.to
      || pairs.has(pair)
      || !validArrow
      || typeof edge.label !== "string"
      || edge.label.length > 120
    ) throw new Error("import.invalid");
    edgeIds.add(edge.id);
    pairs.add(pair);
  });

  if (
    !validImportCoordinate(value.view.x)
    || !validImportCoordinate(value.view.y)
    || !Number.isFinite(value.view.scale)
    || value.view.scale < MIN_VIEW_SCALE
    || value.view.scale > 2
  ) throw new Error("import.invalid");
}

export function normalizeBoard(value) {
  if (!value || typeof value !== "object") throw new Error("import.invalid");

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
          arrow: normalizeArrow(edge.arrow),
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
      scale: clamp(finiteNumber(sourceView.scale, 1), MIN_VIEW_SCALE, 2),
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
  if (sources.length === 1) {
    return [...edges, { id: idFactory(), from: sources[0], to: target, arrow: false, label: "" }];
  }

  const anchored = edges.map((edge) => {
    if (!sourceKeys.has(edgeKey(edge.from, edge.to)) || edge.from === target) return edge;
    return {
      ...edge,
      from: target,
      to: edge.from,
      arrow: edge.arrow === "forward" ? "reverse" : edge.arrow === "reverse" ? "forward" : false,
    };
  });
  const existing = new Set(anchored.map((edge) => edgeKey(edge.from, edge.to)));
  return sources.reduce((next, source) => {
    const key = edgeKey(source, target);
    return existing.has(key) ? next : [...next, { id: idFactory(), from: target, to: source, arrow: false, label: "" }];
  }, anchored);
}

export function removeConnectionsForNodes(edges, nodeIds) {
  const ids = new Set(nodeIds);
  return edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
}

export function toggleArrowsForNodes(edges, nodeIds) {
  const ids = new Set(nodeIds);
  const targets = edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to));
  if (targets.length === 0) return edges;
  const states = new Set(targets.map((edge) => edge.arrow));
  const arrow = states.size === 1 ? nextArrowState(targets[0].arrow) : "forward";
  return edges.map((edge) => ids.has(edge.from) || ids.has(edge.to) ? { ...edge, arrow } : edge);
}

export function copySelectedGraph(value, nodeIds) {
  const board = normalizeBoard(value);
  const ids = new Set(nodeIds);
  const nodes = board.nodes.filter((node) => ids.has(node.id));
  if (nodes.length === 0) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  return {
    type: "scattered-selection",
    version: 1,
    nodes: nodes.map((node) => ({ ...node, x: node.x - left, y: node.y - top })),
    edges: board.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  };
}

export function pasteSelectedGraph(value, origin, idFactory = createId) {
  if (!value || value.type !== "scattered-selection" || value.version !== 1) return null;
  let selection;
  try {
    selection = normalizeBoard({ nodes: value.nodes, edges: value.edges });
  } catch {
    return null;
  }
  if (selection.nodes.length === 0) return null;
  const ids = new Map(selection.nodes.map((node) => [node.id, idFactory()]));
  const x = finiteNumber(origin?.x, 0);
  const y = finiteNumber(origin?.y, 0);
  return {
    nodes: selection.nodes.map((node) => ({ ...node, id: ids.get(node.id), x: x + node.x, y: y + node.y })),
    edges: selection.edges.map((edge) => ({
      ...edge,
      id: idFactory(),
      from: ids.get(edge.from),
      to: ids.get(edge.to),
    })),
  };
}

export function nextArrowState(state) {
  if (state === "forward") return "reverse";
  if (state === "reverse") return false;
  return "forward";
}

export function boardToMermaidMarkdown(value) {
  const board = normalizeBoard(value);
  const nodeIds = new Map(board.nodes.map((node, index) => [node.id, `note_${index + 1}`]));
  const lines = [
    `# ${markdownText(board.title)}`,
    "",
    "_Exported from Scattered_",
    "",
    "---",
    "",
    "```mermaid",
    "flowchart TB",
    "    accTitle: Scattered Note Relationships",
    "    accDescr: Notes and connections exported from Scattered.",
    "",
    ...board.nodes.map((node, index) => `    note_${index + 1}[\"${mermaidText(node.text || "Untitled note", true)}\"]`),
  ];
  if (board.nodes.length > 0 && board.edges.length > 0) lines.push("");
  board.edges.forEach((edge) => {
    const reverse = edge.arrow === "reverse";
    const from = nodeIds.get(reverse ? edge.to : edge.from);
    const to = nodeIds.get(reverse ? edge.from : edge.to);
    const connector = edge.arrow ? "-->" : "---";
    const label = edge.label ? `|${mermaidText(edge.label, false)}|` : "";
    lines.push(`    ${from} ${connector}${label} ${to}`);
  });
  lines.push("```", "");
  return lines.join("\n");
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function emptyNotePrompt(id) {
  return EMPTY_NOTE_PROMPTS[emptyNotePromptIndex(id)];
}

export function emptyNotePromptLanguage(id) {
  return EMPTY_NOTE_PROMPT_LANGS[emptyNotePromptIndex(id)];
}

function emptyNotePromptIndex(id) {
  const hash = [...id].reduce((value, character) => Math.imul(value, 31) + character.charCodeAt(0) | 0, 0);
  return (hash >>> 0) % EMPTY_NOTE_PROMPTS.length;
}

export function screenToWorld(point, view) {
  return {
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale,
  };
}

export function rectIntersectsViewport(bounds, viewport) {
  return bounds.right > viewport.left
    && bounds.bottom > viewport.top
    && bounds.left < viewport.left + viewport.width
    && bounds.top < viewport.top + viewport.height;
}

export function minimumRevealDelta(bounds, viewport, insets) {
  const safe = {
    left: viewport.left + insets.left,
    right: viewport.left + viewport.width - insets.right,
    top: viewport.top + insets.top,
    bottom: viewport.top + viewport.height - insets.bottom,
  };
  const axisDelta = (start, end, safeStart, safeEnd) => {
    if (safeEnd < safeStart || end - start > safeEnd - safeStart) {
      return (safeStart + safeEnd - start - end) / 2;
    }
    if (start < safeStart) return safeStart - start;
    if (end > safeEnd) return safeEnd - end;
    return 0;
  };
  return {
    x: axisDelta(bounds.left, bounds.right, safe.left, safe.right),
    y: axisDelta(bounds.top, bounds.bottom, safe.top, safe.bottom),
  };
}

export function fitBoundsToViewport(bounds, viewport, padding = 64) {
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const scale = clamp(Math.min(availableWidth / width, availableHeight / height), MIN_VIEW_SCALE, 1);
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

export function connectionCurve(from, to, style = "curved") {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.001 || style === "straight") {
    return {
      path: `M ${from.x} ${from.y} L ${to.x} ${to.y}`,
      midpoint: distance < 0.001 ? { ...from } : { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      control1: { ...from },
      control2: { ...to },
    };
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
    control1,
    control2,
  };
}

function validImportId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !CONTROL_CHARACTERS.test(value);
}

function validImportEdgeId(value, from, to) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 257
    && (!CONTROL_CHARACTERS.test(value) || value === edgeKey(from, to));
}

function validImportCoordinate(value) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_IMPORT_COORDINATE;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeArrow(value) {
  if (value === "reverse") return "reverse";
  return value === true || value === "forward" ? "forward" : false;
}

function markdownText(value) {
  return String(value || "Untitled").replace(/[\r\n]+/g, " ").trim() || "Untitled";
}

function mermaidText(value, multiline) {
  const escaped = String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/`/g, "&#96;")
    .replace(/\|/g, "&#124;");
  return multiline ? escaped.replace(/\r?\n/g, "<br/>") : escaped.replace(/[\r\n]+/g, " ");
}

function edgeKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}
