import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { EMPTY_NOTE_PROMPTS, EMPTY_NOTE_PROMPT_LANGS, MAX_IMPORT_BYTES, MAX_IMPORT_EDGES, MAX_IMPORT_NODES, MIN_VIEW_SCALE, applyLassoSelection, blankBoard, boardToMermaidMarkdown, connectionCurve, copySelectedGraph, emptyNotePrompt, emptyNotePromptLanguage, fitBoundsToViewport, hasDragIntent, minimumRevealDelta, nextArrowState, normalizeBoard, overviewLevel, parseImportedBoard, pasteSelectedGraph, pointInPolygon, rectIntersectsViewport, removeConnectionsForNodes, screenToWorld, shouldDiscardDraft, shouldPinch, shouldResetPointers, toggleArrowsForNodes, toggleConnection, toggleConnectionsToTarget } from "./model.js";
import { createDriveSync } from "./drive-sync.js";
import { createBoardSvg, wrapSvgText } from "./svg-export.js";
import { MAX_WORKSPACE_IMPORT_BOARDS, addImportedWorkspace, applySyncWorkspace, captureRecovery, clearPendingDocument, createDocument, createSyncWorkspace, createWorkspaceBackup, createWorkspaceSlots, deleteDocument, duplicateDocument, hasRecovery, loadWorkspace, parseImportedWorkspace, parseSyncWorkspace, replaceDocument, restoreLatest, saveDocument, stagePendingDocument, switchDocument, withWorkspaceLock } from "./workspace.js";
import { cloudSnapshotHeads, createCloudSnapshot, findCommonBaseIndex, fingerprintSyncWorkspace, indexSyncWorkspace, mergeSyncWorkspaces } from "./sync-model.js";
import { messages, t } from "./i18n.js";

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
assert.deepEqual(overviewLevel(0.6), { active: false, compact: false, distant: false, progress: 0, renderScale: 0.6 });
assert.deepEqual(overviewLevel(0.3), { active: true, compact: false, distant: false, progress: 1, renderScale: 0.3 });
assert.deepEqual(overviewLevel(0.29), { active: true, compact: true, distant: false, progress: 1, renderScale: 0.29 });
const readableOverview = overviewLevel(0.45);
assert.equal(readableOverview.active, true);
assert.ok(readableOverview.progress > 0 && readableOverview.progress < 1);
const compactOverview = overviewLevel(MIN_VIEW_SCALE);
assert.equal(compactOverview.renderScale, 0.1);
assert.equal(compactOverview.distant, true);
assert.equal(64 / compactOverview.renderScale, 640);

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
assert.equal(rectIntersectsViewport(
  { left: 380, top: 120, right: 430, bottom: 180 },
  { left: 0, top: 0, width: 390, height: 844 },
), true);
assert.equal(rectIntersectsViewport(
  { left: 390, top: 120, right: 430, bottom: 180 },
  { left: 0, top: 0, width: 390, height: 844 },
), false);
assert.equal(rectIntersectsViewport(
  { left: -80, top: 120, right: 0, bottom: 180 },
  { left: 0, top: 0, width: 390, height: 844 },
), false);
assert.deepEqual(
  minimumRevealDelta(
    { left: 100, right: 318, top: 200, bottom: 248 },
    { left: 0, top: 0, width: 390, height: 844 },
    { left: 24, right: 24, top: 72, bottom: 72 },
  ),
  { x: 0, y: 0 },
);
assert.deepEqual(
  minimumRevealDelta(
    { left: 140, right: 382, top: 200, bottom: 248 },
    { left: 0, top: 0, width: 390, height: 844 },
    { left: 24, right: 24, top: 72, bottom: 72 },
  ),
  { x: -16, y: 0 },
);
assert.deepEqual(
  minimumRevealDelta(
    { left: -20, right: 416, top: 20, bottom: 68 },
    { left: 0, top: 0, width: 390, height: 300 },
    { left: 24, right: 24, top: 72, bottom: 72 },
  ),
  { x: -3, y: 52 },
);
assert.deepEqual(
  minimumRevealDelta(
    { left: 160, right: 378, top: 556, bottom: 608 },
    { left: 0, top: 400, width: 402, height: 263 },
    { left: 24, right: 24, top: 72, bottom: 72 },
  ),
  { x: 0, y: -17 },
);
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
const phoneOverview = fitBoundsToViewport(
  { left: -3000, top: -1500, right: 3000, bottom: 1500 },
  { width: 390, height: 844 },
  72,
);
assert.ok(phoneOverview.scale < 0.35);
assert.ok(phoneOverview.scale >= MIN_VIEW_SCALE);
assert.ok(-3000 * phoneOverview.scale + phoneOverview.x >= 71.9);
assert.ok(3000 * phoneOverview.scale + phoneOverview.x <= 318.1);
assert.equal(normalizeBoard({ ...blankBoard(), view: phoneOverview }).view.scale, phoneOverview.scale);

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
assert.equal(EMPTY_NOTE_PROMPT_LANGS.length, EMPTY_NOTE_PROMPTS.length);
assert.equal(emptyNotePrompt("same-note"), emptyNotePrompt("same-note"));
assert.equal(emptyNotePromptLanguage("same-note"), emptyNotePromptLanguage("same-note"));
assert.equal(new Set(Array.from({ length: 50 }, (_, index) => emptyNotePrompt(`note-${index}`))).size, 5);
assert.ok(EMPTY_NOTE_PROMPTS.every((prompt) => [...prompt].length <= 24));
assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages["zh-Hans"]).sort());
assert.equal(t("undo", {}, "en"), "Undo");
assert.equal(t("undo", {}, "zh-Hans"), "撤销");
assert.equal(t("selectedNotes", { count: 3 }, "en"), "Selected notes: 3");
assert.equal(t("noteName", { text: "$&" }, "en"), "Note: $&");

assert.deepEqual([...applyLassoSelection(["a"], ["b"], false)], ["b"]);
assert.deepEqual([...applyLassoSelection(["a"], [], false)], []);
assert.deepEqual([...applyLassoSelection(["a"], ["b"], true)], ["a", "b"]);
assert.deepEqual([...applyLassoSelection(["a", "b"], ["b", "c"], true)], ["a", "c"]);

const forwardCurve = connectionCurve({ x: 0, y: 0 }, { x: 100, y: 100 });
const reverseCurve = connectionCurve({ x: 100, y: 100 }, { x: 0, y: 0 });
const straightConnection = connectionCurve({ x: 0, y: 0 }, { x: 100, y: 100 }, "straight");
assert.match(forwardCurve.path, / C /);
assert.deepEqual(forwardCurve.midpoint, reverseCurve.midpoint);
assert.notDeepEqual(forwardCurve.midpoint, { x: 50, y: 50 });
assert.ok(forwardCurve.control1 && forwardCurve.control2);
assert.match(straightConnection.path, / L /);
assert.deepEqual(straightConnection.midpoint, { x: 50, y: 50 });

assert.deepEqual(wrapSvgText("中文测试\nlongword", 20, (value) => [...value].length * 10), ["中文", "测试", "lo", "ng", "wo", "rd"]);
const exportedSvg = createBoardSvg({
  title: "Ideas & links",
  nodes: [
    { id: "a", text: "中文<&", x: -2000, y: -1000, width: 220, color: "yellow" },
    { id: "b", text: "A distant idea", x: 4500, y: 2500, width: 260, color: "blue" },
  ],
  edges: [{ id: "e", from: "a", to: "b", arrow: "forward", label: "支持 & extends" }],
}, "straight", (value, size) => [...value].length * size * 0.6);
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
assert.throws(() => parseImportedBoard(`${validImportJson}${" ".repeat(MAX_IMPORT_BYTES - validImportBytes + 1)}`), /import\.tooLarge/);

const importNode = (id) => ({ id, text: "", x: 0, y: 0, color: "plain", width: 218 });
const maximumNodes = Array.from({ length: MAX_IMPORT_NODES }, (_, index) => importNode(`n-${index}`));
assert.equal(parseImportedBoard(JSON.stringify({ ...validImport, nodes: maximumNodes, edges: [] })).nodes.length, MAX_IMPORT_NODES);
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, nodes: [...maximumNodes, importNode("too-many")], edges: [] })), /import\.tooMuchContent/);

const edgeNodes = Array.from({ length: 101 }, (_, index) => importNode(`edge-node-${index}`));
const maximumEdges = [];
for (let from = 0; from < edgeNodes.length && maximumEdges.length <= MAX_IMPORT_EDGES; from += 1) {
  for (let to = from + 1; to < edgeNodes.length && maximumEdges.length <= MAX_IMPORT_EDGES; to += 1) {
    maximumEdges.push({ id: `edge-${from}-${to}`, from: edgeNodes[from].id, to: edgeNodes[to].id, arrow: false, label: "" });
  }
}
assert.equal(parseImportedBoard(JSON.stringify({ ...validImport, nodes: edgeNodes, edges: maximumEdges.slice(0, MAX_IMPORT_EDGES) })).edges.length, MAX_IMPORT_EDGES);
assert.throws(() => parseImportedBoard(JSON.stringify({ ...validImport, nodes: edgeNodes, edges: maximumEdges.slice(0, MAX_IMPORT_EDGES + 1) })), /import\.tooMuchContent/);

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
    if (this.failWorkspaceBackup && key === "scattered-workspace-backup-v2") throw new Error("backup quota");
    if (this.failRecovery && key === "scattered-recovery-v2") throw new Error("recovery quota");
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

