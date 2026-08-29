import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EMPTY_NOTE_PROMPTS, MAX_IMPORT_BYTES, MAX_IMPORT_EDGES, MAX_IMPORT_NODES, applyLassoSelection, boardToMermaidMarkdown, connectionCurve, copySelectedGraph, emptyNotePrompt, fitBoundsToViewport, hasDragIntent, nextArrowState, normalizeBoard, parseImportedBoard, pasteSelectedGraph, pointInPolygon, removeConnectionsForNodes, screenToWorld, shouldDiscardDraft, shouldPinch, shouldResetPointers, toggleArrowsForNodes, toggleConnection, toggleConnectionsToTarget } from "./model.js";
import { createBoardSvg, wrapSvgText } from "./svg-export.js";
import { captureRecovery, clearPendingDocument, createDocument, deleteDocument, duplicateDocument, hasRecovery, loadWorkspace, restoreLatest, saveDocument, stagePendingDocument, switchDocument, withWorkspaceLock } from "./workspace.js";

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

const validImport = {
  version: 4,
  title: "Imported",
  nodes: [
    { id: "a", text: "A", x: 0, y: 0, color: "plain", width: 218 },
    { id: "b", text: "B", x: 300, y: 200, color: "blue", width: 260 },
  ],
  edges: [{ id: "a-b", from: "a", to: "b", arrow: "reverse", label: "because" }],
  view: { x: 0, y: 0, scale: 1 },
};
assert.deepEqual(parseImportedBoard(JSON.stringify(validImport)), validImport);
assert.equal(parseImportedBoard(JSON.stringify({ ...validImport, version: 3, edges: [{ ...validImport.edges[0], arrow: true }] })).edges[0].arrow, "forward");
const legacyDerivedEdgeId = "a\u0000b";
assert.equal(parseImportedBoard(JSON.stringify({
  ...validImport,
  version: 3,
  edges: [{ ...validImport.edges[0], id: legacyDerivedEdgeId, arrow: true }],
})).edges[0].id, legacyDerivedEdgeId);
[
  {},
  [],
  { ...validImport, version: 2 },
  { ...validImport, version: 5 },
  { version: 1, activeId: "a", boards: [] },
  { ...validImport, nodes: undefined },
].forEach((value) => assert.throws(() => parseImportedBoard(JSON.stringify(value))));

const validImportJson = JSON.stringify(validImport);
const validImportBytes = new TextEncoder().encode(validImportJson).byteLength;
assert.equal(parseImportedBoard(`${validImportJson}${" ".repeat(MAX_IMPORT_BYTES - validImportBytes)}`).title, "Imported");
assert.throws(() => parseImportedBoard(`${validImportJson}${" ".repeat(MAX_IMPORT_BYTES - validImportBytes + 1)}`), /2 MB/);

const importNode = (id) => ({ id, text: "", x: 0, y: 0, color: "plain", width: 218 });
const maximumNodes = Array.from({ length: MAX_IMPORT_NODES }, (_, index) => importNode(`n-${index}`));
assert.equal(parseImportedBoard(JSON.stringify({ ...validImport, nodes: maximumNodes, edges: [] })).nodes.length, MAX_IMPORT_NODES);
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, nodes: [...maximumNodes, importNode("too-many")], edges: [] })), /内容过多/);

const edgeNodes = Array.from({ length: 101 }, (_, index) => importNode(`edge-node-${index}`));
const maximumEdges = [];
for (let from = 0; from < edgeNodes.length && maximumEdges.length <= MAX_IMPORT_EDGES; from += 1) {
  for (let to = from + 1; to < edgeNodes.length && maximumEdges.length <= MAX_IMPORT_EDGES; to += 1) {
    maximumEdges.push({ id: `edge-${from}-${to}`, from: edgeNodes[from].id, to: edgeNodes[to].id, arrow: false, label: "" });
  }
}
assert.equal(parseImportedBoard(JSON.stringify({ ...validImport, nodes: edgeNodes, edges: maximumEdges.slice(0, MAX_IMPORT_EDGES) })).edges.length, MAX_IMPORT_EDGES);
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, nodes: edgeNodes, edges: maximumEdges.slice(0, MAX_IMPORT_EDGES + 1) })), /内容过多/);

