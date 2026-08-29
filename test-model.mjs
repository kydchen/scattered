import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EMPTY_NOTE_PROMPTS, applyLassoSelection, boardToMermaidMarkdown, connectionCurve, copySelectedGraph, emptyNotePrompt, fitBoundsToViewport, hasDragIntent, nextArrowState, normalizeBoard, pasteSelectedGraph, pointInPolygon, removeConnectionsForNodes, screenToWorld, shouldDiscardDraft, shouldPinch, shouldResetPointers, toggleArrowsForNodes, toggleConnection, toggleConnectionsToTarget } from "./model.js";
import { createBoardSvg, wrapSvgText } from "./svg-export.js";
import { captureRecovery, createDocument, deleteDocument, duplicateDocument, hasRecovery, loadWorkspace, restoreLatest, saveDocument, switchDocument } from "./workspace.js";

const nodes = [{ id: "a", text: "A", x: 10, y: 20, color: "yellow", width: 340 }, { id: "b", text: "B", x: 30, y: 40, color: "neon" }];
let edges = toggleConnection([], "a", "b", () => "edge-1");
assert.deepEqual(edges, [{ id: "edge-1", from: "a", to: "b", arrow: false, label: "" }]);
edges = toggleConnection(edges, "b", "a");
assert.deepEqual(edges, []);
assert.deepEqual(
  toggleConnectionsToTarget([], ["a"], "b", () => "a-b"),
  [{ id: "a-b", from: "a", to: "b", arrow: false, label: "" }],
);

edges = toggleConnectionsToTarget([{ id: "a-c", from: "a", to: "c" }], ["a", "b"], "c", () => "b-c");
assert.deepEqual(edges, [{ id: "a-c", from: "c", to: "a", arrow: false }, { id: "b-c", from: "c", to: "b", arrow: false, label: "" }]);
edges = toggleConnectionsToTarget(edges, ["a", "b"], "c");
assert.deepEqual(edges, []);
assert.deepEqual(
  toggleConnectionsToTarget([{ id: "a-c", from: "a", to: "c", arrow: "forward", label: "" }], ["a", "b"], "c", () => "b-c"),
  [{ id: "a-c", from: "c", to: "a", arrow: "reverse", label: "" }, { id: "b-c", from: "c", to: "b", arrow: false, label: "" }],
);
assert.deepEqual(removeConnectionsForNodes([{ id: "a-b", from: "a", to: "b" }, { id: "c-d", from: "c", to: "d" }], ["b"]), [{ id: "c-d", from: "c", to: "d" }]);
const arrowEdges = [
  { id: "a-b", from: "a", to: "b", arrow: false },
  { id: "b-c", from: "b", to: "c", arrow: false },
  { id: "a-d", from: "a", to: "d", arrow: false },
  { id: "c-d", from: "c", to: "d", arrow: false },
];
const forwardArrows = toggleArrowsForNodes(arrowEdges, ["a", "b"]);
assert.deepEqual(forwardArrows.map((edge) => edge.arrow), ["forward", "forward", "forward", false]);
const reverseArrows = toggleArrowsForNodes(forwardArrows, ["a", "b"]);
assert.deepEqual(reverseArrows.map((edge) => edge.arrow), ["reverse", "reverse", "reverse", false]);
assert.deepEqual(toggleArrowsForNodes(reverseArrows, ["a", "b"]).map((edge) => edge.arrow), [false, false, false, false]);
assert.deepEqual(
  toggleArrowsForNodes([{ ...arrowEdges[1], arrow: "forward" }, { ...arrowEdges[2], arrow: "reverse" }], ["a", "b"]).map((edge) => edge.arrow),
  ["forward", "forward"],
);
assert.equal(toggleArrowsForNodes(arrowEdges, ["missing"]), arrowEdges);
const hierarchyEdges = [
  { id: "root-a", from: "root", to: "a", arrow: false },
  { id: "root-b", from: "root", to: "b", arrow: false },
  { id: "a-c", from: "a", to: "c", arrow: false },
  { id: "a-d", from: "a", to: "d", arrow: false },
];
assert.deepEqual(toggleArrowsForNodes(hierarchyEdges, ["a", "b", "c", "d"]).map((edge) => edge.arrow), ["forward", "forward", "forward", "forward"]);
assert.deepEqual(toggleArrowsForNodes(hierarchyEdges, ["root", "a", "b", "c", "d"]).map((edge) => edge.arrow), ["forward", "forward", "forward", "forward"]);
assert.equal(nextArrowState(false), "forward");
assert.equal(nextArrowState("forward"), "reverse");
assert.equal(nextArrowState("reverse"), false);