const pendingSyncStatuses = [];
const pendingSync = createDriveSync({
  apiUrl: "https://broker.example",
  storage: new MemoryStorage([
    ["scattered-drive-session-v1", "v1.c2VhbGVk"],
    ["scattered-drive-device-v1", "device-1"],
  ]),
  onStatus: (status) => pendingSyncStatuses.push(status),
});
pendingSync.schedule(60_000);
assert.deepEqual(pendingSyncStatuses, ["connected"]);
pendingSync.stop();

let releaseAccountLookup;
let accountLookupStarted;
const accountLookupReady = new Promise((resolve) => { accountLookupStarted = resolve; });
const disconnectRaceStatuses = [];
let boundAfterDisconnect = false;
const disconnectRace = createDriveSync({
  apiUrl: "https://broker.example",
  storage: new MemoryStorage([
    ["scattered-drive-session-v1", "v1.c2VhbGVk"],
    ["scattered-drive-device-v1", "device-race"],
  ]),
  getBoundAccount: () => null,
  bindAccount: () => { boundAfterDisconnect = true; },
  getWorkspace: () => { throw new Error("Workspace access continued after disconnect"); },
  onStatus: (status) => disconnectRaceStatuses.push(status),
  fetch: async (url) => {
    const href = String(url);
    if (href === "https://broker.example/token") {
      return Response.json({ accessToken: "drive-token", expiresIn: 3_600 });
    }
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)") {
      accountLookupStarted();
      return new Promise((resolve) => { releaseAccountLookup = resolve; });
    }
    return new Response("unexpected", { status: 500 });
  },
});
const disconnectRaceRun = disconnectRace.syncNow();
await accountLookupReady;
disconnectRace.disconnect();
releaseAccountLookup(Response.json({ user: { permissionId: "account-race" } }));
assert.equal(await disconnectRaceRun, false);
assert.equal(boundAfterDisconnect, false);
assert.equal(disconnectRaceStatuses.at(-1), "disconnected");

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

function recoveryEntries(storage) {
  return JSON.parse(storage.getItem("scattered-recovery-v2") || "[]");
}

function importJournalKeys(storage) {
  return [...storage.values.keys()].filter((key) => key.startsWith("scattered-import-journal-v1:"));
}

let time = 100;
const accountA = `gdrive-${"a".repeat(64)}`;
const accountB = `gdrive-${"b".repeat(64)}`;
const slotBaseStorage = new MemoryStorage();
const workspaceSlots = createWorkspaceSlots(slotBaseStorage);
const unboundSlot = loadWorkspace(workspaceSlots.storage, () => time++);
const accountABoard = saveDocument(
  workspaceSlots.storage,
  unboundSlot.workspace,
  { ...unboundSlot.board, title: "Account A" },
  () => time++,
);
captureRecovery(workspaceSlots.storage, unboundSlot.workspace.activeId, accountABoard, "replace", () => time++);
workspaceSlots.bind(accountA);
assert.equal(workspaceSlots.accountKey, accountA);
workspaceSlots.switchTo(accountB);
const accountBSlot = loadWorkspace(workspaceSlots.storage, () => time++);
assert.equal(accountBSlot.board.title, "Untitled");
assert.equal(hasRecovery(workspaceSlots.storage), false);
saveDocument(workspaceSlots.storage, accountBSlot.workspace, { ...accountBSlot.board, title: "Account B" }, () => time++);
workspaceSlots.switchTo(accountA);
const restoredAccountA = loadWorkspace(workspaceSlots.storage, () => time++);
assert.equal(restoredAccountA.board.title, "Account A");
assert.equal(hasRecovery(workspaceSlots.storage), true);
workspaceSlots.switchToGuest();
assert.equal(workspaceSlots.isGuest, true);
assert.equal(workspaceSlots.accountKey, null);
const guestSlot = loadWorkspace(workspaceSlots.storage, () => time++);
assert.equal(guestSlot.board.title, "Untitled");
assert.equal(hasRecovery(workspaceSlots.storage), false);
saveDocument(workspaceSlots.storage, guestSlot.workspace, { ...guestSlot.board, title: "Between accounts" }, () => time++);
const guestSyncWorkspace = createSyncWorkspace(workspaceSlots.storage, guestSlot.workspace);
workspaceSlots.switchTo(accountB);
const restoredAccountB = loadWorkspace(workspaceSlots.storage, () => time++);
const claimedGuest = await mergeSyncWorkspaces(
  guestSyncWorkspace,
  createSyncWorkspace(workspaceSlots.storage, restoredAccountB.workspace),
  [],
);
applySyncWorkspace(workspaceSlots.storage, restoredAccountB.workspace, claimedGuest.workspace, () => time++);
workspaceSlots.resetGuest();
assert.deepEqual(
  new Set(createSyncWorkspace(workspaceSlots.storage, restoredAccountB.workspace).boards.map((item) => item.board.title)),
  new Set(["Between accounts", "Account B"]),
);
assert.ok([...slotBaseStorage.values.keys()].some((key) => key.startsWith(`scattered-account-workspace-v1:${accountB}:`)));
workspaceSlots.switchTo(accountA);
assert.equal(loadWorkspace(workspaceSlots.storage, () => time++).board.title, "Account A");
workspaceSlots.switchToGuest();
assert.equal(loadWorkspace(workspaceSlots.storage, () => time++).board.title, "Untitled");
workspaceSlots.switchTo(accountA);

const workspaceBackupStorage = new MemoryStorage();
const workspaceBackupBase = loadWorkspace(workspaceBackupStorage, () => time++);
saveDocument(workspaceBackupStorage, workspaceBackupBase.workspace, { ...workspaceBackupBase.board, title: "First" }, () => time++);
const workspaceBackupCurrent = createDocument(
  workspaceBackupStorage,
  workspaceBackupBase.workspace,
  { title: "Second", nodes: [], edges: [] },
  () => time++,
);
const unsavedWorkspaceBoard = { ...workspaceBackupCurrent, nodes: [{ id: "unsaved", text: "kept", x: 0, y: 0 }] };
const workspaceBackup = createWorkspaceBackup(workspaceBackupStorage, workspaceBackupBase.workspace, unsavedWorkspaceBoard);
assert.equal(workspaceBackup.format, "scattered-workspace");
assert.equal(workspaceBackup.boards.length, 2);
assert.equal(workspaceBackup.boards[workspaceBackup.activeBoard].nodes[0].text, "kept");

const parsedWorkspaceBackup = parseImportedWorkspace(JSON.stringify(workspaceBackup));
assert.equal(parsedWorkspaceBackup.boards.length, 2);
assert.equal(parseImportedWorkspace(JSON.stringify(validImport)), null);
assert.throws(() => parseImportedWorkspace(JSON.stringify({ ...workspaceBackup, version: 2 })), /import\.unsupportedVersion/);
assert.throws(() => parseImportedWorkspace(JSON.stringify({
  ...workspaceBackup,
  activeBoard: 0,
  boards: Array.from({ length: MAX_WORKSPACE_IMPORT_BOARDS + 1 }, () => validImport),
})), /import\.tooMuchContent/);

const workspaceImportStorage = new MemoryStorage();
const workspaceImportTarget = loadWorkspace(workspaceImportStorage, () => time++);
const importedActiveBoard = addImportedWorkspace(workspaceImportStorage, workspaceImportTarget.workspace, parsedWorkspaceBackup, () => time++);
assert.equal(importedActiveBoard.title, "Second");
assert.equal(workspaceImportTarget.workspace.boards.length, 3);
assert.equal(storedBoard(workspaceImportStorage, workspaceImportTarget.workspace.activeId).nodes[0].text, "kept");

const failedWorkspaceImportStorage = new FailingStorage();
const failedWorkspaceImport = loadWorkspace(failedWorkspaceImportStorage, () => time++);
const failedWorkspaceImportBefore = failedWorkspaceImportStorage.getItem("scattered-workspace-v2");
failedWorkspaceImportStorage.failWorkspace = true;
assert.throws(() => addImportedWorkspace(
  failedWorkspaceImportStorage,
  failedWorkspaceImport.workspace,
  parsedWorkspaceBackup,
  () => time++,
), /quota/);
assert.equal(failedWorkspaceImportStorage.getItem("scattered-workspace-v2"), failedWorkspaceImportBefore);
assert.equal(importJournalKeys(failedWorkspaceImportStorage).length, 0);
assert.equal([...failedWorkspaceImportStorage.values.keys()].filter((key) => key.startsWith("scattered-document-v2:")).length, 1);

const interruptedImportStorage = new MemoryStorage();
loadWorkspace(interruptedImportStorage, () => time++);
interruptedImportStorage.setItem("scattered-document-v2:orphaned-import", JSON.stringify(validImport));
interruptedImportStorage.setItem("scattered-import-journal-v1:interrupted", JSON.stringify({
  format: "scattered-import",
  version: 1,
  id: "interrupted",
  startedAt: 0,
  ids: ["orphaned-import"],
}));
loadWorkspace(interruptedImportStorage, () => 200_001);
assert.equal(interruptedImportStorage.getItem("scattered-document-v2:orphaned-import"), null);
assert.equal(importJournalKeys(interruptedImportStorage).length, 0);