assert.equal(parseImportedBoard(JSON.stringify({ ...validImport, nodes: [{ ...validImport.nodes[0], text: "x".repeat(20_000) }], edges: [] })).nodes[0].text.length, 20_000);
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, nodes: [{ ...validImport.nodes[0], text: "x".repeat(20_001) }], edges: [] })));
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, nodes: [{ ...validImport.nodes[0], id: "bad\u0000id" }], edges: [] })));
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, nodes: [validImport.nodes[0], { ...validImport.nodes[0] }], edges: [] })));
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, edges: [{ ...validImport.edges[0], to: "missing" }] })));
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, view: { x: 0, y: 0, scale: 3 } })));
assert.equal(parseImportedBoard(JSON.stringify({
  ...validImport,
  nodes: [{ ...validImport.nodes[0], x: 1_000_000, y: -1_000_000 }],
  edges: [],
  view: { x: -1_000_000, y: 1_000_000, scale: 1 },
})).nodes[0].x, 1_000_000);
assert.throws(() => parseImportedBoard(JSON.stringify({
  ...validImport,
  nodes: [{ ...validImport.nodes[0], x: 1_000_001 }],
  edges: [],
})));
assert.throws(() => parseImportedBoard(JSON.stringify({
  ...validImport,
  view: { x: 0, y: -1_000_001, scale: 1 },
})));

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class FailingStorage extends MemoryStorage {
  setItem(key, value) {
    if (this.failWorkspace && key === "scattered-workspace-v2") throw new Error("quota");
    super.setItem(key, value);
  }
}

class RemovalFailingStorage extends MemoryStorage {
  removeItem(key) {
    if (this.failPendingRemoval && key.startsWith("scattered-pending-document-v2:")) throw new Error("pending cleanup failed");
    if (this.failDocumentRemoval && (
      key.startsWith("scattered-document-v2:")
      || key.startsWith("scattered-document-backup-v2:")
    )) throw new Error("cleanup failed");
    super.removeItem(key);
  }
}

function storedWorkspace(storage) {
  return JSON.parse(storage.getItem("scattered-workspace-v2"));
}

function storedBoard(storage, id) {
  const value = JSON.parse(storage.getItem(`scattered-document-v2:${id}`));
  return value?.format === "scattered-document" ? value.board : value;
}

function pendingKeys(storage) {
  return [...storage.values.keys()].filter((key) => key.startsWith("scattered-pending-document-v2:"));
}

const storage = new MemoryStorage([["scattered-board-v1", JSON.stringify({ title: "Legacy", nodes: [{ id: "a", text: "kept", x: 0, y: 0 }], edges: [] })]]);
let time = 100;
const loadedWorkspace = loadWorkspace(storage, () => time++);
assert.equal(loadedWorkspace.board.title, "Legacy");
assert.equal(loadedWorkspace.workspace.boards.length, 1);
const firstBoardId = loadedWorkspace.workspace.activeId;
const changedBoard = { ...loadedWorkspace.board, title: "Changed", nodes: [{ ...loadedWorkspace.board.nodes[0], text: "new" }] };
saveDocument(storage, loadedWorkspace.workspace, changedBoard, () => time++);
storage.setItem(`scattered-document-v2:${firstBoardId}`, "broken");
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
assert.equal(restoredBoard.title, "Second · 3");
const afterDelete = deleteDocument(storage, backupWorkspace.workspace, restoredBoard, () => time++);
assert.ok(afterDelete && backupWorkspace.workspace.boards.length >= 1);
const failingStorage = new FailingStorage();
const safeWorkspace = loadWorkspace(failingStorage, () => time++);
const safeBoardId = safeWorkspace.workspace.activeId;
failingStorage.failWorkspace = true;
assert.throws(() => deleteDocument(failingStorage, safeWorkspace.workspace, safeWorkspace.board, () => time++), /quota/);
assert.notEqual(failingStorage.getItem(`scattered-document-v2:${safeBoardId}`), null);

