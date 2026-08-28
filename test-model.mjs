import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMPTY_NOTE_PROMPTS, applyLassoSelection, connectionCurve, emptyNotePrompt, fitBoundsToViewport, hasDragIntent, normalizeBoard, pointInPolygon, removeConnectionsForNodes, screenToWorld, shouldDiscardDraft, shouldPinch, shouldResetPointers, toggleConnection, toggleConnectionsToTarget } from "./model.js";

const nodes = [{ id: "a", text: "A", x: 10, y: 20, color: "yellow", width: 340 }, { id: "b", text: "B", x: 30, y: 40, color: "neon" }];
let edges = toggleConnection([], "a", "b", () => "edge-1");
assert.deepEqual(edges, [{ id: "edge-1", from: "a", to: "b", arrow: false, label: "" }]);
edges = toggleConnection(edges, "b", "a");
assert.deepEqual(edges, []);

edges = toggleConnectionsToTarget([{ id: "a-c", from: "a", to: "c" }], ["a", "b"], "c", () => "b-c");
assert.deepEqual(edges, [{ id: "a-c", from: "a", to: "c" }, { id: "b-c", from: "b", to: "c", arrow: false, label: "" }]);
edges = toggleConnectionsToTarget(edges, ["a", "b"], "c");
assert.deepEqual(edges, []);
assert.deepEqual(removeConnectionsForNodes([{ id: "a-b", from: "a", to: "b" }, { id: "c-d", from: "c", to: "d" }], ["b"]), [{ id: "c-d", from: "c", to: "d" }]);

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
assert.deepEqual(restored.edges[0], { id: "a\u0000b", from: "a", to: "b", arrow: true, label: "支持" });
assert.deepEqual(restored.view, { x: 12, y: 0, scale: 2 });
assert.equal(normalizeBoard({ nodes: [], edges: [] }).title, "Untitled");

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
assert.match(app, /addEventListener\("dblclick", onDoubleClick\)/);
assert.doesNotMatch(app, /showToast\((?:"|`)已/);
assert.doesNotMatch(app, /未写完的想法/);
assert.doesNotMatch(html, /id="hint"|\stitle=/);
assert.match(html, /localStorage\.getItem\("scattered-theme"\)/);
assert.match(html, /id="theme-button"[\s\S]*?theme-moon[\s\S]*?theme-sun/);
assert.match(html, /id="export-button"[\s\S]*?<svg/);
assert.match(html, /id="github-link"[\s\S]*?https:\/\/github\.com\/kydchen\/scattered/);
assert.match(html, /id="empty-state"[\s\S]*?Double-tap anywhere/);
assert.match(html, /<svg class="app-logo"[\s\S]*?(app-logo-dot[\s\S]*?){6}<\/svg>/);
assert.doesNotMatch(html, /mark-dot/);
assert.match(html, /id="board-title"[\s\S]*?>Untitled</);
assert.match(css, /\.app-logo\s*\{[^}]*width:\s*31px;[^}]*height:\s*24px;/s);
assert.match(html, /id="edge-arrowhead"[\s\S]*?class="arrowhead"[\s\S]*?Z/);
assert.match(css, /#connections \.arrowhead\s*\{[^}]*fill:\s*var\(--thread\);[^}]*stroke:\s*none;/s);
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
assert.match(app, /const THEME_KEY = "scattered-theme"/);
assert.match(app, /function toggleTheme[\s\S]*?localStorage\.setItem\(THEME_KEY, next\)/);
assert.match(css, /html\[data-theme="dark"\]\s*\{[^}]*--canvas:\s*#16150f;[^}]*--paper:\s*#211f18;[^}]*--ink:\s*#eae4d6;/s);
assert.match(css, /html\[data-theme="dark"\][\s\S]*?--note-yellow:\s*#3a321b;[\s\S]*?--note-mint:\s*#193129;[\s\S]*?--note-blue:\s*#1b2c43;[\s\S]*?--note-rose:\s*#3a222a;/);
assert.match(css, /#connections \.edge\s*\{[^}]*outline:\s*none;[^}]*-webkit-tap-highlight-color:\s*transparent;/s);

console.log("model checks passed");