const activeImportStorage = new MemoryStorage();
loadWorkspace(activeImportStorage, () => time++);
activeImportStorage.setItem("scattered-document-v2:active-import", JSON.stringify(validImport));
activeImportStorage.setItem("scattered-import-journal-v1:active", JSON.stringify({
  format: "scattered-import",
  version: 1,
  id: "active",
  startedAt: 500_000,
  ids: ["active-import"],
}));
loadWorkspace(activeImportStorage, () => 500_001);
assert.notEqual(activeImportStorage.getItem("scattered-document-v2:active-import"), null);
assert.equal(importJournalKeys(activeImportStorage).length, 1);
loadWorkspace(activeImportStorage, () => 620_001);
assert.equal(activeImportStorage.getItem("scattered-document-v2:active-import"), null);
assert.equal(importJournalKeys(activeImportStorage).length, 0);

const largeWorkspaceBoards = Array.from({ length: 101 }, (_, index) => ({
  ...validImport,
  title: `Large ${index + 1}`,
  nodes: index === 0 ? Array.from({ length: 501 }, (__, nodeIndex) => importNode(`large-${nodeIndex}`)) : [],
  edges: [],
}));
const parsedLargeWorkspace = parseImportedWorkspace(JSON.stringify({
  format: "scattered-workspace",
  version: 1,
  activeBoard: 0,
  boards: largeWorkspaceBoards,
}));
const largeWorkspaceStorage = new MemoryStorage();
const largeWorkspaceTarget = loadWorkspace(largeWorkspaceStorage, () => time++);
const largeWorkspaceCurrent = addImportedWorkspace(
  largeWorkspaceStorage,
  largeWorkspaceTarget.workspace,
  parsedLargeWorkspace,
  () => time++,
);
const largeWorkspaceRoundTrip = createWorkspaceBackup(
  largeWorkspaceStorage,
  largeWorkspaceTarget.workspace,
  largeWorkspaceCurrent,
);
assert.equal(parseImportedWorkspace(JSON.stringify(largeWorkspaceRoundTrip)).boards.length, 102);

const freshExportStorage = new MemoryStorage();
const freshExportBase = loadWorkspace(freshExportStorage, () => time++);
const staleWorkspace = structuredClone(freshExportBase.workspace);
const staleCurrentBoard = structuredClone(freshExportBase.board);
createDocument(freshExportStorage, freshExportBase.workspace, { title: "Other tab", nodes: [], edges: [] }, () => time++);
const freshExport = createWorkspaceBackup(freshExportStorage, staleWorkspace, staleCurrentBoard);
assert.equal(freshExport.boards.length, 2);
assert.ok(freshExport.boards.some((candidate) => candidate.title === "Other tab"));

const conflictingExportStorage = new MemoryStorage();
const conflictingExportBase = loadWorkspace(conflictingExportStorage, () => time++);
const conflictingStaleWorkspace = structuredClone(conflictingExportBase.workspace);
const localExportBoard = { ...conflictingExportBase.board, nodes: [importNode("local-export")] };
const remoteExportWorkspace = structuredClone(conflictingExportBase.workspace);
saveDocument(conflictingExportStorage, remoteExportWorkspace, {
  ...conflictingExportBase.board,
  nodes: [importNode("remote-export")],
}, () => time++);
const conflictingExport = createWorkspaceBackup(conflictingExportStorage, conflictingStaleWorkspace, localExportBoard);
assert.equal(conflictingExport.boards.length, 2);
assert.deepEqual(new Set(conflictingExport.boards.flatMap((candidate) => candidate.nodes.map((node) => node.id))), new Set(["local-export", "remote-export"]));

const storage = new MemoryStorage([["scattered-board-v1", JSON.stringify({ title: "Legacy", nodes: [{ id: "a", text: "kept", x: 0, y: 0 }], edges: [] })]]);
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
const afterDelete = deleteDocument(storage, backupWorkspace.workspace, () => time++);
assert.ok(afterDelete && backupWorkspace.workspace.boards.length >= 1);
const failingStorage = new FailingStorage();
const safeWorkspace = loadWorkspace(failingStorage, () => time++);
const safeBoardId = safeWorkspace.workspace.activeId;
saveDocument(failingStorage, safeWorkspace.workspace, { ...safeWorkspace.board, title: "Keep me" }, () => time++);
failingStorage.failWorkspace = true;
assert.throws(() => deleteDocument(failingStorage, safeWorkspace.workspace, () => time++), /quota/);
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
saveDocument(tombstoneStorage, tombstoneA.workspace, { ...tombstoneA.board, title: "Delete me" }, () => time++);
const tombstoneBWorkspace = structuredClone(tombstoneA.workspace);
const deletedId = tombstoneA.workspace.activeId;
deleteDocument(tombstoneStorage, tombstoneA.workspace, () => time++);
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

const staleIndexStorage = new MemoryStorage();
const staleIndexBase = loadWorkspace(staleIndexStorage, () => time++);
const staleIndexId = staleIndexBase.workspace.activeId;
staleIndexStorage.removeItem(`scattered-document-v2:${staleIndexId}`);
staleIndexStorage.removeItem(`scattered-document-backup-v2:${staleIndexId}`);
const staleIndexReload = loadWorkspace(staleIndexStorage, () => time++);
assert.ok(!staleIndexReload.workspace.boards.some((item) => item.id === staleIndexId));
assert.equal(staleIndexReload.board.title, "Untitled");
assert.doesNotThrow(() => createSyncWorkspace(staleIndexStorage, staleIndexReload.workspace));

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
saveDocument(deleteRollbackStorage, deleteRollback.workspace, {
  ...deleteRollback.board,
  title: "Delete rollback target",
}, () => time++);
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
  () => time++,
), /quota/);
assert.equal(deleteRollbackStorage.getItem("scattered-recovery-v2"), deleteRecoveryBeforeFailure);
assert.equal(deleteRollbackStorage.getItem("scattered-workspace-v2"), deleteWorkspaceBeforeFailure);
assert.deepEqual(deleteRollback.workspace, deleteWorkspaceObjectBeforeFailure);

const cleanupStorage = new RemovalFailingStorage();
const cleanupBase = loadWorkspace(cleanupStorage, () => time++);
const cleanupRemovedId = cleanupBase.workspace.activeId;
saveDocument(cleanupStorage, cleanupBase.workspace, {
  ...cleanupBase.board,
  title: "Cleanup target",
}, () => time++);
cleanupStorage.failDocumentRemoval = true;
const cleanupNextBoard = deleteDocument(cleanupStorage, cleanupBase.workspace, () => time++);
assert.equal(cleanupNextBoard.title, "Untitled");
assert.ok(cleanupBase.workspace.tombstones.some((item) => item.id === cleanupRemovedId));
assert.ok(!cleanupBase.workspace.boards.some((item) => item.id === cleanupRemovedId));
assert.notEqual(cleanupStorage.getItem(`scattered-document-v2:${cleanupRemovedId}`), null);
cleanupStorage.setItem("scattered-workspace-v2", "broken");
const cleanupReload = loadWorkspace(cleanupStorage, () => time++);
assert.ok(!cleanupReload.workspace.boards.some((item) => item.id === cleanupRemovedId));

const blankDeleteStorage = new MemoryStorage();
const blankDelete = loadWorkspace(blankDeleteStorage, () => time++);
const blankDeleteId = blankDelete.workspace.activeId;
const blankDeleteResult = deleteDocument(blankDeleteStorage, blankDelete.workspace, () => time++);
assert.equal(blankDelete.workspace.activeId, blankDeleteId);
assert.equal(blankDelete.workspace.boards.length, 1);
assert.equal(blankDelete.workspace.tombstones.length, 0);
assert.equal(blankDeleteResult.title, "Untitled");
assert.equal(hasRecovery(blankDeleteStorage), false);

const replaceStorage = new MemoryStorage();
const replaceBase = loadWorkspace(replaceStorage, () => time++);
const replaceId = replaceBase.workspace.activeId;
const replaceSource = {
  ...replaceBase.board,
  title: "Project",
  nodes: [{ id: "replace-note", text: "Keep this", x: 10, y: 20 }],
};
saveDocument(replaceStorage, replaceBase.workspace, replaceSource, () => time++);
const clearedProject = replaceDocument(
  replaceStorage,
  replaceBase.workspace,
  { ...blankBoard(), title: "Project" },
  "clear",
  () => time++,
);
assert.equal(replaceBase.workspace.activeId, replaceId);
assert.equal(clearedProject.title, "Project");
assert.equal(clearedProject.nodes.length, 0);
assert.equal(recoveryEntries(replaceStorage).length, 1);
assert.equal(recoveryEntries(replaceStorage)[0].board.nodes[0].text, "Keep this");

const duplicateRecoveryStorage = new MemoryStorage();
const duplicateRecovery = loadWorkspace(duplicateRecoveryStorage, () => time++);
captureRecovery(duplicateRecoveryStorage, duplicateRecovery.workspace.activeId, duplicateRecovery.board, "clear", () => time++);
captureRecovery(duplicateRecoveryStorage, duplicateRecovery.workspace.activeId, duplicateRecovery.board, "clear", () => time++);
assert.equal(recoveryEntries(duplicateRecoveryStorage).length, 1);