const concurrentStorage = new MemoryStorage();
const concurrentA = loadWorkspace(concurrentStorage, () => time++);
const concurrentBWorkspace = structuredClone(concurrentA.workspace);
createDocument(concurrentStorage, concurrentA.workspace, { title: "Created in A", nodes: [], edges: [] }, () => time++);
saveDocument(concurrentStorage, concurrentBWorkspace, { ...concurrentA.board, title: "Saved in B" }, () => time++);
assert.deepEqual(new Set(storedWorkspace(concurrentStorage).boards.map((item) => item.title)), new Set(["Created in A", "Saved in B"]));

const identicalStorage = new MemoryStorage();
const identicalBase = loadWorkspace(identicalStorage, () => time++);
const identicalAWorkspace = structuredClone(identicalBase.workspace);
const identicalBWorkspace = structuredClone(identicalBase.workspace);
const identicalBoard = { ...identicalBase.board, title: "Same content" };
saveDocument(identicalStorage, identicalAWorkspace, identicalBoard, () => time++);
saveDocument(identicalStorage, identicalBWorkspace, identicalBoard, () => time++);
assert.equal(identicalBWorkspace.boards.length, 1);
assert.equal(identicalBWorkspace.activeId, identicalBase.workspace.activeId);

const conflictStorage = new MemoryStorage();
const conflictBase = loadWorkspace(conflictStorage, () => time++);
const conflictAWorkspace = structuredClone(conflictBase.workspace);
const conflictBWorkspace = structuredClone(conflictBase.workspace);
const conflictOriginalId = conflictBase.workspace.activeId;
saveDocument(conflictStorage, conflictAWorkspace, {
  ...conflictBase.board,
  title: "Shared",
  nodes: [{ id: "note", text: "A", x: 0, y: 0 }],
}, () => time++);
saveDocument(conflictStorage, conflictBWorkspace, {
  ...conflictBase.board,
  title: "Shared",
  nodes: [{ id: "note", text: "B", x: 0, y: 0 }],
}, () => time++);
assert.equal(storedBoard(conflictStorage, conflictOriginalId).nodes[0].text, "A");
assert.equal(conflictBWorkspace.boards.length, 2);
assert.notEqual(conflictBWorkspace.activeId, conflictOriginalId);
assert.equal(storedBoard(conflictStorage, conflictBWorkspace.activeId).nodes[0].text, "B");
assert.equal(storedBoard(conflictStorage, conflictBWorkspace.activeId).title, "Shared · 2");

const tombstoneStorage = new MemoryStorage();
const tombstoneA = loadWorkspace(tombstoneStorage, () => time++);
const tombstoneBWorkspace = structuredClone(tombstoneA.workspace);
const deletedId = tombstoneA.workspace.activeId;
deleteDocument(tombstoneStorage, tombstoneA.workspace, tombstoneA.board, () => time++);
saveDocument(tombstoneStorage, tombstoneBWorkspace, { ...tombstoneA.board, title: "Stale edit" }, () => time++);
assert.ok(tombstoneBWorkspace.tombstones.some((item) => item.id === deletedId));
assert.ok(!tombstoneBWorkspace.boards.some((item) => item.id === deletedId));
assert.notEqual(tombstoneBWorkspace.activeId, deletedId);
assert.equal(storedBoard(tombstoneStorage, tombstoneBWorkspace.activeId).title, "Stale edit · 2");