const copiedGraph = copySelectedGraph({
  nodes: [
    { id: "a", text: "A", x: 100, y: 200, width: 218 },
    { id: "b", text: "B", x: 360, y: 260, width: 260, color: "blue" },
    { id: "c", text: "C", x: 800, y: 500 },
  ],
  edges: [
    { id: "a-b", from: "a", to: "b", arrow: "forward", label: "supports" },
    { id: "b-c", from: "b", to: "c", arrow: false, label: "" },
  ],
}, ["a", "b"]);
assert.deepEqual(copiedGraph.nodes.map(({ id, x, y }) => ({ id, x, y })), [
  { id: "a", x: 0, y: 0 },
  { id: "b", x: 260, y: 60 },
]);
assert.equal(copiedGraph.edges.length, 1);
let generatedId = 0;
const pastedGraph = pasteSelectedGraph(copiedGraph, { x: 40, y: 50 }, () => `new-${++generatedId}`);
assert.deepEqual(pastedGraph.nodes.map(({ id, x, y }) => ({ id, x, y })), [
  { id: "new-1", x: 40, y: 50 },
  { id: "new-2", x: 300, y: 110 },
]);
assert.deepEqual(pastedGraph.edges[0], { id: "new-3", from: "new-1", to: "new-2", arrow: "forward", label: "supports" });
assert.equal(pasteSelectedGraph({ type: "other" }, { x: 0, y: 0 }), null);

assert.deepEqual(screenToWorld({ x: 120, y: 80 }, { x: 20, y: 30, scale: 2 }), { x: 50, y: 25 });
assert.deepEqual(fitBoundsToViewport(
  { left: 100, top: 50, right: 500, bottom: 250 },
  { width: 1000, height: 600 },
  100,
), { x: 200, y: 150, scale: 1 });
assert.deepEqual(fitBoundsToViewport(
  { left: 0, top: 0, right: 2000, bottom: 1000 },
  { width: 1000, height: 600 },
  50,
), { x: 50, y: 75, scale: 0.45 });

assert.equal(shouldPinch(["touch", "touch"]), true);
assert.equal(shouldPinch(["pen", "touch"]), false);
assert.equal(shouldPinch(["touch"]), false);

assert.equal(shouldResetPointers(["touch"], "touch", true), true);
assert.equal(shouldResetPointers(["touch"], "touch", false), false);
assert.equal(shouldResetPointers(["pen"], "touch", true), false);
assert.equal(shouldResetPointers(["touch"], "pen", true), true);
assert.equal(hasDragIntent("pen", 14, 0), false);
assert.equal(hasDragIntent("pen", 17, 0), true);
assert.equal(hasDragIntent("touch", 8, 0), false);
assert.equal(hasDragIntent("mouse", 5, 0), true);
const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
assert.equal(pointInPolygon({ x: 50, y: 50 }, square), true);
assert.equal(pointInPolygon({ x: 150, y: 50 }, square), false);

assert.equal(shouldDiscardDraft("", true, false), false);
assert.equal(shouldDiscardDraft("", true, true), true);
assert.equal(shouldDiscardDraft("内容", true, true), false);

assert.equal(EMPTY_NOTE_PROMPTS.length, 5);
assert.equal(emptyNotePrompt("same-note"), emptyNotePrompt("same-note"));
assert.equal(new Set(Array.from({ length: 50 }, (_, index) => emptyNotePrompt(`note-${index}`))).size, 5);
assert.ok(EMPTY_NOTE_PROMPTS.every((prompt) => [...prompt].length <= 24));

assert.deepEqual([...applyLassoSelection(["a"], ["b"], false)], ["b"]);
assert.deepEqual([...applyLassoSelection(["a"], [], false)], []);
assert.deepEqual([...applyLassoSelection(["a"], ["b"], true)], ["a", "b"]);
assert.deepEqual([...applyLassoSelection(["a", "b"], ["b", "c"], true)], ["a", "c"]);