const failedReplaceStorage = new FailingStorage();
const failedReplace = loadWorkspace(failedReplaceStorage, () => time++);
const failedReplaceId = failedReplace.workspace.activeId;
const failedReplaceSource = {
  ...failedReplace.board,
  title: "Must remain",
  nodes: [{ id: "safe-note", text: "safe", x: 0, y: 0 }],
};
saveDocument(failedReplaceStorage, failedReplace.workspace, failedReplaceSource, () => time++);
captureRecovery(failedReplaceStorage, failedReplaceId, failedReplaceSource, "delete", () => time++);
const failedReplaceRecoveryBefore = failedReplaceStorage.getItem("scattered-recovery-v2");
const failedReplaceDocumentBefore = failedReplaceStorage.getItem(`scattered-document-v2:${failedReplaceId}`);
const failedReplaceWorkspaceBefore = failedReplaceStorage.getItem("scattered-workspace-v2");
const failedReplaceObjectBefore = structuredClone(failedReplace.workspace);
failedReplaceStorage.failWorkspace = true;
assert.throws(() => replaceDocument(
  failedReplaceStorage,
  failedReplace.workspace,
  { ...blankBoard(), title: "Must remain" },
  "clear",
  () => time++,
), /quota/);
assert.equal(failedReplaceStorage.getItem("scattered-recovery-v2"), failedReplaceRecoveryBefore);
assert.equal(failedReplaceStorage.getItem(`scattered-document-v2:${failedReplaceId}`), failedReplaceDocumentBefore);
assert.equal(failedReplaceStorage.getItem("scattered-workspace-v2"), failedReplaceWorkspaceBefore);
assert.deepEqual(failedReplace.workspace, failedReplaceObjectBefore);

const conflictReplaceStorage = new MemoryStorage();
const conflictReplaceBase = loadWorkspace(conflictReplaceStorage, () => time++);
const conflictReplaceOriginalId = conflictReplaceBase.workspace.activeId;
const conflictReplaceStale = structuredClone(conflictReplaceBase.workspace);
saveDocument(conflictReplaceStorage, conflictReplaceBase.workspace, {
  ...conflictReplaceBase.board,
  title: "Concurrent newer",
  nodes: [{ id: "newer-note", text: "newer", x: 0, y: 0 }],
}, () => time++);
const conflictRecoveryBefore = conflictReplaceStorage.getItem("scattered-recovery-v2");
replaceDocument(
  conflictReplaceStorage,
  conflictReplaceStale,
  { ...blankBoard(), title: "Imported" },
  "import",
  () => time++,
);
assert.notEqual(conflictReplaceStale.activeId, conflictReplaceOriginalId);
assert.equal(storedBoard(conflictReplaceStorage, conflictReplaceOriginalId).title, "Concurrent newer");
assert.equal(storedBoard(conflictReplaceStorage, conflictReplaceStale.activeId).title, "Imported · 2");
assert.equal(conflictReplaceStorage.getItem("scattered-recovery-v2"), conflictRecoveryBefore);

const staleDeleteStorage = new MemoryStorage();
const staleDeleteBase = loadWorkspace(staleDeleteStorage, () => time++);
const staleDeleteId = staleDeleteBase.workspace.activeId;
saveDocument(staleDeleteStorage, staleDeleteBase.workspace, {
  ...staleDeleteBase.board,
  title: "Older",
}, () => time++);
const staleDeleteWorkspace = structuredClone(staleDeleteBase.workspace);
const staleDeleteAgain = structuredClone(staleDeleteBase.workspace);
saveDocument(staleDeleteStorage, staleDeleteBase.workspace, {
  ...staleDeleteBase.board,
  title: "Newest",
  nodes: [{ id: "latest-note", text: "latest", x: 0, y: 0 }],
}, () => time++);
deleteDocument(staleDeleteStorage, staleDeleteWorkspace, () => time++);
assert.equal(recoveryEntries(staleDeleteStorage)[0].board.title, "Newest");
assert.equal(recoveryEntries(staleDeleteStorage)[0].board.nodes[0].text, "latest");
assert.ok(staleDeleteWorkspace.tombstones.some((item) => item.id === staleDeleteId));
const staleDeleteRecovery = staleDeleteStorage.getItem("scattered-recovery-v2");
deleteDocument(staleDeleteStorage, staleDeleteAgain, () => time++);
assert.equal(staleDeleteStorage.getItem("scattered-recovery-v2"), staleDeleteRecovery);

const nextBackupStorage = new MemoryStorage();
const nextBackupBase = loadWorkspace(nextBackupStorage, () => time++);
const nextBackupId = nextBackupBase.workspace.activeId;
saveDocument(nextBackupStorage, nextBackupBase.workspace, {
  ...nextBackupBase.board,
  title: "Fallback first",
  nodes: [{ id: "fallback-first", text: "first", x: 0, y: 0 }],
}, () => time++);
saveDocument(nextBackupStorage, nextBackupBase.workspace, {
  ...nextBackupBase.board,
  title: "Fallback latest",
  nodes: [{ id: "fallback-latest", text: "latest", x: 0, y: 0 }],
}, () => time++);
const backupDocument = JSON.parse(nextBackupStorage.getItem(`scattered-document-backup-v2:${nextBackupId}`));
const backupRevision = backupDocument._scattered.revision;
createDocument(nextBackupStorage, nextBackupBase.workspace, {
  ...blankBoard(),
  title: "Delete me",
  nodes: [{ id: "delete-next", text: "delete", x: 0, y: 0 }],
}, () => time++);
nextBackupStorage.setItem(`scattered-document-v2:${nextBackupId}`, "broken");
const nextFromBackup = deleteDocument(nextBackupStorage, nextBackupBase.workspace, () => time++);
assert.equal(nextBackupBase.workspace.activeId, nextBackupId);
assert.equal(nextFromBackup.title, "Fallback first");
assert.equal(nextBackupBase.workspace.boards[0].revision, backupRevision);
saveDocument(nextBackupStorage, nextBackupBase.workspace, {
  ...nextFromBackup,
  nodes: [{ id: "fallback-edited", text: "edited", x: 0, y: 0 }],
}, () => time++);
assert.equal(nextBackupBase.workspace.boards.length, 1);
assert.equal(storedBoard(nextBackupStorage, nextBackupId).nodes[0].text, "edited");

const backupFailureStorage = new FailingStorage();
const backupFailure = loadWorkspace(backupFailureStorage, () => time++);
const backupFailureId = backupFailure.workspace.activeId;
saveDocument(backupFailureStorage, backupFailure.workspace, {
  ...backupFailure.board,
  title: "Backup guarded",
}, () => time++);
const backupFailureRecoveryBefore = backupFailureStorage.getItem("scattered-recovery-v2");
const backupFailureWorkspaceBefore = backupFailureStorage.getItem("scattered-workspace-v2");
const backupFailureWorkspaceBackupBefore = backupFailureStorage.getItem("scattered-workspace-backup-v2");
const backupFailureDocumentBefore = backupFailureStorage.getItem(`scattered-document-v2:${backupFailureId}`);
const backupFailureObjectBefore = structuredClone(backupFailure.workspace);
backupFailureStorage.failWorkspaceBackup = true;
assert.throws(() => deleteDocument(backupFailureStorage, backupFailure.workspace, () => time++), /backup quota/);
assert.equal(backupFailureStorage.getItem("scattered-recovery-v2"), backupFailureRecoveryBefore);
assert.equal(backupFailureStorage.getItem("scattered-workspace-v2"), backupFailureWorkspaceBefore);
assert.equal(backupFailureStorage.getItem("scattered-workspace-backup-v2"), backupFailureWorkspaceBackupBefore);
assert.equal(backupFailureStorage.getItem(`scattered-document-v2:${backupFailureId}`), backupFailureDocumentBefore);
assert.deepEqual(backupFailure.workspace, backupFailureObjectBefore);

const recoveryFailureStorage = new FailingStorage();
const recoveryFailure = loadWorkspace(recoveryFailureStorage, () => time++);
const recoveryFailureId = recoveryFailure.workspace.activeId;
saveDocument(recoveryFailureStorage, recoveryFailure.workspace, {
  ...recoveryFailure.board,
  title: "Recovery guarded",
  nodes: [{ id: "recovery-guarded-note", text: "keep", x: 0, y: 0 }],
}, () => time++);
const recoveryFailureDocumentBefore = recoveryFailureStorage.getItem(`scattered-document-v2:${recoveryFailureId}`);
const recoveryFailureWorkspaceBefore = recoveryFailureStorage.getItem("scattered-workspace-v2");
recoveryFailureStorage.failRecovery = true;
assert.throws(() => replaceDocument(
  recoveryFailureStorage,
  recoveryFailure.workspace,
  { ...blankBoard(), title: "Recovery guarded" },
  "clear",
  () => time++,
), /recovery quota/);
assert.equal(recoveryFailureStorage.getItem(`scattered-document-v2:${recoveryFailureId}`), recoveryFailureDocumentBefore);
assert.equal(recoveryFailureStorage.getItem("scattered-workspace-v2"), recoveryFailureWorkspaceBefore);

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