const nondestructiveRestoreStorage = new MemoryStorage();
const nondestructiveRestore = loadWorkspace(nondestructiveRestoreStorage, () => time++);
const nondestructiveOriginalId = nondestructiveRestore.workspace.activeId;
const oldVersion = { ...nondestructiveRestore.board, title: "A-old" };
saveDocument(nondestructiveRestoreStorage, nondestructiveRestore.workspace, oldVersion, () => time++);
captureRecovery(nondestructiveRestoreStorage, nondestructiveOriginalId, oldVersion, "clear", () => time++);
saveDocument(nondestructiveRestoreStorage, nondestructiveRestore.workspace, { ...oldVersion, title: "A-new" }, () => time++);
const unaffectedBoard = createDocument(nondestructiveRestoreStorage, nondestructiveRestore.workspace, { title: "B", nodes: [], edges: [] }, () => time++);
const recoveredCopy = restoreLatest(nondestructiveRestoreStorage, nondestructiveRestore.workspace, unaffectedBoard, () => time++);
assert.equal(storedBoard(nondestructiveRestoreStorage, nondestructiveOriginalId).title, "A-new");
assert.equal(recoveredCopy.title, "A-old");
assert.equal(nondestructiveRestore.workspace.boards.length, 3);
assert.notEqual(nondestructiveRestore.workspace.activeId, nondestructiveOriginalId);
assert.equal(hasRecovery(nondestructiveRestoreStorage), false);

const failedRestoreStorage = new FailingStorage();
const failedRestore = loadWorkspace(failedRestoreStorage, () => time++);
captureRecovery(failedRestoreStorage, failedRestore.workspace.activeId, { ...failedRestore.board, title: "Recover me" }, "clear", () => time++);
const recoveryBeforeFailure = failedRestoreStorage.getItem("scattered-recovery-v2");
const workspaceBeforeFailure = failedRestoreStorage.getItem("scattered-workspace-v2");
failedRestoreStorage.failWorkspace = true;
assert.throws(() => restoreLatest(failedRestoreStorage, failedRestore.workspace, failedRestore.board, () => time++), /quota/);
assert.equal(failedRestoreStorage.getItem("scattered-recovery-v2"), recoveryBeforeFailure);
assert.equal(failedRestoreStorage.getItem("scattered-workspace-v2"), workspaceBeforeFailure);

const failedSaveStorage = new FailingStorage();
const failedSave = loadWorkspace(failedSaveStorage, () => time++);
const failedSaveId = failedSave.workspace.activeId;
const documentBeforeFailedSave = failedSaveStorage.getItem(`scattered-document-v2:${failedSaveId}`);
const workspaceBeforeFailedSave = failedSaveStorage.getItem("scattered-workspace-v2");
failedSaveStorage.failWorkspace = true;
assert.throws(() => saveDocument(failedSaveStorage, failedSave.workspace, { ...failedSave.board, title: "Must not partially save" }, () => time++), /quota/);
assert.equal(failedSaveStorage.getItem(`scattered-document-v2:${failedSaveId}`), documentBeforeFailedSave);
assert.equal(failedSaveStorage.getItem("scattered-workspace-v2"), workspaceBeforeFailedSave);

const futureStorage = new MemoryStorage();
const future = loadWorkspace(futureStorage, () => time++);
const futureId = future.workspace.activeId;
saveDocument(futureStorage, future.workspace, { ...future.board, title: "Valid backup" }, () => time++);
saveDocument(futureStorage, future.workspace, { ...future.board, title: "Current" }, () => time++);
futureStorage.setItem(`scattered-document-v2:${futureId}`, JSON.stringify({ version: 5, title: "Future", nodes: [], edges: [], view: { x: 0, y: 0, scale: 1 } }));
const futureFallback = loadWorkspace(futureStorage, () => time++);
assert.equal(futureFallback.recovered, true);
assert.equal(futureFallback.board.title, "Valid backup");

