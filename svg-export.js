import { clamp, connectionCurve } from "./model.js";

const PADDING = 48;
const PREVIEW_MAX = { width: 1600, height: 1200 };
const NODE_FONT_SIZE = 17;
const NODE_LINE_HEIGHT = NODE_FONT_SIZE * 1.42;
const NODE_PADDING_X = 15;
const NODE_PADDING_Y = 13;
const EDGE_LABEL_SIZE = 13;
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Noto Sans CJK SC', 'Segoe UI', sans-serif";
const COLORS = {
  canvas: "#ffffff",
  ink: "#202735",
  thread: "#4e74b8",
  plain: ["#ffffff", "#dfe4ec"],
  yellow: ["#fff4c7", "#e9dca5"],
  mint: ["#e2f3e9", "#c5dfd0"],
  blue: ["#e5effc", "#c8d9ef"],
  rose: ["#f8e7ed", "#e6ccd5"],
};

let canvasContext;

export function wrapSvgText(text, maxWidth, widthOf) {
  const lines = [];
  String(text).replace(/\r/g, "").split("\n").forEach((paragraph) => {
    if (!paragraph) {
      lines.push("");
      return;
    }
    const tokens = paragraph.match(/\s+|[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*|./gu) || [];
    let line = "";
    tokens.forEach((token) => {
      const candidate = line + token;
      if (line && widthOf(candidate) > maxWidth) {
        lines.push(line.trimEnd());
        line = token.trimStart();
      } else {
        line = candidate;
      }
      if (widthOf(line) <= maxWidth) return;
      const characters = [...line];
      line = "";
      characters.forEach((character) => {
        if (line && widthOf(line + character) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += character;
      });
    });
    lines.push(line.trimEnd());
  });
  return lines;
}

export function createBoardSvg(board, measure = measureText) {
  const layout = buildLayout(board, measure);
  const width = layout.bounds.right - layout.bounds.left;
  const height = layout.bounds.bottom - layout.bounds.top;
  const previewScale = Math.min(1, PREVIEW_MAX.width / width, PREVIEW_MAX.height / height);
  const edges = layout.edges.map((edge) => {
    const marker = edge.arrow === "forward"
      ? ' marker-end="url(#arrowhead)"'
      : edge.arrow === "reverse" ? ' marker-start="url(#arrowhead)"' : "";
    const label = edge.label ? `\n    <text class="edge-label" x="${number(edge.midpoint.x)}" y="${number(edge.midpoint.y)}">${xml(edge.label)}</text>` : "";
    return `  <g><path class="edge" d="${xml(edge.path)}"${marker}/>${label}\n  </g>`;
  }).join("\n");
  const nodes = layout.nodes.map((node) => {
    const [fill, stroke] = COLORS[node.color] || COLORS.plain;
    const lines = node.lines.map((line, index) => (
      `      <tspan x="${number(node.x + NODE_PADDING_X)}" y="${number(node.y + NODE_PADDING_Y + NODE_FONT_SIZE + index * NODE_LINE_HEIGHT)}">${xml(line)}</tspan>`
    )).join("\n");
    const text = lines ? `\n    <text class="note-text">\n${lines}\n    </text>` : "";
    return `  <g><rect x="${number(node.x)}" y="${number(node.y)}" width="${number(node.width)}" height="${number(node.height)}" rx="9" fill="${fill}" stroke="${stroke}"/>${text}\n  </g>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${number(width * previewScale)}" height="${number(height * previewScale)}" viewBox="${number(layout.bounds.left)} ${number(layout.bounds.top)} ${number(width)} ${number(height)}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="title">
  <title id="title">${xml(board.title || "Untitled")}</title>
  <defs>
    <marker id="arrowhead" markerWidth="12" markerHeight="12" refX="10.4" refY="6" orient="auto-start-reverse" markerUnits="userSpaceOnUse" viewBox="0 0 12 12" overflow="visible">
      <path d="M1.4 1.5 10.4 6 1.4 10.5 4.2 6Z" fill="${COLORS.thread}"/>
    </marker>
    <style>
      .edge { fill: none; stroke: ${COLORS.thread}; stroke-width: 1.85; stroke-linecap: round; stroke-linejoin: round; }
      .edge-label { fill: ${COLORS.ink}; stroke: ${COLORS.canvas}; stroke-width: 7; stroke-linejoin: round; paint-order: stroke fill; font: 560 ${EDGE_LABEL_SIZE}px ${FONT_FAMILY}; text-anchor: middle; dominant-baseline: central; }
      .note-text { fill: ${COLORS.ink}; font: 430 ${NODE_FONT_SIZE}px ${FONT_FAMILY}; letter-spacing: -0.01em; }
    </style>
  </defs>
  <rect x="${number(layout.bounds.left)}" y="${number(layout.bounds.top)}" width="${number(width)}" height="${number(height)}" fill="${COLORS.canvas}"/>
${edges}
${nodes}
</svg>`;
}

function buildLayout(board, measure) {
  const nodes = (board.nodes || []).map((node) => {
    const width = clamp(Number(node.width) || 218, 160, 520);
    const text = String(node.text || "");
    const lines = text ? wrapSvgText(text, width - NODE_PADDING_X * 2, (value) => measure(value, NODE_FONT_SIZE, 430)) : [];
    const height = Math.max(48, lines.length * NODE_LINE_HEIGHT + NODE_PADDING_Y * 2 + 2);
    return { ...node, width, height, lines };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = (board.edges || []).flatMap((edge) => {
    const fromNode = byId.get(edge.from);
    const toNode = byId.get(edge.to);
    if (!fromNode || !toNode) return [];
    let from = nodeAnchor(fromNode, nodeCenter(toNode));
    let to = nodeAnchor(toNode, nodeCenter(fromNode));
    if (edge.arrow) {
      const distance = Math.hypot(from.x - to.x, from.y - to.y);
      if (distance > 5) {
        if (edge.arrow === "reverse") from = insetPoint(from, to, 5 / distance);
        else to = insetPoint(to, from, 5 / distance);
      }
    }
    const curve = connectionCurve(from, to);
    const label = String(edge.label || "");
    return [{ ...edge, ...curve, from, to, label, labelWidth: label ? measure(label, EDGE_LABEL_SIZE, 560) + 12 : 0 }];
  });

  if (!nodes.length) return { nodes, edges, bounds: { left: 0, top: 0, right: 384, bottom: 224 } };
  const bounds = nodes.reduce((result, node) => ({
    left: Math.min(result.left, node.x),
    top: Math.min(result.top, node.y),
    right: Math.max(result.right, node.x + node.width),
    bottom: Math.max(result.bottom, node.y + node.height),
  }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  edges.forEach((edge) => {
    if (!edge.label) return;
    bounds.left = Math.min(bounds.left, edge.midpoint.x - edge.labelWidth / 2);
    bounds.right = Math.max(bounds.right, edge.midpoint.x + edge.labelWidth / 2);
    bounds.top = Math.min(bounds.top, edge.midpoint.y - 12);
    bounds.bottom = Math.max(bounds.bottom, edge.midpoint.y + 12);
  });
  bounds.left -= PADDING;
  bounds.top -= PADDING;
  bounds.right += PADDING;
  bounds.bottom += PADDING;
  return { nodes, edges, bounds };
}

function nodeCenter(node) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function nodeAnchor(node, toward) {
  const center = nodeCenter(node);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) return center;
  const xScale = dx ? node.width / 2 / Math.abs(dx) : Infinity;
  const yScale = dy ? node.height / 2 / Math.abs(dy) : Infinity;
  const scale = Math.min(xScale, yScale);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function insetPoint(from, toward, ratio) {
  return { x: from.x + (toward.x - from.x) * ratio, y: from.y + (toward.y - from.y) * ratio };
}

function measureText(value, size, weight) {
  canvasContext ||= document.createElement("canvas").getContext("2d");
  canvasContext.font = `${weight} ${size}px ${FONT_FAMILY}`;
  return canvasContext.measureText(value).width;
}

function number(value) {
  return String(Math.round(Number(value) * 1000) / 1000);
}

function xml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