const forwardCurve = connectionCurve({ x: 0, y: 0 }, { x: 100, y: 100 });
const reverseCurve = connectionCurve({ x: 100, y: 100 }, { x: 0, y: 0 });
assert.match(forwardCurve.path, / C /);
assert.deepEqual(forwardCurve.midpoint, reverseCurve.midpoint);
assert.notDeepEqual(forwardCurve.midpoint, { x: 50, y: 50 });
assert.ok(forwardCurve.control1 && forwardCurve.control2);

assert.deepEqual(wrapSvgText("中文测试\nlongword", 20, (value) => [...value].length * 10), ["中文", "测试", "lo", "ng", "wo", "rd"]);
const exportedSvg = createBoardSvg({
  title: "Ideas & links",
  nodes: [
    { id: "a", text: "中文<&", x: -2000, y: -1000, width: 220, color: "yellow" },
    { id: "b", text: "A distant idea", x: 4500, y: 2500, width: 260, color: "blue" },
  ],
  edges: [{ id: "e", from: "a", to: "b", arrow: "forward", label: "支持 & extends" }],
}, (value, size) => [...value].length * size * 0.6);
const viewBox = exportedSvg.match(/viewBox="([^"]+)"/)?.[1].split(" ").map(Number) || [];
const displaySize = exportedSvg.match(/<svg[^>]*width="([^"]+)" height="([^"]+)"/)?.slice(1).map(Number) || [];
assert.equal(viewBox.length, 4);
assert.ok(displaySize[0] <= 1600 && displaySize[1] <= 1200);
assert.ok(viewBox[0] <= -2048 && viewBox[1] <= -1048);
assert.ok(viewBox[0] + viewBox[2] >= 4808 && viewBox[1] + viewBox[3] >= 2596);
assert.match(exportedSvg, /^<\?xml version="1\.0"/);
assert.match(exportedSvg, /marker-end="url\(#arrowhead\)"/);
assert.match(exportedSvg, /<tspan/);
assert.match(exportedSvg, /Ideas &amp; links/);
assert.match(exportedSvg, /中文&lt;&amp;/);
assert.doesNotMatch(exportedSvg, /foreignObject|data:image/);

const restored = normalizeBoard({
  title: "  Project  ",
  nodes: [...nodes, { id: "a", text: "duplicate", x: 0, y: 0 }],
  edges: [{ from: "a", to: "b", arrow: true, label: "支持" }, { from: "b", to: "a" }, { from: "a", to: "missing" }],
  view: { x: "12", y: null, scale: 9 },
});
assert.equal(restored.title, "Project");
assert.equal(restored.nodes.length, 2);
assert.deepEqual(restored.nodes.map((node) => node.color), ["yellow", "plain"]);
assert.deepEqual(restored.nodes.map((node) => node.width), [340, 218]);
assert.equal(restored.edges.length, 1);
assert.deepEqual(restored.edges[0], { id: "a\u0000b", from: "a", to: "b", arrow: "forward", label: "支持" });
assert.deepEqual(restored.view, { x: 12, y: 0, scale: 2 });
assert.equal(normalizeBoard({ nodes: [], edges: [] }).title, "Untitled");
assert.equal(normalizeBoard({ nodes, edges: [{ from: "a", to: "b", arrow: "reverse" }] }).edges[0].arrow, "reverse");

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class FailingStorage extends MemoryStorage {
  setItem(key, value) {
    if (this.failWorkspace && key === "scattered-workspace-v1") throw new Error("quota");
    super.setItem(key, value);
  }
}

const storage = new MemoryStorage([["scattered-board-v1", JSON.stringify({ title: "Legacy", nodes: [{ id: "a", text: "kept", x: 0, y: 0 }], edges: [] })]]);
let time = 100;
const loadedWorkspace = loadWorkspace(storage, () => time++);
assert.equal(loadedWorkspace.board.title, "Legacy");
assert.equal(loadedWorkspace.workspace.boards.length, 1);
const firstBoardId = loadedWorkspace.workspace.activeId;
const changedBoard = { ...loadedWorkspace.board, title: "Changed", nodes: [{ ...loadedWorkspace.board.nodes[0], text: "new" }] };
saveDocument(storage, loadedWorkspace.workspace, changedBoard, () => time++);
storage.setItem(`scattered-document-v1:${firstBoardId}`, "broken");
const backupWorkspace = loadWorkspace(storage, () => time++);
assert.equal(backupWorkspace.recovered, true);
assert.equal(backupWorkspace.board.title, "Legacy");
saveDocument(storage, backupWorkspace.workspace, changedBoard, () => time++);
const secondBoard = createDocument(storage, backupWorkspace.workspace, { title: "Second", nodes: [], edges: [] }, () => time++);
assert.equal(secondBoard.title, "Second");
assert.equal(backupWorkspace.workspace.boards.length, 2);
const secondBoardId = backupWorkspace.workspace.activeId;
const copiedBoard = duplicateDocument(storage, backupWorkspace.workspace, secondBoard, () => time++);
assert.equal(copiedBoard.title, "Second · 2");
assert.equal(backupWorkspace.workspace.boards.length, 3);
assert.equal(switchDocument(storage, backupWorkspace.workspace, secondBoardId).board.title, "Second");
captureRecovery(storage, secondBoardId, secondBoard, "clear", () => time++);
assert.equal(hasRecovery(storage), true);
const restoredBoard = restoreLatest(storage, backupWorkspace.workspace, { ...secondBoard, title: "Empty" }, () => time++);
assert.equal(restoredBoard.title, "Second");
const afterDelete = deleteDocument(storage, backupWorkspace.workspace, restoredBoard, () => time++);
assert.ok(afterDelete && backupWorkspace.workspace.boards.length >= 1);
const failingStorage = new FailingStorage();
const safeWorkspace = loadWorkspace(failingStorage, () => time++);
const safeBoardId = safeWorkspace.workspace.activeId;
failingStorage.failWorkspace = true;
assert.throws(() => deleteDocument(failingStorage, safeWorkspace.workspace, safeWorkspace.board, () => time++), /quota/);
assert.notEqual(failingStorage.getItem(`scattered-document-v1:${safeBoardId}`), null);

const mermaid = boardToMermaidMarkdown({
  title: "Ideas",
  nodes: [
    { id: "a", text: "Parent \"quote\"\nline" },
    { id: "b", text: "Child | one" },
    { id: "c", text: "Third `note`" },
  ],
  edges: [
    { from: "a", to: "b", arrow: "forward", label: "supports" },
    { from: "a", to: "c", arrow: "reverse", label: "" },
    { from: "b", to: "c", arrow: false, label: "either | way" },
  ],
});
assert.match(mermaid, /^# Ideas\n\n_Exported from Scattered_/);
assert.match(mermaid, /```mermaid\nflowchart TB/);
assert.match(mermaid, /accTitle: Scattered Note Relationships/);
assert.match(mermaid, /note_1\["Parent &quot;quote&quot;<br\/>line"\]/);
assert.match(mermaid, /note_1 -->\|supports\| note_2/);
assert.match(mermaid, /note_3 --> note_1/);
assert.match(mermaid, /note_2 ---\|either &#124; way\| note_3/);
assert.match(mermaid, /note_3\["Third &#96;note&#96;"\]/);
assert.match(mermaid, /```\n$/);

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const nodeTextCss = css.match(/\.node-text\s*\{([^}]*)\}/s)?.[1] ?? "";
const nodeEditorCss = [...css.matchAll(/\.node-editor\s*\{([^}]*)\}/gs)].map((match) => match[1]).join("\n");
assert.match(nodeTextCss, /(?:^|\n)\s*user-select:\s*none;/);
assert.match(nodeTextCss, /-webkit-user-select:\s*none;/);
assert.match(nodeEditorCss, /(?:^|\n)\s*user-select:\s*text;/);
assert.match(nodeEditorCss, /-webkit-user-select:\s*text;/);
assert.match(css, /\.node\.empty-note \.node-text,[\s\S]*?font-style:\s*italic;[\s\S]*?font-weight:\s*400;/);

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("./manifest.webmanifest", import.meta.url), "utf8"));
const applyResizeSource = app.match(/function applyResize[\s\S]*?\n}/)?.[0] ?? "";
const pointerDownSource = app.match(/function onPointerDown[\s\S]*?\n}\n\nfunction onPointerMove/)?.[0] ?? "";
const doubleClickSource = app.match(/function onDoubleClick[\s\S]*?\n}\n\nfunction createNode/)?.[0] ?? "";
const menuMarkup = html.match(/<section id="menu"[\s\S]*?<\/section>/)?.[0] ?? "";
const editorFocusSources = ["editBoardTitle", "editNode", "openEdgeLabelEditor"].map((name) => (
  app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0] ?? ""
));
assert.doesNotMatch(app, /function queueResize/);
assert.match(applyResizeSource, /style\.setProperty/);
assert.match(applyResizeSource, /queueEdgeRender\(\)/);
editorFocusSources.forEach((source) => {
  assert.match(source, /\.focus\(\)/);
  assert.doesNotMatch(source, /requestAnimationFrame/);
});
assert.doesNotMatch(app, /isDoubleTap|shouldProtectPenTap/);
assert.doesNotMatch(app, /confirm\(/);
assert.match(app, /addEventListener\("dblclick", onDoubleClick\)/);
assert.match(pointerDownSource, /if \(!node\) \{\s*if \(activeEditor\) selectNode\(null\);\s*finishEditing\(\);/);
assert.match(doubleClickSource, /event\.target\.closest\("\.node"\)\s*\?\?\s*document\.elementFromPoint/);
assert.doesNotMatch(app, /showToast\((?:"|`)已/);
assert.doesNotMatch(app, /未写完的想法/);
assert.doesNotMatch(html, /id="hint"|\stitle=/);
assert.match(html, /localStorage\.getItem\("scattered-theme"\)/);
assert.match(html, /id="theme-button"[\s\S]*?theme-moon[\s\S]*?theme-sun/);
assert.doesNotMatch(menuMarkup, /theme-button/);
assert.match(html, /id="export-button"[\s\S]*?<svg/);
assert.match(html, /id="export-button"[\s\S]*?M12 3v12M8 11l4 4 4-4M5 19h14/);
assert.match(menuMarkup, /id="cancel-export-button"[\s\S]*?id="export-json-button"[\s\S]*?id="export-svg-button"[\s\S]*?id="export-mermaid-button"/);
assert.match(menuMarkup, /id="export-svg-button"[\s\S]*?<rect[\s\S]*?<circle[\s\S]*?m6\.5 16/);
assert.match(menuMarkup, /id="export-mermaid-button"[\s\S]*?m9 7-5 5 5 5/);
assert.match(html, /id="github-link"[\s\S]*?https:\/\/github\.com\/kydchen\/scattered/);
assert.match(html, /id="github-link"[\s\S]*?viewBox="-1 -1 26 26"/);
assert.match(html, /id="import-button"[\s\S]*?M12 15V3M8 7l4-4 4 4M5 19h14/);
assert.match(html, /id="boards-button"[\s\S]*?aria-expanded="false"[\s\S]*?class="app-logo"[\s\S]*?class="boards-disclosure"/);
assert.match(html, /id="board-picker"[\s\S]*?id="new-board-button"[\s\S]*?id="duplicate-board-button"[\s\S]*?id="restore-button"[\s\S]*?id="delete-board-button"/);
assert.doesNotMatch(menuMarkup, /id="restore-button"/);
assert.match(html, /id="search-panel"[\s\S]*?id="search-input"[\s\S]*?id="search-previous"[\s\S]*?id="search-next"/);
assert.match(html, /id="cancel-clear-button"[\s\S]*?aria-label="取消清空"/);
assert.match(html, /id="empty-state"[\s\S]*?Double-tap anywhere/);
assert.match(html, /<svg class="app-logo"[\s\S]*?(app-logo-dot[\s\S]*?){6}<\/svg>/);
assert.doesNotMatch(html, /mark-dot/);
assert.match(html, /id="board-title"[\s\S]*?>Untitled</);
assert.match(html, /<title>Scattered<\/title>/);
assert.match(html, /src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js"/);
assert.match(html, /data-cf-beacon='\{"token": "41d9c0c044944ad6b1bd274d2f27d9b7"\}'/);
assert.doesNotMatch(html, /\[https:\/\/static\.cloudflareinsights\.com/);
assert.match(css, /\.app-logo\s*\{[^}]*width:\s*31px;[^}]*height:\s*24px;/s);
assert.match(css, /\.theme-button\s*\{[^}]*position:\s*fixed;[^}]*right:[^}]*bottom:/s);
assert.match(html, /id="edge-arrowhead"[^>]*?orient="auto-start-reverse"[\s\S]*?class="arrowhead"/);
assert.match(html, /id="color-selection"[\s\S]*?id="duplicate-selection"[\s\S]*?id="arrow-selection"[\s\S]*?id="disconnect-selection"/);
assert.match(html, /id="arrow-selection"[\s\S]*?data-direction="none"[\s\S]*?arrow-head-forward[\s\S]*?arrow-head-reverse/);
assert.match(css, /#connections \.arrowhead\s*\{[^}]*fill:\s*var\(--thread\);[^}]*stroke:\s*none;/s);
assert.match(css, /\.menu\.choosing-export > :not\(\.export-choice\)/);
assert.doesNotMatch(css, /@media print|@page/);
assert.match(app, /boardToMermaidMarkdown/);
assert.match(app, /createBoardSvg\(board\)/);
assert.match(app, /navigator\.canShare/);
assert.match(app, /copySelectedGraph\(board, selectedIds\)/);
assert.match(app, /pasteSelectedGraph\(payload, origin\)/);
assert.match(app, /event\.key\.toLowerCase\(\) === "f"/);
assert.match(app, /event\.key\.toLowerCase\(\) === "d"/);
assert.match(app, /loadWorkspace\(localStorage\)/);
assert.match(app, /function preserveForRecovery[\s\S]*?captureRecovery\(localStorage, workspace\.activeId, board, reason\)/);
assert.doesNotMatch(app, /window\.print|beforeprint|preparePrintView|createBoardPdf|application\/pdf/);
const serviceWorker = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
assert.match(serviceWorker, /scattered-v25/);
assert.match(serviceWorker, /\.\/workspace\.js/);
assert.match(serviceWorker, /\.\/svg-export\.js/);
assert.doesNotMatch(serviceWorker, /pdf-export|pdf-lib|fontkit|NotoSansSC/);
assert.equal(existsSync(new URL("./pdf-export.js", import.meta.url)), false);
assert.equal(existsSync(new URL("./vendor", import.meta.url)), false);
assert.equal(existsSync(new URL("./fonts", import.meta.url)), false);
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
assert.match(app, /const THEME_KEY = "scattered-theme"/);
assert.match(app, /function toggleTheme[\s\S]*?localStorage\.setItem\(THEME_KEY, next\)/);
assert.match(app, /function clearBoard[\s\S]*?confirming-clear[\s\S]*?checkpoint\(\)/);
assert.match(css, /html\[data-theme="dark"\]\s*\{[^}]*--canvas:\s*#16150f;[^}]*--paper:\s*#211f18;[^}]*--ink:\s*#eae4d6;/s);
assert.match(css, /html\[data-theme="dark"\][\s\S]*?--note-yellow:\s*#3a321b;[\s\S]*?--note-mint:\s*#193129;[\s\S]*?--note-blue:\s*#1b2c43;[\s\S]*?--note-rose:\s*#3a222a;/);
assert.match(css, /#connections \.edge\s*\{[^}]*outline:\s*none;[^}]*-webkit-tap-highlight-color:\s*transparent;/s);

const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const readmeZh = readFileSync(new URL("./README.zh-CN.md", import.meta.url), "utf8");
const license = readFileSync(new URL("./LICENSE", import.meta.url), "utf8");
assert.match(readme, /\[简体中文\]\(README\.zh-CN\.md\)/);
assert.match(readmeZh, /\[English\]\(README\.md\)/);
assert.match(readme, /docs\/scattered-canvas\.png/);
assert.match(readmeZh, /作为网页 App 打开/);
assert.match(readme, /Install page as app/);
assert.match(readme, /JSON[\s\S]*SVG[\s\S]*Mermaid/);
assert.match(readmeZh, /Apple Pencil \+ 触控[\s\S]*纯触控[\s\S]*键盘 \+ 鼠标/);
assert.match(license, /^MIT License[\s\S]*Copyright \(c\) 2026 kydchen/);
assert.equal(existsSync(new URL("./docs/scattered-canvas.png", import.meta.url)), true);

console.log("model checks passed");