const upgradedStorage = new MemoryStorage();
const upgraded = loadWorkspace(upgradedStorage, () => time++);
saveDocument(upgradedStorage, upgraded.workspace, { ...upgraded.board, title: "Envelope" }, () => time++);
const upgradedDocument = JSON.parse(upgradedStorage.getItem(`scattered-document-v2:${upgraded.workspace.activeId}`));
assert.equal(upgradedDocument._scattered.format, "scattered-document");
assert.equal(normalizeBoard(upgradedDocument).title, "Envelope");

const legacyPrimary = JSON.stringify({
  version: 4,
  title: "Legacy primary",
  nodes: [{ id: "legacy-primary-note", text: "kept", x: 0, y: 0 }],
  edges: [],
  view: { x: 1, y: 2, scale: 1 },
});
const legacyBackup = JSON.stringify({
  version: 4,
  title: "Legacy backup",
  nodes: [{ id: "legacy-backup-note", text: "also kept", x: 40, y: 50 }],
  edges: [],
  view: { x: 3, y: 4, scale: 1 },
});
const legacyRecovery = JSON.stringify([{
  boardId: "legacy-primary",
  board: JSON.parse(legacyPrimary),
  reason: "clear",
  savedAt: 10,
}]);
const migrationStorage = new MemoryStorage([
  ["scattered-workspace-v1", JSON.stringify({
    version: 1,
    activeId: "legacy-backup",
    boards: [
      { id: "legacy-primary", title: "Legacy primary", updatedAt: 10 },
      { id: "legacy-backup", title: "Legacy backup", updatedAt: 20 },
    ],
  })],
  ["scattered-document-v1:legacy-primary", legacyPrimary],
  ["scattered-document-backup-v1:legacy-backup", legacyBackup],
  ["scattered-recovery-v1", legacyRecovery],
]);
const migrated = loadWorkspace(migrationStorage, () => time++);
assert.equal(migrated.board.title, "Legacy backup");
assert.deepEqual(new Set(migrated.workspace.boards.map((item) => item.id)), new Set(["legacy-primary", "legacy-backup"]));
assert.equal(storedBoard(migrationStorage, "legacy-primary").title, "Legacy primary");
assert.equal(storedBoard(migrationStorage, "legacy-backup").title, "Legacy backup");
assert.notEqual(migrationStorage.getItem("scattered-document-backup-v2:legacy-backup"), null);
assert.equal(migrationStorage.getItem("scattered-storage-v2-ready"), "1");
assert.equal(hasRecovery(migrationStorage), true);
const isolatedDocument = migrationStorage.getItem("scattered-document-v2:legacy-primary");
const isolatedRecovery = migrationStorage.getItem("scattered-recovery-v2");
migrationStorage.setItem("scattered-document-v1:legacy-primary", JSON.stringify({ ...JSON.parse(legacyPrimary), title: "Old page overwrite" }));
migrationStorage.setItem("scattered-workspace-v1", JSON.stringify({ version: 1, activeId: "legacy-primary", boards: [] }));
migrationStorage.setItem("scattered-recovery-v1", "[]");
const isolatedReload = loadWorkspace(migrationStorage, () => time++);
assert.equal(storedBoard(migrationStorage, "legacy-primary").title, "Legacy primary");
assert.equal(isolatedReload.workspace.activeId, "legacy-backup");
assert.equal(migrationStorage.getItem("scattered-document-v2:legacy-primary"), isolatedDocument);
assert.equal(migrationStorage.getItem("scattered-recovery-v2"), isolatedRecovery);

const orphanStorage = new MemoryStorage();
const orphanBase = loadWorkspace(orphanStorage, () => time++);
createDocument(orphanStorage, orphanBase.workspace, { title: "Orphan candidate", nodes: [], edges: [] }, () => time++);
const orphanId = orphanBase.workspace.activeId;
orphanStorage.setItem("scattered-workspace-v2", "broken");
const reattached = loadWorkspace(orphanStorage, () => time++);
assert.ok(reattached.workspace.boards.some((item) => item.id === orphanId));
assert.equal(switchDocument(orphanStorage, reattached.workspace, orphanId).board.title, "Orphan candidate");