const deletedPendingStorage = new RemovalFailingStorage();
const deletedPendingBase = loadWorkspace(deletedPendingStorage, () => time++);
const deletedPendingId = deletedPendingBase.workspace.activeId;
const deletedPendingBoard = {
  ...deletedPendingBase.board,
  title: "Delete pending once",
  nodes: [{ id: "delete-pending-note", text: "must stay deleted", x: 0, y: 0 }],
};
stagePendingDocument(deletedPendingStorage, deletedPendingBase.workspace, deletedPendingBoard, () => time++);
saveDocument(deletedPendingStorage, deletedPendingBase.workspace, deletedPendingBoard, () => time++);
deletedPendingStorage.failPendingRemoval = true;
clearPendingDocument(deletedPendingStorage);
assert.equal(pendingKeys(deletedPendingStorage).length, 1);
assert.equal(deletedPendingStorage.getItem(pendingKeys(deletedPendingStorage)[0]), "null");
deleteDocument(deletedPendingStorage, deletedPendingBase.workspace, () => time++);
const deletedPendingReload = loadWorkspace(deletedPendingStorage, () => time++);
assert.ok(deletedPendingReload.workspace.tombstones.some((item) => item.id === deletedPendingId));
assert.ok(!deletedPendingReload.workspace.boards.some((item) => item.id === deletedPendingId));
assert.equal(deletedPendingReload.workspace.boards.length, 1);
assert.equal(deletedPendingReload.board.nodes.length, 0);
assert.equal(pendingKeys(deletedPendingStorage).length, 1);
deletedPendingStorage.failPendingRemoval = false;
loadWorkspace(deletedPendingStorage, () => time++);
assert.equal(pendingKeys(deletedPendingStorage).length, 0);

const clearedPendingStorage = new RemovalFailingStorage();
const clearedPendingBase = loadWorkspace(clearedPendingStorage, () => time++);
const clearedPendingId = clearedPendingBase.workspace.activeId;
const clearedPendingBoard = {
  ...clearedPendingBase.board,
  title: "Clear pending once",
  nodes: [{ id: "clear-pending-note", text: "must stay cleared", x: 0, y: 0 }],
};
stagePendingDocument(clearedPendingStorage, clearedPendingBase.workspace, clearedPendingBoard, () => time++);
saveDocument(clearedPendingStorage, clearedPendingBase.workspace, clearedPendingBoard, () => time++);
clearedPendingStorage.failPendingRemoval = true;
clearPendingDocument(clearedPendingStorage);
assert.equal(pendingKeys(clearedPendingStorage).length, 1);
assert.equal(clearedPendingStorage.getItem(pendingKeys(clearedPendingStorage)[0]), "null");
replaceDocument(
  clearedPendingStorage,
  clearedPendingBase.workspace,
  { ...blankBoard(), title: clearedPendingBoard.title },
  "clear",
  () => time++,
);
const clearedPendingReload = loadWorkspace(clearedPendingStorage, () => time++);
assert.equal(clearedPendingReload.workspace.activeId, clearedPendingId);
assert.equal(clearedPendingReload.workspace.boards.length, 1);
assert.equal(clearedPendingReload.board.title, clearedPendingBoard.title);
assert.equal(clearedPendingReload.board.nodes.length, 0);
assert.equal(pendingKeys(clearedPendingStorage).length, 1);
clearedPendingStorage.failPendingRemoval = false;
loadWorkspace(clearedPendingStorage, () => time++);
assert.equal(pendingKeys(clearedPendingStorage).length, 0);

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
assert.match(css, /\.node-text a\[x-apple-data-detectors\],[\s\S]*?text-decoration:\s*none !important;/);

