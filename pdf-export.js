import { clamp, connectionCurve } from "./model.js";

const PDF_POINT_SCALE = 0.75;
const PAGE_MARGIN = 36;
const PAGE_MIN = { width: 360, height: 240 };
const PAGE_MAX = { width: 1440, height: 1080 };
const BOARD_PADDING = 48;
const NODE_FONT_SIZE = 17;
const NODE_LINE_HEIGHT = NODE_FONT_SIZE * 1.42;
const NODE_PADDING_X = 15;
const NODE_PADDING_Y = 13;
const EDGE_LABEL_SIZE = 13;

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

let runtimePromise;

export function fitPdfPage(bounds) {
  const contentWidth = Math.max(1, bounds.right - bounds.left);
  const contentHeight = Math.max(1, bounds.bottom - bounds.top);
  const scale = Math.min(
    PDF_POINT_SCALE,
    (PAGE_MAX.width - PAGE_MARGIN * 2) / contentWidth,
    (PAGE_MAX.height - PAGE_MARGIN * 2) / contentHeight,
  );
  const drawnWidth = contentWidth * scale;
  const drawnHeight = contentHeight * scale;
  const width = clamp(drawnWidth + PAGE_MARGIN * 2, PAGE_MIN.width, PAGE_MAX.width);
  const height = clamp(drawnHeight + PAGE_MARGIN * 2, PAGE_MIN.height, PAGE_MAX.height);
  return {
    width,
    height,
    scale,
    offsetX: (width - drawnWidth) / 2,
    offsetY: (height - drawnHeight) / 2,
  };
}