const viewStorage = new MemoryStorage();
const viewBase = loadWorkspace(viewStorage, () => time++);
const viewAWorkspace = structuredClone(viewBase.workspace);
const viewBWorkspace = structuredClone(viewBase.workspace);
saveDocument(viewStorage, viewAWorkspace, { ...viewBase.board, view: { x: 10, y: 0, scale: 1 } }, () => time++);
saveDocument(viewStorage, viewBWorkspace, { ...viewBase.board, view: { x: 20, y: 0, scale: 1 } }, () => time++);
assert.equal(viewBWorkspace.boards.length, 1);
assert.equal(storedBoard(viewStorage, viewBWorkspace.activeId).view.x, 20);
saveDocument(viewStorage, viewBWorkspace, { ...viewBase.board, view: { x: 30, y: 0, scale: 1 } }, () => time++);
assert.equal(storedBoard(viewStorage, viewBWorkspace.activeId).view.x, 30);

const deleteRollbackStorage = new FailingStorage();
const deleteRollback = loadWorkspace(deleteRollbackStorage, () => time++);
for (let index = 0; index < 5; index += 1) {
  captureRecovery(deleteRollbackStorage, deleteRollback.workspace.activeId, {
    ...deleteRollback.board,
    title: `Recovery ${index}`,
  }, "clear", () => time++);
}
const deleteRecoveryBeforeFailure = deleteRollbackStorage.getItem("scattered-recovery-v2");
const deleteWorkspaceBeforeFailure = deleteRollbackStorage.getItem("scattered-workspace-v2");
const deleteWorkspaceObjectBeforeFailure = structuredClone(deleteRollback.workspace);
deleteRollbackStorage.failWorkspace = true;
assert.throws(() => deleteDocument(
  deleteRollbackStorage,
  deleteRollback.workspace,
  deleteRollback.board,
  () => time++,
), /quota/);
assert.equal(deleteRollbackStorage.getItem("scattered-recovery-v2"), deleteRecoveryBeforeFailure);
assert.equal(deleteRollbackStorage.getItem("scattered-workspace-v2"), deleteWorkspaceBeforeFailure);
assert.deepEqual(deleteRollback.workspace, deleteWorkspaceObjectBeforeFailure);

const cleanupStorage = new RemovalFailingStorage();
const cleanupBase = loadWorkspace(cleanupStorage, () => time++);
const cleanupRemovedId = cleanupBase.workspace.activeId;
cleanupStorage.failDocumentRemoval = true;
const cleanupNextBoard = deleteDocument(cleanupStorage, cleanupBase.workspace, cleanupBase.board, () => time++);
assert.equal(cleanupNextBoard.title, "Untitled");
assert.ok(cleanupBase.workspace.tombstones.some((item) => item.id === cleanupRemovedId));
assert.ok(!cleanupBase.workspace.boards.some((item) => item.id === cleanupRemovedId));
assert.notEqual(cleanupStorage.getItem(`scattered-document-v2:${cleanupRemovedId}`), null);
cleanupStorage.setItem("scattered-workspace-v2", "broken");
const cleanupReload = loadWorkspace(cleanupStorage, () => time++);
assert.ok(!cleanupReload.workspace.boards.some((item) => item.id === cleanupRemovedId));