const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("./manifest.webmanifest", import.meta.url), "utf8"));
const applyResizeSource = app.match(/function applyResize[\s\S]*?\n}/)?.[0] ?? "";
const pointerDownSource = app.match(/function onPointerDown[\s\S]*?\n}\n\nfunction onPointerMove/)?.[0] ?? "";
const pointerMoveSource = app.match(/function onPointerMove[\s\S]*?\n}\n\nfunction onPointerUp/)?.[0] ?? "";
const doubleClickSource = app.match(/function onDoubleClick[\s\S]*?\n}\n\nfunction createNode/)?.[0] ?? "";
const saveBoardNowSource = app.match(/async function saveBoardNow[\s\S]*?\n}\n\nasync function commitCurrentBoard/)?.[0] ?? "";
const stagePendingSaveSource = app.match(/function stagePendingSave[\s\S]*?\n}\n\nasync function saveBoardNow/)?.[0] ?? "";
const syncOpenInputsSource = app.match(/function syncOpenInputs[\s\S]*?\n}\n\nfunction snapshotState/)?.[0] ?? "";
const replacementSource = app.match(/function replaceCurrentBoard[\s\S]*?\n}\n\nfunction syncOpenInputs/)?.[0] ?? "";
const openSearchSource = app.match(/function openSearch[\s\S]*?\n}\n\nfunction closeSearch/)?.[0] ?? "";
const onKeyDownSource = app.match(/function onKeyDown[\s\S]*?\n}\n\nfunction initializeWorkspace/)?.[0] ?? "";
const applyHistorySource = app.match(/function applyHistory[\s\S]*?\n}\n\nfunction updateHistoryControls/)?.[0] ?? "";
const finishKeyboardLinkSource = app.match(/function finishKeyboardLink[\s\S]*?\n}\n\nfunction cancelKeyboardLink/)?.[0] ?? "";
const menuMarkup = html.match(/<section id="menu"[\s\S]*?<\/section>/)?.[0] ?? "";
const driveSyncErrorCodeSource = app.match(/function driveSyncErrorCode[\s\S]*?\n}/)?.[0] ?? "";
const driveSyncErrorCode = Function(`"use strict"; ${driveSyncErrorCodeSource}; return driveSyncErrorCode;`)();
const edgeAutoPanVelocitySource = app.match(/function edgeAutoPanVelocity[\s\S]*?\n}/)?.[0] ?? "";
const edgeAutoPanVelocity = Function(`"use strict"; ${edgeAutoPanVelocitySource}; return edgeAutoPanVelocity;`)();
const autoPanViewport = { left: 0, top: 0, width: 390, height: 844 };
assert.deepEqual(edgeAutoPanVelocity({ x: 195, y: 422 }, autoPanViewport), { x: 0, y: 0 });
assert.deepEqual(edgeAutoPanVelocity({ x: 0, y: 422 }, autoPanViewport), { x: 640, y: 0 });
assert.deepEqual(edgeAutoPanVelocity({ x: 390, y: 844 }, autoPanViewport), { x: -640, y: -640 });
assert.ok(edgeAutoPanVelocity({ x: 28, y: 422 }, autoPanViewport).x > 0);
assert.ok(edgeAutoPanVelocity({ x: 28, y: 422 }, autoPanViewport).x < 640);
assert.equal(driveSyncErrorCode({ code: "auth" }), "auth");
assert.equal(driveSyncErrorCode(new Error("Drive sync failed: drive-403")), "drive-403");
assert.equal(driveSyncErrorCode(Object.assign(new TypeError("Load failed"), { syncStage: "prepare" })), "prepare-network");
assert.equal(driveSyncErrorCode(Object.assign(new Error("sync.invalidWorkspace"), { syncStage: "local" })), "local-sync-invalidworkspace");
assert.equal(driveSyncErrorCode(new Error("Unexpected")), "unknown");
assert.match(html, /<meta name="format-detection" content="telephone=no" \/>/);
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
assert.match(app, /boardTitle\.addEventListener\("click"[\s\S]*?event\.detail === 0[\s\S]*?editBoardTitle\(\)/);
assert.match(app, /event\.target !== element[\s\S]*?event\.key\.toLowerCase\(\) === "l"[\s\S]*?startKeyboardLink/);
assert.match(app, /textarea, input, button, a, \[role=button\][\s\S]*?event\.code === "Space"/);
assert.match(onKeyDownSource, /canvasShortcutTarget[\s\S]*?overlayOpen[\s\S]*?event\.key\.toLowerCase\(\) === "n"/);
assert.match(openSearchSource, /closest\?\.\("#menu"\)[\s\S]*?menuButton[\s\S]*?closest\?\.\("\.node"\)/);
assert.match(applyHistorySource, /focusedNodeId[\s\S]*?focusedEdgeId[\s\S]*?requestAnimationFrame/);
assert.match(app, /async function openBoard[\s\S]*?id === workspace\.activeId[\s\S]*?boardsButton\.focus\(\)/);
assert.match(app, /function updateBoardTitle[\s\S]*?t\("boardTitleEdit", \{ title \}\)/);
assert.match(app, /async function shareOrDownloadBlob[\s\S]*?try \{ canShare =[\s\S]*?error\?\.name === "AbortError"/);
const exportBoardSource = app.match(/async function exportBoard\(\)[\s\S]*?\n}/)?.[0] || "";
assert.match(exportBoardSource, /JSON\.stringify\(normalizeBoard\(board\), null, 2\)/);
assert.match(exportBoardSource, /`\$\{exportFileName\(\)\}\.json`/);
assert.doesNotMatch(exportBoardSource, /createWorkspaceBackup|Scattered-backup/);
assert.match(pointerDownSource, /if \(!node\) \{\s*if \(activeEditor\) selectNode\(null\);\s*finishEditing\(\);/);
assert.match(doubleClickSource, /event\.target\.closest\("\.node"\)\s*\?\?\s*document\.elementFromPoint/);
assert.match(saveBoardNowSource, /syncOpenInputs\(\);[\s\S]*?if \(!boardDirty\) return true;[\s\S]*?withWorkspaceLock[\s\S]*?saveDocument[\s\S]*?boardDirty = false;[\s\S]*?markSaveFailure[\s\S]*?return false;/);
assert.match(saveBoardNowSource, /if \(conflicted\)[\s\S]*?board = saved;[\s\S]*?renderAll\(\)/);
assert.match(replacementSource, /beginWorkspaceAction\(\)[\s\S]*?await commitCurrentBoard\(\)[\s\S]*?withWorkspaceLock[\s\S]*?replaceDocument\(workspaceStorage, workspace, nextBoard, recoveryReason\)/);
assert.match(replacementSource, /workspace\.activeId !== previousId[\s\S]*?replaceBoard\(saved\)[\s\S]*?cancelGesture\(\)[\s\S]*?closeSearch\(\)[\s\S]*?checkpoint\(\)[\s\S]*?board = saved/);
["newBoard", "duplicateBoard", "removeCurrentBoard", "openBoard", "restoreRecentBoard"].forEach((name) => {
  const source = app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0] ?? "";
  assert.match(source, /beginWorkspaceAction\(\)/);
  assert.match(source, /await commitCurrentBoard\(\)/);
  assert.match(source, /withWorkspaceLock\(/);
});
assert.match(app, /async function importBoard[\s\S]*?file\.size > MAX_WORKSPACE_IMPORT_BYTES[\s\S]*?parseImportedWorkspace\(encoded\)[\s\S]*?mergeImportedWorkspace[\s\S]*?replaceCurrentBoard\(parseImportedBoard\(encoded\), "import"\)/);
assert.doesNotMatch(app, /function preserveForRecovery/);
assert.match(app, /function beginWorkspaceAction\(\)[\s\S]*?workspaceActionPending[\s\S]*?aria-busy[\s\S]*?disabled = true/);
assert.match(app, /type: "link"[\s\S]*?pointerType: event\.pointerType[\s\S]*?startX: event\.clientX[\s\S]*?moved: false/);
assert.match(pointerDownSource, /if \(keyboardLinkSourceIds\)[\s\S]*?connectKeyboardLinkTo\(target\.dataset\.id\)[\s\S]*?isBlankCanvasTarget\(event\.target\)[\s\S]*?createNode\(point\.x, point\.y, event\.pointerType === "pen", sourceIds\)/);
assert.match(pointerMoveSource, /keyboardLinkSourceIds[\s\S]*?updateLinkPreview\(keyboardLinkSourceIds, event\.clientX, event\.clientY\)[\s\S]*?updateLinkTarget\(keyboardLinkSourceIds, event\.clientX, event\.clientY\)/);
assert.match(finishKeyboardLinkSource, /linkPreview\.toggleAttribute\("hidden", true\)[\s\S]*?\.node\.link-target/);
assert.match(app, /function updateLinkPreview\(sourceIds, screenX, screenY\)[\s\S]*?sourceIds\.flatMap/);
assert.match(app, /currentMode\?\.type === "link"[\s\S]*?isBlankCanvasTarget\(hit\)[\s\S]*?createNode\(point\.x, point\.y, event\.pointerType === "pen", currentMode\.sourceIds\)/);
assert.match(app, /function isBlankCanvasTarget\(element\) \{\s*return element\?\.id === "gesture-surface";/);
assert.match(app, /function createNode\(centerX, centerY, fromPen = false, sourceIds = \[\]\)[\s\S]*?centerX - DEFAULT_NODE_WIDTH \/ 2[\s\S]*?toggleConnectionsToTarget\(board\.edges, sourceIds, node\.id\)[\s\S]*?softlyRevealNode\(node\.id\)/);
assert.match(app, /function beginWorkspaceAction\(\)[\s\S]*?\["node", "resize", "pan", "pinch"\]\.includes\(mode\?\.type\)[\s\S]*?boardDirty = true[\s\S]*?cancelGesture\(\);/);
assert.match(app, /function endWorkspaceAction\(\)[\s\S]*?disabled = false/);
assert.match(app, /\["beforeinput", "click", "dblclick", "pointerdown", "pointermove", "pointerup", "wheel", "paste", "keydown"\][\s\S]*?blockWorkspaceInteraction[\s\S]*?capture: true/);
assert.match(app, /function blockWorkspaceInteraction\(event\) \{[\s\S]*?workspaceActionPending[\s\S]*?preventDefault\(\)[\s\S]*?stopImmediatePropagation\(\)/);
assert.match(app, /async function removeCurrentBoard[\s\S]*?confirming-delete[\s\S]*?armDeleteBoard\(\)[\s\S]*?deleteDocument\(workspaceStorage, workspace\)/);
assert.match(app, /async function removeCurrentBoard[\s\S]*?clearSaveFailure\(\)[\s\S]*?markSaveFailure\(t\("errorDeleteBoard"\)\)/);
assert.match(app, /function scheduleSave\(\)[\s\S]*?boardDirty = true;/);
assert.match(app, /addEventListener\("pagehide"[\s\S]*?stagePendingSave\(\)[\s\S]*?saveBoardNow\(\)/);
assert.match(stagePendingSaveSource, /syncOpenInputs\(\);[\s\S]*?if \(!boardDirty\) return;[\s\S]*?stagePendingDocument\(workspaceStorage, workspace, board\)/);
assert.match(syncOpenInputsSource, /if \(changed\) boardDirty = true;[\s\S]*?return changed;/);
assert.match(saveBoardNowSource, /saveDocument[\s\S]*?clearPendingDocument\(workspaceStorage\)/);
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
assert.match(html, /id="board-picker"[\s\S]*?id="new-board-button"[\s\S]*?id="duplicate-board-button"[\s\S]*?id="restore-button"[\s\S]*?id="cancel-delete-board-button"[\s\S]*?id="delete-board-button"/);
assert.doesNotMatch(menuMarkup, /id="restore-button"/);
assert.match(html, /id="search-panel"[\s\S]*?id="search-input"[\s\S]*?id="search-previous"[\s\S]*?id="search-next"/);
assert.match(menuMarkup, /id="connection-style-button"[^>]*aria-pressed="false"[^>]*data-style="straight"/);
assert.match(html, /id="cancel-clear-button"[\s\S]*?aria-label="取消清空"/);
assert.match(html, /id="empty-state"[\s\S]*?Double-tap anywhere/);
assert.match(html, /<html lang="en">/);
assert.doesNotMatch(html, /user-scalable=no/);
assert.doesNotMatch(html, /id="world"[^>]*aria-live/);
assert.match(html, /id="announcer"[^>]*role="status"[^>]*aria-live="polite"/);
assert.match(html, /<svg class="app-logo"[\s\S]*?(app-logo-dot[\s\S]*?){6}<\/svg>/);
assert.doesNotMatch(html, /mark-dot/);
assert.match(html, /id="board-title"[\s\S]*?>Untitled</);
assert.match(html, /<title>Scattered<\/title>/);
assert.match(html, /src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js"/);
assert.match(html, /data-cf-beacon='\{"token": "41d9c0c044944ad6b1bd274d2f27d9b7"\}'/);
assert.doesNotMatch(html, /\[https:\/\/static\.cloudflareinsights\.com/);
assert.match(css, /\.app-logo\s*\{[^}]*width:\s*31px;[^}]*height:\s*24px;/s);
for (const selector of ["app-mark", "board-picker", "menu-button", "history-tools", "menu", "search-panel", "toast"]) {
  assert.match(css, new RegExp(`\\.${selector}\\s*\\{[^}]*position:\\s*absolute;`, "s"));
}
assert.match(css, /\.theme-button\s*\{[^}]*position:\s*fixed;[^}]*right:[^}]*bottom:/s);
assert.match(html, /id="edge-arrowhead"[^>]*?orient="auto-start-reverse"[\s\S]*?class="arrowhead"/);
assert.match(html, /id="color-selection"[\s\S]*?id="duplicate-selection"[\s\S]*?id="arrow-selection"[\s\S]*?id="disconnect-selection"/);
assert.match(selectionArrowMarkup, /M4 12h16[\s\S]*?M15 7l5 5-5 5/);
assert.doesNotMatch(selectionArrowMarkup, /data-direction|aria-pressed|arrow-head-reverse/);
assert.match(css, /#connections \.arrowhead\s*\{[^}]*fill:\s*var\(--thread\);[^}]*stroke:\s*none;/s);
assert.match(css, /\.menu\.choosing-export > :not\(\.export-choice\)/);
assert.match(css, /#viewport\.revealing-note[\s\S]*?background-position 180ms[\s\S]*?#viewport\.revealing-note #world[\s\S]*?transform 180ms/);
const revealNodeSource = app.match(/function softlyRevealNode\(id\)[\s\S]*?\n}\n\nfunction finishRevealMotion/)?.[0] || "";
assert.match(revealNodeSource, /board\.view\.x \+ node\.x \* scale[\s\S]*?board\.view\.y \+ node\.y \* scale/);
assert.doesNotMatch(revealNodeSource, /getBoundingClientRect/);
const driveApplySource = app.match(/function canApplyDriveWorkspace\(\)[\s\S]*?\n}/)?.[0] || "";
assert.doesNotMatch(driveApplySource, /boardPicker\.hidden/);
const boardPickerSource = app.match(/function setBoardPickerOpen\(open\)[\s\S]*?\n}/)?.[0] || "";
assert.match(boardPickerSource, /driveSync\.schedule\(0\)/);
assert.match(app, /bindAccount:\s*bindDriveAccount/);
assert.match(app, /if \(!driveSync\.connected && workspaceSlots\.accountKey\)[\s\S]*?switchToGuest\(\)[\s\S]*?initializeWorkspace\(\)/);
assert.match(app, /async function disconnectDriveAccount[\s\S]*?driveSync\.disconnect\(\)[\s\S]*?switchToGuest\(\)[\s\S]*?loadWorkspace\(workspaceStorage\)[\s\S]*?setBoardPickerOpen\(false\)/);
assert.match(app, /async function switchDriveAccount[\s\S]*?previousWasGuest[\s\S]*?mergeSyncWorkspaces\(guest, accountSnapshot, \[\]\)[\s\S]*?resetGuest\(\)/);
assert.match(app, /applyDriveWorkspace[\s\S]*?fitIncoming[\s\S]*?replaceBoard\(applied\.nextBoard, applied\.fitIncoming\)/);
assert.match(app, /addEventListener\("pageshow", \(event\) => restoreVisibleViewport/);
assert.match(app, /onConflict:[^\n]*showToast\([^\n]*4_800\)/);
assert.match(app, /visualViewport\?\.addEventListener\("scroll", handleVisualViewportChange\)/);
assert.match(app, /function syncVisualViewportChrome\(\)[\s\S]*?--visual-offset-top[\s\S]*?visual\?\.offsetTop/);
assert.match(app, /new URLSearchParams\(location\.search\)\.get\("viewport-debug"\) === "1"/);
assert.match(app, /function recordViewportDebug[\s\S]*?visualViewport[\s\S]*?--visual-offset-top[\s\S]*?getBoundingClientRect[\s\S]*?elementFromPoint/);
assert.match(app, /recordViewportDebug\(`\$\{reason\}:800`\)/);
assert.match(app, /function runDragAutoPan[\s\S]*?edgeAutoPanVelocity[\s\S]*?requestAnimationFrame\(runDragAutoPan\)/);
assert.match(app, /function moveDraggedNodes[\s\S]*?positionNode/);
const fitOpenedBoardSource = app.match(/function fitOpenedBoardIfOffscreen\([^)]*\)[\s\S]*?\n}/)?.[0] || "";
assert.match(fitOpenedBoardSource, /rectIntersectsViewport[\s\S]*?fittedView\(\)[\s\S]*?scheduleSave\(\)/);
assert.match(app, /function replaceBoard\(nextBoard, fitIncoming = false\)[\s\S]*?applyView\(\)[\s\S]*?fitOpenedBoardIfOffscreen\(fitIncoming\)/);
assert.match(css, /#viewport\.keyboard-linking \.node\.selected \.link-handle::after/);
assert.doesNotMatch(css, /@media print|@page/);
assert.match(app, /boardToMermaidMarkdown/);
assert.match(app, /createBoardSvg\(board, connectionStyle\)/);
assert.match(app, /localStorage\.setItem\(CONNECTION_STYLE_KEY, connectionStyle\)/);
assert.match(app, /navigator\.canShare/);
assert.match(app, /copySelectedGraph\(board, selectedIds\)/);
assert.match(app, /pasteSelectedGraph\(payload, origin\)/);
assert.match(app, /event\.key\.toLowerCase\(\) === "f"/);
assert.match(app, /event\.key\.toLowerCase\(\) === "d"/);
assert.match(app, /loadWorkspace\(workspaceStorage\)/);
assert.match(css, /\.board-picker\.confirming-delete[\s\S]*?#cancel-delete-board-button[\s\S]*?#delete-board-button/);
assert.match(css, /\.board-picker-tools button\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
assert.match(css, /\.drive-sync-button\[data-status="connected"\],[\s\S]*?data-status="syncing"[\s\S]*?data-status="synced"[\s\S]*?color:\s*var\(--thread\)/);
assert.doesNotMatch(css, /\.drive-sync-button\s*\{[^}]*color:\s*var\(--thread\)/s);
assert.doesNotMatch(css, /translate:\s*0 var\(--visual-offset-top/);
assert.equal((css.match(/top:\s*calc\([^;\n]*--visual-offset-top/g) || []).length, 8);
assert.match(css, /#viewport\.overview #connections \.edge-line[\s\S]*?stroke-width:\s*var\(--overview-edge-width/);
assert.match(css, /#viewport\.overview \.node::before[\s\S]*?min-width:/);
assert.match(css, /#viewport\.overview \.node::after[\s\S]*?data-overview-label[\s\S]*?font-size:/);
assert.match(css, /#viewport\.overview-compact \.node-actions/);
assert.match(app, /const overview = overviewLevel\(scale\)[\s\S]*?--overview-progress[\s\S]*?--overview-edge-width[\s\S]*?overview-compact/);
assert.match(app, /overview\.renderScale[\s\S]*?1\.15 \/ scale[\s\S]*?1\.85 \+ 0\.2 \* overview\.progress[\s\S]*?overview-distant/);
assert.match(app, /const markerSize = 12 \/ overview\.renderScale/);
assert.doesNotMatch(app, /--overview-marker-scale/);
assert.match(css, /#viewport\.overview-distant \.node[\s\S]*?will-change:\s*auto[\s\S]*?#viewport\.overview-distant \.node::after[\s\S]*?display:\s*none/);
assert.match(app, /function syncNodeContent[\s\S]*?dataset\.overviewLabel/);
assert.equal(messages.en.driveConflict, "冲突副本已保留 · Conflict copy saved");
assert.equal(messages["zh-Hans"].driveConflict, messages.en.driveConflict);
assert.doesNotMatch(app, /window\.print|beforeprint|preparePrintView|createBoardPdf|application\/pdf/);
const serviceWorker = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
assert.match(serviceWorker, /scattered-v52/);
assert.match(serviceWorker, /\.\/workspace\.js/);
assert.match(serviceWorker, /\.\/sync-model\.js/);
assert.match(serviceWorker, /\.\/drive-sync\.js/);
assert.match(serviceWorker, /origin !== self\.location\.origin/);
assert.match(serviceWorker, /\.\/svg-export\.js/);
assert.match(serviceWorker, /\.\/i18n\.js/);
assert.doesNotMatch(serviceWorker, /pdf-export|pdf-lib|fontkit|NotoSansSC/);
const syncConfig = readFileSync(new URL("./sync-config.js", import.meta.url), "utf8");
assert.match(syncConfig, /https:\/\/scattered\.pages\.dev/);
assert.match(syncConfig, /https:\/\/scattered-sync\.kyd405836552\.workers\.dev/);
assert.doesNotMatch(syncConfig, /kydchen\.github\.io/);
assert.equal(existsSync(new URL("./pdf-export.js", import.meta.url)), false);
assert.equal(existsSync(new URL("./vendor", import.meta.url)), false);
assert.equal(existsSync(new URL("./fonts", import.meta.url)), false);
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
assert.equal(manifest.name, "Scattered");
assert.equal(manifest.lang, "en");
assert.match(manifest.description, /local-first[\s\S]*Pencil, touch, and mouse/);
assert.match(html, /property="og:image" content="https:\/\/kydchen\.github\.io\/scattered\/docs\/scattered-canvas\.png"/);
assert.match(html, /name="twitter:card" content="summary_large_image"/);
assert.match(html, /rel="canonical" href="https:\/\/kydchen\.github\.io\/scattered\/"/);
assert.match(app, /const THEME_KEY = "scattered-theme"/);
assert.match(app, /function toggleTheme[\s\S]*?localStorage\.setItem\(THEME_KEY, next\)/);
assert.match(app, /async function replaceCurrentBoard[\s\S]*?replaceDocument[\s\S]*?checkpoint\(\)/);
assert.match(app, /async function clearBoard[\s\S]*?confirming-clear[\s\S]*?\.\.\.blankBoard\(\), title: board\.title[\s\S]*?replaceCurrentBoard\(cleared, "clear"\)/);
assert.match(css, /html\[data-theme="dark"\]\s*\{[^}]*--canvas:\s*#16150f;[^}]*--paper:\s*#211f18;[^}]*--ink:\s*#eae4d6;/s);
assert.match(css, /html\[data-theme="dark"\][\s\S]*?--note-yellow:\s*#3a321b;[\s\S]*?--note-mint:\s*#193129;[\s\S]*?--note-blue:\s*#1b2c43;[\s\S]*?--note-rose:\s*#3a222a;/);
assert.match(css, /#connections \.edge\s*\{[^}]*outline:\s*none;[^}]*-webkit-tap-highlight-color:\s*transparent;/s);

const syncStorage = new MemoryStorage();
const syncLocal = loadWorkspace(syncStorage, () => time++);
const syncOriginalId = syncLocal.workspace.activeId;
saveDocument(syncStorage, syncLocal.workspace, {
  ...syncLocal.board,
  title: "Local",
  nodes: [{ id: "local-note", text: "before", x: 0, y: 0 }],
  view: { x: 17, y: 23, scale: 1.2 },
}, () => time++);
createDocument(syncStorage, syncLocal.workspace, { ...blankBoard(), title: "Removed" }, () => time++);
deleteDocument(syncStorage, syncLocal.workspace, () => time++);
const syncExport = createSyncWorkspace(syncStorage, syncLocal.workspace);
assert.equal(syncExport.format, "scattered-sync-workspace");
assert.equal(syncExport.boards[0].id, syncOriginalId);
assert.equal(syncExport.tombstones.length, 1);
assert.deepEqual(parseSyncWorkspace(JSON.stringify(syncExport)), syncExport);
assert.throws(() => parseSyncWorkspace({ ...syncExport, activeId: "missing" }), /sync\.invalidWorkspace/);
assert.throws(() => parseSyncWorkspace({
  ...syncExport,
  activeId: "../bad",
  boards: syncExport.boards.map((item) => ({ ...item, id: "../bad" })),
}), /sync\.invalidWorkspace/);

const incomingSync = structuredClone(syncExport);
incomingSync.boards[0].board.nodes[0].text = "from Drive";
incomingSync.boards[0].board.view = { x: 999, y: 999, scale: 0.5 };
incomingSync.boards[0].revision = "remote-revision";
incomingSync.boards[0].updatedAt += 100;
applySyncWorkspace(syncStorage, syncLocal.workspace, incomingSync, () => time++);
assert.equal(storedBoard(syncStorage, syncOriginalId).nodes[0].text, "from Drive");
assert.deepEqual(storedBoard(syncStorage, syncOriginalId).view, { x: 17, y: 23, scale: 1.2 });
assert.equal(syncLocal.workspace.activeId, syncOriginalId);

const remoteDeleteStorage = new MemoryStorage();
const remoteDeleteLocal = loadWorkspace(remoteDeleteStorage, () => time++);
const keptRemoteId = remoteDeleteLocal.workspace.activeId;
createDocument(remoteDeleteStorage, remoteDeleteLocal.workspace, {
  ...blankBoard(),
  title: "Deleted elsewhere",
  nodes: [{ id: "remote-delete-note", text: "recoverable", x: 0, y: 0 }],
}, () => time++);
const removedRemoteId = remoteDeleteLocal.workspace.activeId;
const remoteDeleteSnapshot = createSyncWorkspace(remoteDeleteStorage, remoteDeleteLocal.workspace);
remoteDeleteSnapshot.boards = remoteDeleteSnapshot.boards.filter((item) => item.id !== removedRemoteId);
remoteDeleteSnapshot.activeId = keptRemoteId;
remoteDeleteSnapshot.tombstones.push({ id: removedRemoteId, deletedAt: time++ });
applySyncWorkspace(remoteDeleteStorage, remoteDeleteLocal.workspace, remoteDeleteSnapshot, () => time++);
assert.equal(hasRecovery(remoteDeleteStorage), true);
assert.equal(recoveryEntries(remoteDeleteStorage)[0].board.nodes[0].text, "recoverable");
assert.equal(remoteDeleteStorage.getItem(`scattered-document-v2:${removedRemoteId}`), null);

const disposableSyncStorage = new MemoryStorage();
const disposableSyncLocal = loadWorkspace(disposableSyncStorage, () => time++);
const remoteFirstWorkspace = {
  format: "scattered-sync-workspace",
  version: 1,
  activeId: "remote-board",
  boards: [{
    id: "remote-board",
    revision: "remote-revision",
    updatedAt: time++,
    board: normalizeBoard({ ...blankBoard(), title: "From another device" }),
  }],
  tombstones: [],
};
applySyncWorkspace(disposableSyncStorage, disposableSyncLocal.workspace, remoteFirstWorkspace, () => time++);
assert.equal(disposableSyncLocal.workspace.activeId, "remote-board");
assert.equal(hasRecovery(disposableSyncStorage), false);

const failedSyncStorage = new FailingStorage([...syncStorage.values.entries()]);
const failedSyncLocal = loadWorkspace(failedSyncStorage, () => time++);
const failedSyncDocumentBefore = failedSyncStorage.getItem(`scattered-document-v2:${syncOriginalId}`);
const failedSyncWorkspaceBefore = failedSyncStorage.getItem("scattered-workspace-v2");
failedSyncStorage.failWorkspace = true;
assert.throws(() => applySyncWorkspace(
  failedSyncStorage,
  failedSyncLocal.workspace,
  { ...incomingSync, boards: incomingSync.boards.map((item) => ({
    ...item,
    revision: "another-remote-revision",
    board: { ...item.board, title: "Must roll back" },
  })) },
  () => time++,
), /quota/);
assert.equal(failedSyncStorage.getItem(`scattered-document-v2:${syncOriginalId}`), failedSyncDocumentBefore);
assert.equal(failedSyncStorage.getItem("scattered-workspace-v2"), failedSyncWorkspaceBefore);

function syncBoard(id, title, text, updatedAt = 1, viewX = 0) {
  return {
    id,
    revision: `${id}-${text}`,
    updatedAt,
    board: normalizeBoard({
      title,
      nodes: text ? [{ id: `${id}-note`, text, x: 0, y: 0 }] : [],
      edges: [],
      view: { x: viewX, y: 0, scale: 1 },
    }),
  };
}

function syncWorkspace(boards, tombstones = [], activeId = boards[0].id) {
  return { format: "scattered-sync-workspace", version: 1, activeId, boards, tombstones };
}

const syncBase = syncWorkspace([syncBoard("a", "A", "base-a"), syncBoard("b", "B", "base-b")]);
const syncBaseIndex = await indexSyncWorkspace(syncBase);
const syncLeft = syncWorkspace([syncBoard("a", "A", "left-a", 2), syncBoard("b", "B", "base-b")]);
const syncRight = syncWorkspace([syncBoard("a", "A", "base-a"), syncBoard("b", "B", "right-b", 3)]);
const independentMerge = await mergeSyncWorkspaces(syncLeft, syncRight, syncBaseIndex);
assert.equal(independentMerge.conflicts, 0);
assert.equal(independentMerge.workspace.boards.find((item) => item.id === "a").board.nodes[0].text, "left-a");
assert.equal(independentMerge.workspace.boards.find((item) => item.id === "b").board.nodes[0].text, "right-b");

const sameBoardRight = syncWorkspace([syncBoard("a", "A", "right-a", 3), syncBoard("b", "B", "base-b")]);
const conflictingMerge = await mergeSyncWorkspaces(syncLeft, sameBoardRight, syncBaseIndex);
assert.equal(conflictingMerge.conflicts, 1);
assert.equal(conflictingMerge.workspace.boards.length, 3);
assert.ok(conflictingMerge.workspace.boards.some((item) => item.board.title === "A · 2"));
assert.deepEqual(
  new Set(conflictingMerge.workspace.boards.filter((item) => item.board.title.startsWith("A")).map((item) => item.board.nodes[0].text)),
  new Set(["left-a", "right-a"]),
);

const deletedLeft = syncWorkspace([syncBoard("b", "B", "base-b")], [{ id: "a", deletedAt: 9 }], "b");
const deleteEditMerge = await mergeSyncWorkspaces(deletedLeft, sameBoardRight, syncBaseIndex);
assert.equal(deleteEditMerge.conflicts, 1);
assert.ok(deleteEditMerge.workspace.tombstones.some((item) => item.id === "a"));
assert.ok(deleteEditMerge.workspace.boards.some((item) => item.board.nodes[0]?.text === "right-a"));

const viewOnlyLeft = syncWorkspace([syncBoard("a", "A", "base-a", 1, 10)]);
const viewOnlyRight = syncWorkspace([syncBoard("a", "A", "base-a", 1, 999)]);
assert.equal(await fingerprintSyncWorkspace(viewOnlyLeft), await fingerprintSyncWorkspace(viewOnlyRight));

const baseCloud = await createCloudSnapshot(syncBase, { deviceId: "one", createdAt: 1 });
const leftCloud = await createCloudSnapshot(syncLeft, { deviceId: "one", parents: [baseCloud], createdAt: 2 });
const rightCloud = await createCloudSnapshot(syncRight, { deviceId: "two", parents: [baseCloud], createdAt: 3 });
assert.deepEqual(findCommonBaseIndex(leftCloud, rightCloud), syncBaseIndex);
assert.deepEqual(new Set(cloudSnapshotHeads([baseCloud, leftCloud, rightCloud]).map((item) => item.snapshotId)), new Set([leftCloud.snapshotId, rightCloud.snapshotId]));
const joinedCloud = await createCloudSnapshot(independentMerge.workspace, { deviceId: "one", parents: [leftCloud, rightCloud], createdAt: 4 });
assert.deepEqual(cloudSnapshotHeads([baseCloud, leftCloud, rightCloud, joinedCloud]).map((item) => item.snapshotId), [joinedCloud.snapshotId]);

const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const readmeZh = readFileSync(new URL("./README.zh-CN.md", import.meta.url), "utf8");
const contributing = readFileSync(new URL("./CONTRIBUTING.md", import.meta.url), "utf8");
const license = readFileSync(new URL("./LICENSE", import.meta.url), "utf8");
assert.match(readme, /\[简体中文\]\(README\.zh-CN\.md\)/);
assert.match(readmeZh, /\[English\]\(README\.md\)/);
assert.match(readme, /docs\/scattered-canvas\.png/);
assert.match(readmeZh, /作为网页 App 打开/);
assert.match(readme, /Install page as app/);
assert.match(readme, /JSON[\s\S]*SVG[\s\S]*Mermaid/);
assert.match(readme, /local-first[\s\S]*local recovery copy[\s\S]*CONTRIBUTING\.md/);
assert.match(readmeZh, /Apple Pencil \+ 触控[\s\S]*纯触控[\s\S]*键盘 \+ 鼠标/);
assert.match(readmeZh, /本地优先[\s\S]*本地恢复副本[\s\S]*CONTRIBUTING\.md/);
assert.match(contributing, /Pencil \+ touch[\s\S]*touch only[\s\S]*keyboard \+ mouse/);
assert.match(contributing, /npm test[\s\S]*sw\.js/);
assert.match(license, /^MIT License[\s\S]*Copyright \(c\) 2026 kydchen/);
assert.equal(existsSync(new URL("./docs/scattered-canvas.png", import.meta.url)), true);

console.log("model checks passed");