export function wrapPdfText(text, maxWidth, widthOf) {
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

export async function createBoardPdf(board, suppliedRuntime) {
  const { PDFLib, fontkit, fontBytes } = suppliedRuntime || await loadPdfRuntime();
  const pdfDocument = await PDFLib.PDFDocument.create();
  pdfDocument.registerFontkit(fontkit.default || fontkit);
  const font = await pdfDocument.embedFont(fontBytes);
  const supported = new Set(font.getCharacterSet());
  const sanitize = (value) => [...String(value)].map((character) => (
    character === "\n" || character === "\r" || supported.has(character.codePointAt(0)) ? character : "□"
  )).join("");
  const layout = buildLayout(board, font, sanitize);
  const fitted = fitPdfPage(layout.bounds);
  const page = pdfDocument.addPage([fitted.width, fitted.height]);
  const color = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return PDFLib.rgb((value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
  };
  const point = (value) => ({
    x: fitted.offsetX + (value.x - layout.bounds.left) * fitted.scale,
    y: fitted.height - fitted.offsetY - (value.y - layout.bounds.top) * fitted.scale,
  });

  pdfDocument.setTitle(String(board.title || "Untitled"));
  pdfDocument.setCreator("Scattered");
  pdfDocument.setProducer("Scattered");
  page.drawRectangle({ x: 0, y: 0, width: fitted.width, height: fitted.height, color: color(COLORS.canvas) });

  layout.edges.forEach((edge) => drawEdge(page, edge, fitted.scale, point, PDFLib, color, font));
  layout.nodes.forEach((node) => drawNode(page, node, fitted.scale, point, PDFLib, color, font));

  return pdfDocument.save();
}

function buildLayout(board, font, sanitize) {
  const nodes = (board.nodes || []).map((node) => {
    const width = clamp(Number(node.width) || 218, 160, 520);
    const text = sanitize(node.text || "");
    const lines = text ? wrapPdfText(text, width - NODE_PADDING_X * 2, (value) => font.widthOfTextAtSize(value, NODE_FONT_SIZE)) : [];
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
    const label = sanitize(edge.label || "");
    return [{ ...edge, ...curve, from, to, label, labelWidth: label ? font.widthOfTextAtSize(label, EDGE_LABEL_SIZE) + 12 : 0 }];
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
  bounds.left -= BOARD_PADDING;
  bounds.top -= BOARD_PADDING;
  bounds.right += BOARD_PADDING;
  bounds.bottom += BOARD_PADDING;
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

function drawEdge(page, edge, scale, point, PDFLib, color, font) {
  const from = point(edge.from);
  const to = point(edge.to);
  const control1 = point(edge.control1);
  const control2 = point(edge.control2);
  page.pushOperators(
    PDFLib.pushGraphicsState(),
    PDFLib.setStrokingColor(color(COLORS.thread)),
    PDFLib.setLineWidth(Math.max(0.65, 1.85 * scale)),
    PDFLib.setLineCap(PDFLib.LineCapStyle.Round),
    PDFLib.moveTo(from.x, from.y),
    PDFLib.appendBezierCurve(control1.x, control1.y, control2.x, control2.y, to.x, to.y),
    PDFLib.stroke(),
    PDFLib.popGraphicsState(),
  );
  if (edge.arrow === "forward") drawArrow(page, to, control2, scale, PDFLib, color(COLORS.thread));
  if (edge.arrow === "reverse") drawArrow(page, from, control1, scale, PDFLib, color(COLORS.thread));
  if (!edge.label) return;
  const midpoint = point(edge.midpoint);
  const width = edge.labelWidth * scale;
  const height = 20 * scale;
  drawRoundedRect(page, midpoint.x - width / 2, midpoint.y - height / 2, width, height, 5 * scale, color(COLORS.canvas), color(COLORS.canvas), 0, PDFLib);
  page.drawText(edge.label, {
    x: midpoint.x - font.widthOfTextAtSize(edge.label, EDGE_LABEL_SIZE) * scale / 2,
    y: midpoint.y - EDGE_LABEL_SIZE * scale * 0.38,
    size: EDGE_LABEL_SIZE * scale,
    font,
    color: color(COLORS.ink),
  });
}

function drawNode(page, node, scale, point, PDFLib, color, font) {
  const topLeft = point({ x: node.x, y: node.y });
  const width = node.width * scale;
  const height = node.height * scale;
  const [fill, border] = COLORS[node.color] || COLORS.plain;
  drawRoundedRect(page, topLeft.x, topLeft.y - height, width, height, 9 * scale, color(fill), color(border), Math.max(0.55, scale), PDFLib);
  node.lines.forEach((line, index) => {
    if (!line) return;
    const baseline = point({
      x: node.x + NODE_PADDING_X,
      y: node.y + NODE_PADDING_Y + NODE_FONT_SIZE + index * NODE_LINE_HEIGHT,
    });
    page.drawText(line, { x: baseline.x, y: baseline.y, size: NODE_FONT_SIZE * scale, font, color: color(COLORS.ink) });
  });
}

function drawArrow(page, tip, previous, scale, PDFLib, fillColor) {
  const dx = tip.x - previous.x;
  const dy = tip.y - previous.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return;
  const length = Math.max(4, 9 * scale);
  const halfWidth = length * 0.46;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const baseX = tip.x - unitX * length;
  const baseY = tip.y - unitY * length;
  page.pushOperators(
    PDFLib.pushGraphicsState(),
    PDFLib.setFillingColor(fillColor),
    PDFLib.moveTo(tip.x, tip.y),
    PDFLib.lineTo(baseX - unitY * halfWidth, baseY + unitX * halfWidth),
    PDFLib.lineTo(baseX + unitY * halfWidth, baseY - unitX * halfWidth),
    PDFLib.closePath(),
    PDFLib.fill(),
    PDFLib.popGraphicsState(),
  );
}

function drawRoundedRect(page, x, y, width, height, radius, fillColor, borderColor, borderWidth, PDFLib) {
  const r = Math.min(radius, width / 2, height / 2);
  const k = r * 0.5522847498;
  page.pushOperators(
    PDFLib.pushGraphicsState(),
    PDFLib.setFillingColor(fillColor),
    PDFLib.setStrokingColor(borderColor),
    PDFLib.setLineWidth(borderWidth),
    PDFLib.moveTo(x + r, y),
    PDFLib.lineTo(x + width - r, y),
    PDFLib.appendBezierCurve(x + width - r + k, y, x + width, y + r - k, x + width, y + r),
    PDFLib.lineTo(x + width, y + height - r),
    PDFLib.appendBezierCurve(x + width, y + height - r + k, x + width - r + k, y + height, x + width - r, y + height),
    PDFLib.lineTo(x + r, y + height),
    PDFLib.appendBezierCurve(x + r - k, y + height, x, y + height - r + k, x, y + height - r),
    PDFLib.lineTo(x, y + r),
    PDFLib.appendBezierCurve(x, y + r - k, x + r - k, y, x + r, y),
    PDFLib.closePath(),
    borderWidth ? PDFLib.fillAndStroke() : PDFLib.fill(),
    PDFLib.popGraphicsState(),
  );
}

async function loadPdfRuntime() {
  runtimePromise ||= Promise.all([
    loadScript(new URL("./vendor/pdf-lib-1.17.1.min.js", import.meta.url), "PDFLib"),
    loadScript(new URL("./vendor/fontkit-1.1.1.min.js", import.meta.url), "fontkit"),
    fetch(new URL("./fonts/NotoSansSC-Regular.ttf", import.meta.url)).then((response) => {
      if (!response.ok) throw new Error(`Font load failed: ${response.status}`);
      return response.arrayBuffer();
    }),
  ]).then(([PDFLib, fontkit, fontBytes]) => ({ PDFLib, fontkit, fontBytes }));
  return runtimePromise;
}

function loadScript(source, globalName) {
  if (globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source.href;
    script.onload = () => resolve(globalThis[globalName]);
    script.onerror = () => reject(new Error(`Script load failed: ${source.pathname}`));
    document.head.append(script);
  });
}