const pendingReloadStorage = new MemoryStorage();
const pendingReloadBase = loadWorkspace(pendingReloadStorage, () => time++);
const pendingReloadId = pendingReloadBase.workspace.activeId;
stagePendingDocument(pendingReloadStorage, pendingReloadBase.workspace, {
  ...pendingReloadBase.board,
  title: "Typed before reload",
  nodes: [{ id: "pending-note", text: "not lost", x: 0, y: 0 }],
}, () => time++);
assert.equal(pendingKeys(pendingReloadStorage).length, 1);
const pendingReloaded = loadWorkspace(pendingReloadStorage, () => time++);
assert.equal(pendingReloaded.workspace.activeId, pendingReloadId);
assert.equal(pendingReloaded.board.title, "Typed before reload");
assert.equal(pendingReloaded.board.nodes[0].text, "not lost");
assert.equal(pendingKeys(pendingReloadStorage).length, 0);
stagePendingDocument(pendingReloadStorage, pendingReloaded.workspace, { ...pendingReloaded.board, title: "Second pending edit" }, () => time++);
assert.equal(loadWorkspace(pendingReloadStorage, () => time++).board.title, "Second pending edit");

const failedPendingStorage = new FailingStorage();
const failedPendingBase = loadWorkspace(failedPendingStorage, () => time++);
saveDocument(failedPendingStorage, failedPendingBase.workspace, {
  ...failedPendingBase.board,
  title: "Persisted before failure",
}, () => time++);
stagePendingDocument(failedPendingStorage, failedPendingBase.workspace, {
  ...failedPendingBase.board,
  title: "Pending during failure",
}, () => time++);
failedPendingStorage.failWorkspace = true;
const failedPendingReload = loadWorkspace(failedPendingStorage, () => time++);
assert.equal(failedPendingReload.board.title, "Persisted before failure");
assert.equal(pendingKeys(failedPendingStorage).length, 1);
failedPendingStorage.failWorkspace = false;
assert.equal(loadWorkspace(failedPendingStorage, () => time++).board.title, "Pending during failure");
assert.equal(pendingKeys(failedPendingStorage).length, 0);

const conflictPendingStorage = new RemovalFailingStorage();
const conflictPendingBase = loadWorkspace(conflictPendingStorage, () => time++);
const conflictPendingOriginalId = conflictPendingBase.workspace.activeId;
stagePendingDocument(conflictPendingStorage, conflictPendingBase.workspace, {
  ...conflictPendingBase.board,
  title: "Pending edit",
  nodes: [{ id: "pending-conflict-note", text: "pending", x: 0, y: 0 }],
}, () => time++);
saveDocument(conflictPendingStorage, conflictPendingBase.workspace, {
  ...conflictPendingBase.board,
  title: "Concurrent edit",
  nodes: [{ id: "pending-conflict-note", text: "concurrent", x: 0, y: 0 }],
}, () => time++);
conflictPendingStorage.failPendingRemoval = true;
const firstConflictPendingReload = loadWorkspace(conflictPendingStorage, () => time++);
assert.equal(firstConflictPendingReload.workspace.boards.length, 2);
assert.equal(storedBoard(conflictPendingStorage, conflictPendingOriginalId).nodes[0].text, "concurrent");
assert.equal(firstConflictPendingReload.board.nodes[0].text, "pending");
assert.equal(pendingKeys(conflictPendingStorage).length, 1);
assert.doesNotThrow(() => clearPendingDocument(conflictPendingStorage));
conflictPendingStorage.failPendingRemoval = false;
const secondConflictPendingReload = loadWorkspace(conflictPendingStorage, () => time++);
assert.equal(secondConflictPendingReload.workspace.boards.length, 2);
assert.equal(pendingKeys(conflictPendingStorage).length, 0);

const invalidPendingStorage = new MemoryStorage();
loadWorkspace(invalidPendingStorage, () => time++);
invalidPendingStorage.setItem("scattered-pending-document-v2:invalid", "broken");
loadWorkspace(invalidPendingStorage, () => time++);
assert.equal(invalidPendingStorage.getItem("scattered-pending-document-v2:invalid"), null);

assert.equal(await withWorkspaceLock(() => "locked"), "locked");

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
const saveBoardNowSource = app.match(/async function saveBoardNow[\s\S]*?\n}\n\nasync function commitCurrentBoard/)?.[0] ?? "";
const stagePendingSaveSource = app.match(/function stagePendingSave[\s\S]*?\n}\n\nasync function saveBoardNow/)?.[0] ?? "";
const syncOpenInputsSource = app.match(/function syncOpenInputs[\s\S]*?\n}\n\nfunction snapshotState/)?.[0] ?? "";
const replacementSource = app.match(/function replaceCurrentBoard[\s\S]*?\n}\n\nfunction syncOpenInputs/)?.[0] ?? "";
const menuMarkup = html.match(/<section id="menu"[\s\S]*?<\/section>/)?.[0] ?? "";
const selectionArrowMarkup = html.match(/<button id="arrow-selection"[\s\S]*?<\/button>/)?.[0] ?? "";
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
assert.match(saveBoardNowSource, /syncOpenInputs\(\);[\s\S]*?if \(!boardDirty\) return true;[\s\S]*?withWorkspaceLock[\s\S]*?saveDocument[\s\S]*?boardDirty = false;[\s\S]*?markSaveFailure[\s\S]*?return false;/);
assert.match(saveBoardNowSource, /if \(conflicted\)[\s\S]*?board = saved;[\s\S]*?renderAll\(\)/);
assert.match(replacementSource, /await commitCurrentBoard\(\)[\s\S]*?withWorkspaceLock[\s\S]*?preserveForRecovery[\s\S]*?saveDocument/);
assert.match(replacementSource, /cancelGesture\(\)[\s\S]*?closeSearch\(\)[\s\S]*?checkpoint\(\)[\s\S]*?board = saved/);
["newBoard", "duplicateBoard", "removeCurrentBoard", "openBoard", "restoreRecentBoard"].forEach((name) => {
  const source = app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0] ?? "";
  assert.match(source, /await commitCurrentBoard\(\)/);
  assert.match(source, /withWorkspaceLock\(/);
});
assert.match(app, /async function importBoard[\s\S]*?file\.size > MAX_IMPORT_BYTES[\s\S]*?parseImportedBoard[\s\S]*?await replaceCurrentBoard\(imported, "import"\)/);
assert.match(app, /function preserveForRecovery[\s\S]*?if \(!storageReady\)[\s\S]*?return false;/);
assert.match(app, /function scheduleSave\(\)[\s\S]*?boardDirty = true;/);
assert.match(app, /addEventListener\("pagehide"[\s\S]*?stagePendingSave\(\)[\s\S]*?saveBoardNow\(\)/);
assert.match(stagePendingSaveSource, /syncOpenInputs\(\);[\s\S]*?if \(!boardDirty\) return;[\s\S]*?stagePendingDocument\(localStorage, workspace, board\)/);
assert.match(syncOpenInputsSource, /if \(changed\) boardDirty = true;[\s\S]*?return changed;/);
assert.match(saveBoardNowSource, /saveDocument[\s\S]*?clearPendingDocument\(localStorage\)/);
assert.match(app, /function snapshotState[\s\S]*?view: board\.view/);
assert.match(app, /function applyHistory[\s\S]*?board\.view = restored\.view[\s\S]*?applyView\(\)/);
assert.match(app, /function showToast[\s\S]*?if \(saveFailureMessage\)[\s\S]*?toast\.dataset\.persistent = "true"/);
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
assert.match(selectionArrowMarkup, /M4 12h16[\s\S]*?M15 7l5 5-5 5/);
assert.doesNotMatch(selectionArrowMarkup, /data-direction|aria-pressed|arrow-head-reverse/);
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
assert.match(serviceWorker, /scattered-v27/);
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
assert.match(app, /async function replaceCurrentBoard[\s\S]*?preserveForRecovery[\s\S]*?saveDocument[\s\S]*?checkpoint\(\)/);
assert.match(app, /async function clearBoard[\s\S]*?confirming-clear[\s\S]*?await replaceCurrentBoard\(blankBoard\(\), "clear"\)/);
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
