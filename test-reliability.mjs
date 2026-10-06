import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test, after } from "node:test";
import * as workspaceModel from "./workspace.js";
import { BOARD_VERSION, IMPORT_VERSIONS, blankBoard, normalizeBoard } from "./model.js";
import { encodeSharedBoard } from "./share-model.js";
import { createDriveSync } from "./drive-sync.js";
import { createCloudSnapshot, fingerprintSyncWorkspace } from "./sync-model.js";

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const { loadWorkspace, saveDocument, stagePendingDocument, createDocument, deleteDocument } = workspaceModel;
const fixture = () => ({ ...blankBoard(), title: "Shared", nodes: [{ id: "n", text: "Original", x: 200, y: 200, width: 218 }] });

// A real quota measures total usage, including replacement writes and rollback.
class QuotaStorage extends MemoryStorage {
  limit = Infinity;
  fault = null;
  attempts = 0;
  get usage() { return [...this.values].reduce((n, [k, v]) => n + k.length + v.length, 0); }
  setItem(key, value) {
    this.attempts++;
    if (this.fault?.(key, value)) throw new DOMException("Denied", "SecurityError");
    const previous = this.values.has(key) ? key.length + this.values.get(key).length : 0;
    if (this.usage - previous + key.length + String(value).length > this.limit) {
      throw new DOMException("Full", "QuotaExceededError");
    }
    super.setItem(key, value);
  }
}
const recoveryKey = "scattered-recovery-v2";
const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
let lockQueue = Promise.resolve();
Object.defineProperty(navigator, "locks", { configurable: true, value: {
  request(_name, action) {
    const result = lockQueue.then(() => action());
    lockQueue = result.catch(() => {});
    return result;
  },
} });
after(() => {
  if (locksDescriptor) Object.defineProperty(navigator, "locks", locksDescriptor);
  else delete navigator.locks;
});
const locked = (s, action) => workspaceModel.withWorkspaceLock((safe = s) => action(safe), s);

const pendingEntries = s => [...s.values].filter(([key]) => key.startsWith("scattered-pending"));
function largePendingFixture(s) {
  const loaded = loadWorkspace(s);
  const board = saveDocument(s, loaded.workspace, normalizeBoard({
    ...fixture(),
    nodes: Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, text: `Note ${i} ${"text ".repeat(160)}`, x: i * 20, y: i * 40 })),
    edges: [{ id: "e", from: "n0", to: "n1", arrow: "forward", label: "link" }],
  }));
  return { ...loaded, board: saveDocument(s, loaded.workspace, { ...board, view: { ...board.view, x: 1 } }) };
}

test("pending delta: a small edit fits when a full journal cannot; recovery is exact", async () => {
  const s = new QuotaStorage(), { workspace, board } = largePendingFixture(s);
  const candidate = structuredClone(board);
  candidate.nodes[0].text += " last words";
  candidate.nodes[0].color = "rose";
  candidate.title = "Renamed";
  candidate.view = { x: 32, y: -45, scale: 0.5 };
  s.limit = s.usage + 8_000;
  assert.throws(() => stagePendingDocument(s, workspace, candidate), { name: "QuotaExceededError" });
  await locked(s, safe => stagePendingDocument(safe, workspace, candidate, Date.now, { baseBoard: board }));
  const [[key, encoded]] = pendingEntries(s);
  assert.ok(key.startsWith("scattered-pending-delta-v1:"), "Old clients must not delete a newer journal format");
  assert.ok(encoded.length < JSON.stringify(board).length / 10);
  const reloaded = await locked(s, safe => loadWorkspace(safe));
  assert.deepEqual(reloaded.board, normalizeBoard(candidate));
  assert.equal(reloaded.workspace.boards.length, 1);
  assert.equal(pendingEntries(s).length, 0);
});

test("pending delta: changed baseline becomes a copy with endpoint context, not an overwrite", () => {
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  const originalId = workspace.activeId;
  const candidate = structuredClone(board);
  candidate.nodes[0].text = "Pending words";
  candidate.nodes = candidate.nodes.filter(n => n.id !== "n2");
  candidate.edges[0].label = "Pending label";
  stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
  const peer = normalizeBoard({ ...board, title: "Peer title", nodes: board.nodes.filter(n => n.id !== "n1").map(n => n.id === "n3" ? { ...n, text: "Peer words" } : n) });
  saveDocument(s, workspace, peer);
  // Remove the original baseline from the one-generation backup as well.
  saveDocument(s, workspace, { ...peer, view: { ...peer.view, x: 500 } });
  const reloaded = loadWorkspace(s);
  assert.equal(reloaded.workspace.boards.length, 2);
  assert.notEqual(reloaded.workspace.activeId, originalId);
  assert.equal(reloaded.board.nodes.find(n => n.id === "n0").text, "Pending words");
  assert.equal(reloaded.board.nodes.find(n => n.id === "n1").text, board.nodes[1].text);
  assert.equal(reloaded.board.nodes.find(n => n.id === "n3").text, "Peer words");
  assert.ok(!reloaded.board.nodes.some(n => n.id === "n2"));
  assert.equal(reloaded.board.edges[0].label, "Pending label");
  const storedOriginal = workspaceModel.createSyncWorkspace(s, reloaded.workspace).boards.find(b => b.id === originalId).board;
  assert.deepEqual(storedOriginal.nodes, peer.nodes);
});

test("pending delta: deleted source recovers edits and incident edges without resurrecting it", () => {
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  const sourceId = workspace.activeId;
  const candidate = structuredClone(board); candidate.nodes[0].text = "Last words";
  stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
  deleteDocument(s, workspace);
  const reloaded = loadWorkspace(s);
  assert.notEqual(reloaded.workspace.activeId, sourceId);
  assert.ok(reloaded.workspace.tombstones.some(t => t.id === sourceId));
  assert.equal(reloaded.board.nodes.find(n => n.id === "n0").text, "Last words");
  assert.ok(reloaded.board.nodes.some(n => n.id === "n1"));
  assert.equal(reloaded.board.edges[0].id, "e");
});

test("pending recovery: undeletable journal cannot duplicate after editing, sync, or deleting its copy", () => {
  for (const action of ["edit", "sync", "delete"]) {
    const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
    const candidate = structuredClone(board); candidate.nodes[0].text = "Pending";
    stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
    saveDocument(s, workspace, { ...board, title: "Peer" });
    const remove = s.removeItem.bind(s), set = s.setItem.bind(s);
    s.removeItem = key => { if (key.startsWith("scattered-pending")) throw Error("Cannot remove journal"); remove(key); };
    s.setItem = (key, value) => { if (key.startsWith("scattered-pending")) throw Error("Cannot replace journal"); set(key, value); };
    const recovered = loadWorkspace(s);
    assert.equal(recovered.workspace.boards.length, 2);
    saveDocument(s, recovered.workspace, { ...recovered.board, title: "Edited recovered copy" });
    if (action === "sync") workspaceModel.applySyncWorkspace(s, recovered.workspace, workspaceModel.createSyncWorkspace(s, recovered.workspace));
    if (action === "delete") deleteDocument(s, recovered.workspace);
    const count = recovered.workspace.boards.length;
    for (let n = 0; n < 3; n++) assert.equal(loadWorkspace(s).workspace.boards.length, count, action);
    s.removeItem = remove; s.setItem = set;
    assert.equal(loadWorkspace(s).workspace.boards.length, count);
    assert.equal(pendingEntries(s).length, 0);
  }
});

test("pending delta: order, additions and edge removals round-trip; failed replay retains journal", () => {
  const s = new QuotaStorage(), { workspace, board } = largePendingFixture(s);
  const candidate = structuredClone(board);
  candidate.nodes.reverse();
  candidate.nodes.splice(3, 1);
  candidate.nodes.splice(2, 0, { ...board.nodes[0], id: "new", text: "New" });
  candidate.edges = [];
  stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
  const encoded = pendingEntries(s)[0][1];
  s.fault = key => key.startsWith("scattered-document");
  assert.deepEqual(loadWorkspace(s).board, board);
  assert.equal(pendingEntries(s)[0][1], encoded);
  s.fault = null;
  assert.deepEqual(loadWorkspace(s).board, candidate);
});

test("pending delta: view-only replay never creates a content conflict or resurrects a deleted source", () => {
  for (const deleted of [false, true]) {
    const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
    stagePendingDocument(s, workspace, { ...board, view: { x: 25, y: 30, scale: 0.4 } }, Date.now, { baseBoard: board, viewOnly: true });
    if (deleted) deleteDocument(s, workspace);
    else saveDocument(s, workspace, { ...board, title: "Peer title" });
    const loaded = loadWorkspace(s);
    assert.equal(loaded.workspace.boards.length, 1);
    assert.equal(loaded.board.title, deleted ? "Untitled" : "Peer title");
    assert.equal(pendingEntries(s).length, 0);
  }
});

test("pending delta: whole-board changes fall back to a complete snapshot in the new namespace", () => {
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  const candidate = normalizeBoard({ ...board, nodes: board.nodes.map(n => ({ ...n, text: "Entirely new" })) });
  stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
  const pending = JSON.parse(pendingEntries(s)[0][1]);
  assert.ok(pending.board); assert.equal(pending.delta, undefined);
  assert.deepEqual(loadWorkspace(s).board, candidate);
  stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
  const [key, encoded] = pendingEntries(s)[0], malformed = JSON.parse(encoded);
  malformed.board.nodes[0].id = null;
  s.setItem(key, JSON.stringify(malformed));
  assert.ok(loadWorkspace(s).pendingError, "A corrupt full fallback must not silently drop a card either");
  assert.equal(pendingEntries(s).length, 1);
});

test("pending recovery: document marker covers a crash before the workspace receipt; receipts are bounded", () => {
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  const candidate = structuredClone(board); candidate.nodes[0].text = "Pending";
  const id = stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
  const [key, encoded] = pendingEntries(s)[0];
  const loaded = loadWorkspace(s);
  // Simulate the durable primary document but old workspace metadata at death.
  s.setItem(key, encoded);
  for (const k of ["scattered-workspace-v2", "scattered-workspace-backup-v2"]) {
    const value = JSON.parse(s.getItem(k)); delete value.appliedPending; s.setItem(k, JSON.stringify(value));
  }
  assert.equal(JSON.parse(s.getItem(`scattered-document-v2:${workspace.activeId}`))._scattered.pendingId, id);
  const recovered = loadWorkspace(s);
  assert.equal(recovered.workspace.boards.length, 1);
  assert.deepEqual(recovered.board, loaded.board);
  saveDocument(s, recovered.workspace, { ...recovered.board, title: "After recovery" });
  assert.ok(!JSON.parse(s.getItem("scattered-workspace-v2")).appliedPending?.length);
});

test("pending recovery: a conflict document written before the index is reattached, not duplicated", () => {
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  const changed = structuredClone(board); changed.nodes[0].text = "Pending words";
  stagePendingDocument(s, workspace, changed, Date.now, { baseBoard: board });
  saveDocument(s, workspace, { ...board, title: "Peer title" });
  const index = s.getItem("scattered-workspace-v2"), [key, encoded] = pendingEntries(s)[0];
  const first = loadWorkspace(s), copyId = first.workspace.activeId;
  s.setItem(key, encoded);
  s.setItem("scattered-workspace-v2", index);
  s.setItem("scattered-workspace-backup-v2", index);
  const next = loadWorkspace(s);
  assert.equal(next.workspace.activeId, copyId);
  assert.equal(next.workspace.boards.length, 2);
  assert.equal([...s.values.keys()].filter(k => k.startsWith("scattered-document-v2:")).length, 2);
  assert.equal(next.board.nodes[0].text, "Pending words");
});

test("pending recovery: failed receipt/index repair keeps the durable canvas visible and survives later saves", () => {
  for (const conflict of [false, true]) {
    const s = new QuotaStorage(), { workspace, board } = largePendingFixture(s);
    const changed = structuredClone(board); changed.nodes[0].text = "Durable pending words";
    stagePendingDocument(s, workspace, changed, Date.now, { baseBoard: board });
    if (conflict) saveDocument(s, workspace, { ...board, title: "Peer" });
    const index = s.getItem("scattered-workspace-v2"), [key, encoded] = pendingEntries(s)[0];
    const recovered = loadWorkspace(s);
    s.setItem(key, encoded); s.setItem("scattered-workspace-v2", index); s.setItem("scattered-workspace-backup-v2", index);
    s.fault = k => k.startsWith("scattered-workspace");
    const loaded = loadWorkspace(s);
    assert.ok(loaded.pendingError);
    assert.deepEqual(loaded.board, recovered.board);
    assert.equal(s.getItem(key), encoded);
    s.fault = null;
    saveDocument(s, loaded.workspace, { ...loaded.board, title: "New edits after failed repair" });
    assert.equal(loadWorkspace(s).workspace.boards.length, conflict ? 2 : 1);
    assert.equal(pendingEntries(s).length, 0);
  }
});

test("pending recovery: corrupt or future deltas are retained, reported and exportable without credentials", () => {
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  const candidate = structuredClone(board); candidate.nodes[0].text = "Pending";
  stagePendingDocument(s, workspace, candidate, Date.now, { baseBoard: board });
  const [key, encoded] = pendingEntries(s)[0];
  s.setItem("google-secret", "must not export");
  createDocument(s, workspace, { ...blankBoard(), title: "Unrelated private canvas" });
  workspaceModel.switchDocument(s, workspace, JSON.parse(encoded).boardId);
  for (const mutate of [
    p => { p.storageVersion = 999; },
    p => { p.delta.nodes.put[0].width = "invalid"; },
    p => { p.delta.nodes.remove.push(p.delta.contextNodes[0].id); },
    p => { p.delta.edges.put.push({ id: "dangling", from: "unknown", to: "n0" }); },
  ]) {
    const pending = JSON.parse(encoded); mutate(pending); const raw = JSON.stringify(pending); s.setItem(key, raw);
    const loaded = loadWorkspace(s);
    assert.ok(loaded.pendingError);
    assert.deepEqual(loaded.board, board);
    assert.equal(s.getItem(key), raw);
    const backup = workspaceModel.pendingRecoveryBackup(s);
    assert.equal(backup.pending.find(p => p.key === key).encoded, raw);
    assert.ok(!JSON.stringify(backup).includes("must not export"));
    assert.ok(!JSON.stringify(backup).includes("Unrelated private canvas"));
  }
});

test("pending recovery: supported old delta and full snapshots migrate without losing edits", () => {
  for (const full of [false, true]) {
    const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
    const changed = structuredClone(board); changed.nodes[0].text = "旧版末尾输入";
    stagePendingDocument(s, workspace, changed, Date.now, { baseBoard: full ? blankBoard() : board });
    const [key, raw] = pendingEntries(s)[0], pending = JSON.parse(raw);
    assert.equal(Boolean(pending.board), full);
    const payload = pending.delta || pending.board;
    payload.version = 3;
    const edges = full ? payload.edges : [...payload.edges.put, ...payload.contextEdges];
    edges.forEach(edge => { if (edge.arrow === "forward") edge.arrow = true; });
    s.setItem(key, JSON.stringify(pending));
    const loaded = loadWorkspace(s);
    assert.equal(loaded.pendingError, null);
    assert.deepEqual(loaded.board, changed);
    assert.equal(pendingEntries(s).length, 0);
  }
});

test("pending recovery: every supported board version has frozen full and delta replay fixtures", () => {
  // Do not regenerate old payloads with the current writer/normalizer. Their
  // historic bytes and independently expected result guard future migrations.
  const fixture = JSON.parse(readFileSync(new URL("./test-fixtures/pending-versions.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(fixture.versions).map(Number).sort(), [...IMPORT_VERSIONS].sort(), "Add a frozen pending fixture for every supported version");
  assert.equal(fixture.expected.version, BOARD_VERSION, "Review the expected migrated result when the board format changes");
  for (const version of IMPORT_VERSIONS) {
    for (const kind of ["board", "delta"]) {
      const s = new MemoryStorage(), { workspace } = loadWorkspace(s);
      saveDocument(s, workspace, fixture.base);
      const sessionId = `fixture-v${version}-${kind}`;
      const payload = fixture.versions[version][kind];
      assert.equal(payload.version, version);
      s.setItem(`scattered-pending-delta-v1:${sessionId}`, JSON.stringify({
        format: "scattered-pending-document", storageVersion: 2, id: sessionId, sessionId,
        boardId: workspace.activeId, expectedRevision: workspace.boards.find(b => b.id === workspace.activeId).revision,
        viewOnly: false, savedAt: 1000, [kind]: payload,
      }));
      const loaded = loadWorkspace(s);
      assert.equal(loaded.pendingError, null, `v${version} ${kind}`);
      assert.deepEqual(loaded.board, fixture.expected, `v${version} ${kind}`);
      assert.equal(pendingEntries(s).length, 0);
      assert.equal(loadWorkspace(s).workspace.boards.length, 1, "A second startup must not repeat recovery");
    }
  }
});

test("pending recovery: exported corrupt bytes can be quarantined, never future or replayable data", () => {
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  stagePendingDocument(s, workspace, { ...board, title: "Future words" }, Date.now, { baseBoard: board });
  const [key, raw] = pendingEntries(s)[0], pending = JSON.parse(raw);
  pending.delta.version = board.version + 1;
  s.setItem(key, JSON.stringify(pending));
  const brokenKey = "scattered-pending-delta-v1:broken", broken = '{"unfinished":';
  s.setItem(brokenKey, broken);
  let error = loadWorkspace(s).pendingError;
  assert.equal(error.message, "pending.newer");
  error = workspaceModel.quarantinePendingRecovery(s, workspaceModel.pendingRecoveryBackup(s), error);
  assert.equal(error.message, "pending.newer");
  assert.equal(s.getItem(key), JSON.stringify(pending));
  assert.equal(s.getItem(brokenKey), null);
  assert.ok(workspaceModel.pendingRecoveryBackup(s).quarantined.some(entry => entry.encoded === broken));
  s.setItem(key, raw);
  assert.equal(loadWorkspace(s).pendingError, null);
  assert.equal(loadWorkspace(s).board.title, "Future words");
});

test("pending recovery: quarantine requires the exported bytes and durable copy before removal", () => {
  const s = new QuotaStorage(); loadWorkspace(s);
  const key = "scattered-pending-delta-v1:broken", raw = "broken original";
  s.setItem(key, raw);
  const error = loadWorkspace(s).pendingError, exported = workspaceModel.pendingRecoveryBackup(s);
  s.setItem(key, "new pending bytes");
  assert.ok(workspaceModel.quarantinePendingRecovery(s, exported, error));
  assert.equal(s.getItem(key), "new pending bytes");
  s.setItem(key, raw); s.limit = s.usage;
  assert.throws(() => workspaceModel.quarantinePendingRecovery(s, exported, error), { name: "QuotaExceededError" });
  assert.equal(s.getItem(key), raw);
  s.limit = Infinity;
  assert.equal(workspaceModel.quarantinePendingRecovery(s, exported, error), null);
  assert.equal(s.getItem(key), null);
  assert.equal(loadWorkspace(s).pendingError, null);
  assert.ok(workspaceModel.pendingRecoveryBackup(s).quarantined.some(entry => entry.encoded === raw));
});

test("pending recovery: failed replay remains pending even after an export", () => {
  const s = new QuotaStorage(), { workspace, board } = largePendingFixture(s);
  stagePendingDocument(s, workspace, { ...board, title: "Unsaved words" }, Date.now, { baseBoard: board });
  s.fault = key => key.startsWith("scattered-document");
  const error = loadWorkspace(s).pendingError;
  assert.equal(error.message, "pending.retry");
  assert.ok(workspaceModel.quarantinePendingRecovery(s, workspaceModel.pendingRecoveryBackup(s), error));
  assert.equal(pendingEntries(s).length, 1);
  s.fault = null;
  assert.equal(loadWorkspace(s).board.title, "Unsaved words");
});

test("pending recovery: current save failure takes priority and cannot trigger recovery export", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("function refreshPersistentToast()"), app.indexOf("\nfunction announce("));
  const attrs = new Map();
  const toast = { hidden: true, dataset: {}, setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); } };
  const context = vm.createContext({ toast, pendingRecoveryError: new Error("pending.invalid"), recoveryNoticeId: "", saveFailureMessage: "", toastTimer: 0,
    t: key => key, announce() {}, clearTimeout() {}, setTimeout() {} });
  vm.runInContext(source, context);
  vm.runInContext('markSaveFailure("Current changes are not saved")', context);
  assert.equal(toast.textContent, "Current changes are not saved");
  assert.equal(toast.dataset.dismissible, "false");
  assert.ok(!attrs.has("role"));
  vm.runInContext("clearSaveFailure()", context);
  assert.equal(toast.textContent, "pendingRecoveryFailed");
  assert.equal(toast.dataset.dismissible, "true");
});

test("pending recovery: interrupted quarantine removal reuses its copy without overwriting earlier bytes", () => {
  const s = new MemoryStorage(); loadWorkspace(s);
  const key = "scattered-pending-delta-v1:broken";
  s.setItem(key, "first corrupt bytes");
  const error = loadWorkspace(s).pendingError, backup = workspaceModel.pendingRecoveryBackup(s);
  const remove = s.removeItem.bind(s);
  s.removeItem = () => { throw new DOMException("Denied", "SecurityError"); };
  for (let i = 0; i < 3; i++) assert.throws(() => workspaceModel.quarantinePendingRecovery(s, backup, error));
  assert.equal(s.getItem(key), "first corrupt bytes");
  assert.equal(workspaceModel.pendingRecoveryBackup(s).quarantined.length, 1);
  s.removeItem = remove;
  assert.equal(workspaceModel.quarantinePendingRecovery(s, backup, error), null);
  s.setItem(key, "second corrupt bytes");
  const next = loadWorkspace(s).pendingError;
  assert.equal(workspaceModel.quarantinePendingRecovery(s, workspaceModel.pendingRecoveryBackup(s), next), null);
  assert.deepEqual(workspaceModel.pendingRecoveryBackup(s).quarantined.map(e => e.encoded).sort(), ["first corrupt bytes", "second corrupt bytes"]);
});

test("pending recovery: quarantine stays account-scoped and survives claiming the guest workspace", () => {
  const s = new MemoryStorage(), slots = workspaceModel.createWorkspaceSlots(s);
  slots.switchToGuest(); loadWorkspace(slots.storage);
  slots.storage.setItem("scattered-pending-delta-v1:broken", "Private guest bytes");
  const error = loadWorkspace(slots.storage).pendingError;
  assert.equal(workspaceModel.quarantinePendingRecovery(slots.storage, workspaceModel.pendingRecoveryBackup(slots.storage), error), null);
  slots.resetGuest();
  assert.equal(workspaceModel.pendingRecoveryBackup(slots.storage).quarantined[0].encoded, "Private guest bytes");
  slots.switchTo(`gdrive-${"b".repeat(64)}`);
  assert.equal(workspaceModel.pendingRecoveryBackup(slots.storage).quarantined.length, 0);
  slots.switchToGuest();
  assert.equal(workspaceModel.pendingRecoveryBackup(slots.storage).quarantined[0].encoded, "Private guest bytes");
});

test("pending recovery: changing account or recovery state during export cannot acknowledge another state", async () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("async function dismissRecoveryNotice("), app.indexOf("\nfunction refreshPersistentToast()"));
  for (const change of ["account", "error"]) {
    let finishExport, quarantineCalls = 0;
    const context = vm.createContext({
      Blob, Date, toast: { dataset: { dismissible: "true" } }, pendingRecoveryError: new Error("pending.invalid"),
      workspaceStorage: {}, workspaceSlots: { accountKey: "first", isGuest: false },
      pendingRecoveryBackup: () => ({ pending: [] }), shareOrDownloadBlob: () => new Promise(resolve => { finishExport = resolve; }),
      quarantinePendingRecovery: () => { quarantineCalls++; }, withWorkspaceLock: action => action(),
    });
    vm.runInContext(source, context);
    const action = context.dismissRecoveryNotice({ preventDefault() {}, stopPropagation() {} });
    if (change === "account") context.workspaceSlots.accountKey = "second";
    else context.pendingRecoveryError = new Error("pending.newer");
    finishExport(true); await action;
    assert.equal(quarantineCalls, 0, change);
    assert.ok(context.pendingRecoveryError);
  }
});

test("pending delta: account slots isolate journals, recovery and diagnostic exports", () => {
  const s = new MemoryStorage(), slots = workspaceModel.createWorkspaceSlots(s);
  const { workspace, board } = largePendingFixture(slots.storage);
  const changed = structuredClone(board); changed.nodes[0].text = "Private local pending";
  stagePendingDocument(slots.storage, workspace, changed, Date.now, { baseBoard: board });
  slots.switchToGuest();
  const guest = loadWorkspace(slots.storage);
  assert.equal(guest.board.nodes.length, 0);
  assert.ok(!JSON.stringify(workspaceModel.pendingRecoveryBackup(slots.storage)).includes("Private local pending"));
  assert.deepEqual(loadWorkspace(s).board, changed);
});

test("pending delta: repeated changes from independent sessions preserve both versions and replay once", async () => {
  const peer = await import(`./workspace.js?pending-peer`);
  const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
  const a = structuredClone(board), b = structuredClone(board);
  a.nodes[0].text = "Session A"; b.nodes[1].text = "Session B";
  stagePendingDocument(s, workspace, a, () => 100, { baseBoard: board });
  peer.stagePendingDocument(s, workspace, b, () => 200, { baseBoard: board });
  assert.equal(pendingEntries(s).length, 2);
  const loaded = await locked(s, safe => loadWorkspace(safe));
  const boards = workspaceModel.createSyncWorkspace(s, loaded.workspace).boards;
  assert.equal(boards.length, 2);
  assert.ok(boards.some(b => b.board.nodes[0].text === "Session A"));
  assert.ok(boards.some(b => b.board.nodes[1].text === "Session B"));
  assert.equal(loadWorkspace(s).workspace.boards.length, 2);
});

test("pending delta: varied edits including reordering and directed edge changes reproduce exact boards", () => {
  for (let i = 0; i < 24; i++) {
    const s = new MemoryStorage(), { workspace, board } = largePendingFixture(s);
    const next = structuredClone(board);
    next.nodes[i].text = `输入 ${i}\n\n`;
    next.nodes[i].x -= 19; next.nodes[i].color = "mint";
    if (i % 2) next.nodes.reverse();
    if (i % 3) next.nodes.splice(next.nodes.findIndex(n => n.id === "n110"), 1);
    next.edges.push({ id: "added", from: "n3", to: "n4", arrow: "reverse", label: "中文 label" });
    if (i % 4) next.edges.reverse();
    else next.edges.splice(0, 1);
    stagePendingDocument(s, workspace, next, Date.now, { baseBoard: board });
    assert.deepEqual(loadWorkspace(s).board, next, `iteration ${i}`);
  }
});

// Exercise the real app scheduler with a deterministic clock, not a second
// implementation of the save policy. Browser tests cover the actual DOM/locks.
function appSaveHarness(overrides = {}) {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("function scheduleSave()"), app.indexOf("\nasync function commitCurrentBoard()"));
  let now = 0, nextId = 0;
  const timers = new Map(), saves = [], failures = [];
  const context = vm.createContext({
    SAVE_DELAY_MS: 180, SAVE_MAX_WAIT_MS: 1000,
    saveTimer: null, saveMaxTimer: null, saveInFlight: null,
    boardDirty: false, storageReady: true, mode: null, stagedPendingId: null,
    board: fixture(), workspace: { activeId: "test" }, workspaceStorage: {},
    savedBoardContent: JSON.stringify(fixture()), syncBoardContent: JSON.stringify,
    syncOpenInputs() {}, clearPendingDocument() {}, clearSaveFailure() {}, renderBoardList() {},
    reportRecoveryEviction() {}, reportStorageFailure(error) { failures.push(error); },
    markSaveFailure() {}, t: key => key, driveSync: { schedule() {} },
    document: { querySelector() { return null; } }, boardTitleEditor: { hidden: true }, edgeLabelEditor: { hidden: true },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    withWorkspaceLock: async action => action({}),
    saveDocument(_storage, _workspace, candidate) { saves.push({ at: now, board: structuredClone(candidate) }); return candidate; },
    ...overrides,
  });
  vm.runInContext(source, context);
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    context, timers, saves, failures, drain,
    input(text) { context.board.nodes[0].text = text; context.scheduleSave(); },
    async advance(ms) {
      const end = now + ms;
      let ticks = 0;
      while (true) {
        await drain();
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++ticks < 100, "No unbounded timer retry loop");
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
      await drain();
    },
  };
}

test("autosave: continuous 120ms input saves within each maximum wait without ending editing", async () => {
  const h = appSaveHarness({ document: { querySelector() { return {}; } } });
  for (let i = 0; i < 25; i++) { h.input(`text-${i}`); await h.advance(120); }
  assert.ok(h.saves.length >= 2, "Typing must not postpone every save until the pause");
  let last = 0;
  for (const save of h.saves) { assert.ok(save.at - last <= 1120); last = save.at; }
  assert.equal(h.saves[0].at, 1000);
  await h.advance(180);
  assert.equal(h.saves.at(-1).board.nodes[0].text, "text-24");
  assert.equal(h.context.boardDirty, false);
  assert.equal(h.timers.size, 0);
});

test("autosave: short bursts retain the trailing debounce and immediate flush cancels both timers", async () => {
  const h = appSaveHarness();
  h.input("one"); await h.advance(120); h.input("two");
  await h.advance(179); assert.equal(h.saves.length, 0);
  await h.advance(1); assert.equal(h.saves.length, 1);
  h.input("flush");
  assert.equal(await h.context.saveBoardNow(), true);
  assert.equal(h.saves.at(-1).board.nodes[0].text, "flush");
  await h.advance(2000);
  assert.equal(h.saves.length, 2);
  assert.equal(h.timers.size, 0);
});

test("autosave: waiting for a lock coalesces typing and explicit flushes into one writer", async () => {
  let release, requests = 0;
  const h = appSaveHarness({ withWorkspaceLock: action => {
    requests++;
    return new Promise(resolve => { release = () => resolve(action({})); });
  } });
  h.input("first"); await h.advance(180);
  const waiters = [];
  for (let i = 0; i < 30; i++) {
    h.input(`waiting-${i}`);
    waiters.push(h.context.saveBoardNow());
    await h.advance(120);
  }
  assert.equal(requests, 1, "A held lock must not accumulate save requests");
  assert.equal(h.saves.length, 0);
  release();
  assert.ok((await Promise.all(waiters)).every(Boolean));
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].board.nodes[0].text, "waiting-29");
  assert.equal(h.context.boardDirty, false);
  assert.equal(h.timers.size, 0);
});

test("autosave: edits after a write but before lock completion are saved before flush resolves", async () => {
  let release, requests = 0;
  const h = appSaveHarness({ withWorkspaceLock: action => {
    requests++;
    const result = action({});
    return requests === 1 ? new Promise(resolve => { release = () => resolve(result); }) : Promise.resolve(result);
  } });
  h.input("first");
  const flush = h.context.saveBoardNow();
  h.input("after-write");
  release();
  assert.equal(await flush, true);
  assert.equal(requests, 2);
  assert.deepEqual(h.saves.map(save => save.board.nodes[0].text), ["first", "after-write"]);
  assert.equal(h.context.boardDirty, false);
  await h.advance(2000);
  assert.equal(requests, 2);
});

test("autosave: a failed save stays dirty without a retry spin and later input can retry", async () => {
  let fail = true, requests = 0;
  const h = appSaveHarness({ withWorkspaceLock: async action => {
    requests++;
    if (fail) throw new DOMException("Full", "QuotaExceededError");
    return action({});
  } });
  h.input("keep me"); await h.advance(1200);
  assert.equal(h.context.boardDirty, true);
  assert.equal(h.failures.length, 1);
  await h.advance(5000); assert.equal(requests, 1);
  fail = false;
  h.input("retry latest"); await h.advance(180);
  assert.equal(h.saves.at(-1).board.nodes[0].text, "retry latest");
  assert.equal(h.context.boardDirty, false);
});

test("IME: actual text handlers ignore composing Enter/Escape and retain ordinary commands", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const guard = app.match(/function isComposingKeyEvent\(event\)[\s\S]*?\n}/)?.[0];
  assert.ok(guard);
  for (const name of ["edgeLabelEditor", "boardTitleEditor", "searchInput", "element"]) {
    const calls = [], listeners = new Map();
    const target = { dataset: { edgeId: "edge" }, focus() {}, addEventListener(type, handler) { listeners.set(type, handler); } };
    const editor = name === "element" ? {} : target;
    const composingInputs = new WeakSet();
    const start = app.indexOf(`${name}.addEventListener("keydown", (event) => {`);
    const end = app.indexOf(name === "element" ? '\n  editor.addEventListener("input"' : '\n});', start);
    assert.ok(start >= 0 && end > start);
    const source = app.slice(start, name === "element" ? end : end + 4);
    const context = vm.createContext({
      [name]: target, editor, composingInputs, node: { id: "note" }, nodeElements: new Map([["note", target]]),
      boardTitle: { focus() {} }, requestAnimationFrame: run => run(), focusEdge() {},
      finishEdgeLabel: cancel => calls.push(["finish", cancel]), finishBoardTitle: cancel => calls.push(["finish", cancel]),
      finishEditing: (_id, cancel) => calls.push(["finish", cancel]),
      moveSearch: direction => calls.push(["search", direction]), closeSearch: () => calls.push(["close"]),
    });
    vm.runInContext(`${guard}\n${source}`, context);
    const send = (key, flags = {}) => listeners.get("keydown")({
      target: editor, key, ctrlKey: name === "element" && key === "Enter",
      preventDefault: () => calls.push(["prevent"]), stopPropagation() {}, ...flags,
    });
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
      send("Enter", flags); send("Escape", flags);
    }
    composingInputs.add(editor);
    send("Enter"); send("Escape");
    assert.deepEqual(calls, [], `${name} leaves composition keys to the input method`);
    composingInputs.delete(editor);
    send("Enter"); send("Escape");
    assert.equal(calls.filter(call => call[0] === "prevent").length, 2, `${name} still handles deliberate commands`);
    if (name !== "searchInput") assert.deepEqual(calls.filter(call => call[0] === "finish"), [["finish", undefined], ["finish", true]]);
    else assert.deepEqual(calls.filter(call => call[0] !== "prevent"), [["search", 1], ["close"]]);
  }
});

function quotaFixture() {
  const s = new QuotaStorage(), loaded = loadWorkspace(s);
  const board = saveDocument(s, loaded.workspace, fixture());
  for (let i = 1; i <= 3; i++) workspaceModel.captureRecovery(s, `old-${i}`, {
    ...fixture(), nodes: [{ ...fixture().nodes[0], text: String(i).repeat(3000) }],
  }, "delete", () => i);
  return { s, workspace: loaded.workspace, board };
}

test("quota: ordinary saves retain recovery, only actual quota failure evicts the oldest necessary entry", async () => {
  const { s, workspace, board } = quotaFixture();
  const recovery = s.getItem(recoveryKey);
  await locked(s, safe => saveDocument(safe, workspace, board));
  assert.equal(s.getItem(recoveryKey), recovery);
  const protectedData = [...s.values].filter(([k]) => k !== recoveryKey);
  s.limit = s.usage + 20;
  await locked(s, safe => stagePendingDocument(safe, workspace, { ...board, title: "Pending" }));
  assert.deepEqual(workspaceModel.readRecovery(s).map(e => e.boardId), ["old-3", "old-2"]);
  for (const [key, value] of protectedData) assert.equal(s.getItem(key), value);
  assert.equal(loadWorkspace(s).board.title, "Pending");
});

test("quota: permission errors never evict history", async () => {
  const { s, workspace, board } = quotaFixture();
  const before = [...s.values];
  s.fault = key => key.startsWith("scattered-pending");
  await assert.rejects(locked(s, safe => stagePendingDocument(safe, workspace, board)), { name: "SecurityError" });
  assert.deepEqual([...s.values], before);
});

test("quota: an app save does not sacrifice history for a disposable journal", async () => {
  const { s, workspace, board } = quotaFixture();
  const candidate = { ...board, nodes: [{ ...board.nodes[0], text: "Modified" }] };
  const clone = () => { const copy = new QuotaStorage(); copy.values = new Map(s.values); return copy; };
  const measured = clone();
  let peak = measured.usage;
  const write = measured.setItem.bind(measured);
  measured.setItem = (key, value) => { write(key, value); peak = Math.max(peak, measured.usage); };
  saveDocument(measured, structuredClone(workspace), candidate);
  s.limit = peak + 10;
  const control = clone(); control.limit = s.limit;
  await locked(control, safe => saveDocument(safe, structuredClone(workspace), candidate));
  assert.equal(workspaceModel.readRecovery(control).length, 3, "The actual save fits without eviction");
  assert.throws(() => stagePendingDocument(s, workspace, candidate), { name: "QuotaExceededError" });
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const source = `${app.match(/function clearScheduledSave\(\)[\s\S]*?\n}/)[0]}\n${app.slice(app.indexOf("async function saveBoardNow()"), app.indexOf("\nasync function commitCurrentBoard()"))}`;
  const context = vm.createContext({
    ...workspaceModel, Date, clearTimeout, setTimeout,
    saveTimer: null, saveMaxTimer: null, saveInFlight: null, boardDirty: true, storageReady: true, stagedPendingId: null,
    workspace, workspaceStorage: s, board: candidate, savedBoardContent: JSON.stringify(board),
    syncOpenInputs() {}, boardWithoutDragPreview: () => candidate, syncBoardContent: JSON.stringify,
    renderBoardList() {}, clearSaveFailure() {}, reportStorageFailure(error) { throw error; },
    reportRecoveryEviction() { assert.fail("A save that fits must not evict history"); },
    driveSync: { schedule() {} }, mode: null,
    document: { querySelector() { return null; } }, boardTitleEditor: { hidden: true }, edgeLabelEditor: { hidden: true },
  });
  assert.equal(await vm.runInContext(`${source}\nsaveBoardNow()`, context), true);
  assert.equal(workspaceModel.readRecovery(s).length, 3);
  assert.equal(loadWorkspace(s).board.nodes[0].text, "Modified");
  assert.equal([...s.values.keys()].some(key => key.startsWith("scattered-pending-document")), false);
});

test("quota: eviction notifications require an actual removal under a native lock", async () => {
  const { s } = quotaFixture();
  let notifications = 0;
  const run = action => workspaceModel.withWorkspaceLock(action, s, () => { notifications++; });
  await run(safe => safe.setItem("small", "ok"));
  assert.equal(notifications, 0);
  s.limit = s.usage;
  await run(safe => safe.setItem("needs-room", "x".repeat(500)));
  assert.equal(notifications, 1);
  s.fault = () => true;
  await assert.rejects(run(safe => safe.setItem("denied", "x")), { name: "SecurityError" });
  assert.equal(notifications, 1);
  s.fault = null;
  const locks = navigator.locks;
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  s.limit = s.usage;
  try {
    await assert.rejects(run(safe => safe.setItem("unlocked", "x")), { name: "QuotaExceededError" });
    assert.equal(notifications, 1);
  } finally { Object.defineProperty(navigator, "locks", { configurable: true, value: locks }); }
});

test("quota: a remote workspace apply reports eviction through the same app hook", async () => {
  const { s, workspace, board } = quotaFixture();
  const before = workspaceModel.createSyncWorkspace(s, workspace);
  const incoming = structuredClone(before);
  incoming.boards[0].board.nodes[0].text = "remote edit ".repeat(120);
  incoming.boards[0].revision = "remote-new-revision";
  s.limit = s.usage + 20;
  let notifications = 0;
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("async function applyDriveWorkspace("), app.indexOf("\nasync function switchDriveAccount("));
  const context = vm.createContext({
    ...workspaceModel, fingerprintSyncWorkspace,
    workspaceStorage: s, workspace, board, syncBoardContent: JSON.stringify,
    canApplyDriveWorkspace: () => true, beginWorkspaceAction: () => true,
    replaceBoard() {}, renderBoardList() {}, updateRecoveryControl() {}, endWorkspaceAction() {},
    reportRecoveryEviction() { notifications++; },
    clearSaveFailure() { assert.ok(notifications > 0, "Eviction is reported before the normal success cleanup"); },
    incoming, fingerprint: await fingerprintSyncWorkspace(before),
  });
  await vm.runInContext(`${source}\napplyDriveWorkspace(incoming, fingerprint)`, context);
  assert.equal(notifications, 1);
  assert.equal(loadWorkspace(s).board.nodes[0].text, incoming.boards[0].board.nodes[0].text);
});

test("quota: exhausted retries preserve current documents, backups and pending journals", async () => {
  const { s, workspace, board } = quotaFixture();
  stagePendingDocument(s, workspace, { ...board, title: "Last recoverable edit" });
  const protectedData = [...s.values].filter(([k]) => k !== recoveryKey);
  s.limit = s.usage;
  const attempts = s.attempts;
  await assert.rejects(locked(s, safe => stagePendingDocument(safe, workspace, {
    ...board, nodes: [{ ...board.nodes[0], text: "x".repeat(50_000) }],
  })), { name: "QuotaExceededError" });
  assert.ok(s.attempts - attempts <= 8, "Retry count is bounded by the existing recovery entries");
  for (const [key, value] of protectedData) assert.equal(s.getItem(key), value);
  s.limit = Infinity;
  assert.equal(loadWorkspace(s).board.title, "Last recoverable edit");
});

test("quota: remote deletion and clear abort when the required recovery copy cannot fit", async () => {
  for (const operation of ["remote", "clear", "delete"]) {
    const s = new QuotaStorage(), { workspace } = loadWorkspace(s);
    const original = saveDocument(s, workspace, fixture());
    const before = [...s.values], beforeWorkspace = structuredClone(workspace);
    const incoming = workspaceModel.createSyncWorkspace(s, workspace);
    incoming.boards = [{ id: "remote-blank", revision: "remote-revision", updatedAt: 999, board: blankBoard() }];
    incoming.activeId = "remote-blank";
    incoming.tombstones = [{ id: workspace.activeId, deletedAt: 999 }];
    s.limit = s.usage;
    await assert.rejects(locked(s, safe => operation === "remote"
      ? workspaceModel.applySyncWorkspace(safe, workspace, incoming)
      : operation === "clear" ? workspaceModel.replaceDocument(safe, workspace, blankBoard(), "clear")
        : deleteDocument(safe, workspace)), { name: "QuotaExceededError" });
    assert.deepEqual(workspace, beforeWorkspace);
    assert.deepEqual([...s.values], before);
    assert.deepEqual(loadWorkspace(s).board, original);
  }
});

test("quota: rollback does not resurrect evicted history and retains the original canvas", async () => {
  const { s, workspace, board } = quotaFixture();
  const documents = [...s.values].filter(([k]) => k.startsWith("scattered-document"));
  const beforeWorkspace = structuredClone(workspace);
  s.limit = s.usage + 20;
  s.fault = (key, value) => key === "scattered-workspace-v2" && value !== JSON.stringify(beforeWorkspace);
  await assert.rejects(locked(s, safe => workspaceModel.replaceDocument(safe, workspace, {
    ...board, nodes: [{ ...board.nodes[0], text: "Replacement".repeat(150) }],
  }, "clear")), { name: "SecurityError" });
  assert.deepEqual(workspace, beforeWorkspace);
  for (const [key, value] of documents) assert.equal(s.getItem(key), value);
  assert.ok(!workspaceModel.readRecovery(s).some(e => e.boardId === "old-1"));
});

test("quota: persistent storage is checked, requested once, and safely degrades", async () => {
  assert.equal(typeof workspaceModel.requestPersistentStorage, "function");
  for (const grant of [true, false]) {
    let checks = 0, requests = 0;
    const manager = { persisted: async () => { checks++; return requests > 0 && grant; }, persist: async () => { requests++; return grant; } };
    assert.equal(await workspaceModel.requestPersistentStorage(manager), grant);
    assert.equal(requests, 1);
    assert.equal(checks, 2);
    assert.equal(await workspaceModel.requestPersistentStorage(manager), grant);
    assert.equal(requests, 1, "Repeated save/start calls do not re-request a denied permission");
  }
  let requested = false;
  assert.equal(await workspaceModel.requestPersistentStorage({ persisted: async () => true, persist: async () => { requested = true; } }), true);
  assert.equal(requested, false);
  assert.equal(await workspaceModel.requestPersistentStorage({}), false);
  assert.equal(await workspaceModel.requestPersistentStorage({ persisted: async () => { throw new Error("Unavailable"); } }), false);
  assert.equal(await workspaceModel.requestPersistentStorage({ persisted: async () => false, persist: async () => { throw new Error("Denied"); } }), false);
});

test("quota: automatic persistence skips Firefox but still allows FxiOS", async () => {
  for (const [ua, expected] of [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0", 0],
    ["Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0", 0],
    ["Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/140.0 Mobile/15E148 Safari/605.1.15", 1],
    ["Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", 1],
  ]) {
    let requests = 0;
    const manager = { persisted: async () => requests > 0, persist: async () => { requests++; return true; } };
    assert.equal(await workspaceModel.requestPersistentStorage(manager, ua), Boolean(expected));
    assert.equal(requests, expected);
    await workspaceModel.requestPersistentStorage(manager, ua);
    assert.equal(requests, expected);
  }
});

test("quota: new and reused deletion backups and a restoration source are never eviction candidates", async () => {
  for (const reused of [false, true]) {
    const { s, workspace, board } = quotaFixture();
    if (reused) workspaceModel.captureRecovery(s, workspace.activeId, board, "delete");
    s.limit = s.usage + 1500;
    await assert.rejects(locked(s, safe => {
      workspaceModel.captureRecovery(safe, workspace.activeId, board, "delete");
      safe.setItem("synthetic-large-write", "x".repeat(50_000));
    }), { name: "QuotaExceededError" });
    assert.equal(workspaceModel.readRecovery(s).length, 1);
    assert.equal(workspaceModel.readRecovery(s)[0].boardId, workspace.activeId);
  }
  const { s, workspace } = quotaFixture();
  const oldest = workspaceModel.readRecovery(s).at(-1);
  // Ensure a restore can never succeed, even after every other history entry is removed.
  const setItem = s.setItem.bind(s);
  s.setItem = (key, value) => {
    if (key.startsWith("scattered-document-v2:")) throw new DOMException("Full", "QuotaExceededError");
    setItem(key, value);
  };
  await assert.rejects(locked(s, safe => workspaceModel.restoreRecovery(safe, workspace, oldest.id)), { name: "QuotaExceededError" });
  assert.deepEqual(workspaceModel.readRecovery(s).map(entry => entry.id), [oldest.id]);
});

test("quota: a multi-document apply rolls back without erasing its saved original", async () => {
  const s = new QuotaStorage(), { workspace } = loadWorkspace(s);
  const original = saveDocument(s, workspace, {
    ...fixture(), nodes: [{ ...fixture().nodes[0], text: "original ".repeat(1000) }],
  });
  const incoming = workspaceModel.createSyncWorkspace(s, workspace);
  incoming.boards[0] = { ...incoming.boards[0], revision: "remote-revision", board: { ...original, title: "Changed", nodes: [] } };
  incoming.boards.push({ id: "remote-added", revision: "added-revision", updatedAt: 999, board: original });
  const beforeWorkspace = structuredClone(workspace);
  const beforeDocuments = [...s.values].filter(([key]) => key.startsWith("scattered-document"));
  // The added document uses space freed by shortening the first one. Rollback
  // must remove the addition before growing the old primary again.
  s.limit = s.usage + JSON.stringify(original).length + 1500;
  s.fault = (key, value) => key === "scattered-workspace-v2" && value !== JSON.stringify(beforeWorkspace);
  await assert.rejects(locked(s, safe => workspaceModel.applySyncWorkspace(safe, workspace, incoming)), { name: "SecurityError" });
  assert.deepEqual(workspace, beforeWorkspace);
  for (const [key, value] of beforeDocuments) assert.equal(s.getItem(key), value);
  assert.deepEqual(loadWorkspace(s).board, original);
});

test("quota: eviction stays in the current account and is disabled without a native lock", async () => {
  const { s } = quotaFixture();
  const localHistory = s.getItem(recoveryKey);
  const slots = workspaceModel.createWorkspaceSlots(s);
  slots.switchTo(`gdrive-${"a".repeat(64)}`);
  const { workspace, board } = loadWorkspace(slots.storage);
  workspaceModel.captureRecovery(slots.storage, "account-old", { ...fixture(), nodes: [{ ...fixture().nodes[0], text: "x".repeat(3000) }] }, "delete");
  s.limit = s.usage + 20;
  await locked(slots.storage, safe => safe.setItem("synthetic-account-write", "x".repeat(300)));
  assert.equal(s.getItem(recoveryKey), localHistory);
  assert.equal(workspaceModel.readRecovery(slots.storage).length, 0);

  s.limit = Infinity;
  workspaceModel.captureRecovery(slots.storage, "keep-without-lock", fixture(), "delete");
  s.limit = s.usage;
  const before = [...s.values];
  const locks = navigator.locks;
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  try {
    await assert.rejects(locked(slots.storage, safe => stagePendingDocument(safe, workspace, board)), { name: "QuotaExceededError" });
    assert.deepEqual([...s.values], before);
  } finally { Object.defineProperty(navigator, "locks", { configurable: true, value: locks }); }
});

test("quota: queued saves recheck the revision under the lock and preserve both concurrent edits", async () => {
  const { s, workspace, board } = quotaFixture();
  const stale = structuredClone(workspace);
  s.limit = s.usage + 20;
  await Promise.all([
    locked(s, async safe => {
      await Promise.resolve();
      saveDocument(safe, workspace, { ...board, nodes: [{ ...board.nodes[0], text: "First edit".repeat(50) }] });
    }),
    locked(s, safe => saveDocument(safe, stale, { ...board, nodes: [{ ...board.nodes[0], text: "Second edit".repeat(50) }] })),
  ]);
  const reloaded = loadWorkspace(s);
  const texts = workspaceModel.createSyncWorkspace(s, reloaded.workspace).boards.map(item => item.board.nodes[0].text).sort();
  assert.deepEqual(texts, ["First edit".repeat(50), "Second edit".repeat(50)]);
});

test("quota: Drive does not upload or acknowledge a remote deletion when its local backup cannot fit", async () => {
  const s = new QuotaStorage(), { workspace } = loadWorkspace(s);
  saveDocument(s, workspace, fixture());
  const local = workspaceModel.createSyncWorkspace(s, workspace);
  const base = await createCloudSnapshot(local, { deviceId: "local-device" });
  const remoteWorkspace = {
    ...local, activeId: "remote-blank",
    boards: [{ id: "remote-blank", revision: "blank-revision", updatedAt: 99, board: blankBoard() }],
    tombstones: [{ id: local.activeId, deletedAt: 99 }],
  };
  const remote = await createCloudSnapshot(remoteWorkspace, { deviceId: "remote-device", parents: [base] });
  s.setItem("scattered-drive-session-v1", "v1.c2VhbGVk");
  s.setItem("scattered-drive-device-v1", "local-device");
  s.setItem("scattered-drive-sync-v1", JSON.stringify({
    version: 1, lastSnapshotId: base.snapshotId, lastFingerprint: await fingerprintSyncWorkspace(local),
    parents: base.parents, ancestors: base.ancestors, history: base.history, fileId: "local-file",
  }));
  const before = [...s.values];
  s.limit = s.usage;
  const errors = [], statuses = [];
  let uploads = 0;
  let accountKey = null;
  const controller = createDriveSync({
    apiUrl: "https://broker.invalid", storage: s,
    locks: { request: async (_name, _options, action) => action({}) },
    getWorkspace: () => workspaceModel.createSyncWorkspace(s, workspace),
    getBoundAccount: () => accountKey, bindAccount: value => { accountKey = value; },
    applyWorkspace: incoming => locked(s, safe => workspaceModel.applySyncWorkspace(safe, workspace, incoming)),
    onError: error => errors.push(error), onStatus: status => statuses.push(status),
    fetch: async url => {
      const path = new URL(url).pathname;
      if (path === "/token") return Response.json({ accessToken: "synthetic-only", expiresIn: 3600 });
      if (path === "/drive/v3/about") return Response.json({ user: { permissionId: "synthetic-account" } });
      if (path === "/drive/v3/files") return Response.json({ files: [
        { id: "local-file", appProperties: { deviceId: "local-device" } },
        { id: "remote-file", appProperties: { deviceId: "remote-device" } },
      ] });
      if (path === "/drive/v3/files/local-file") return Response.json(base);
      if (path === "/drive/v3/files/remote-file") return Response.json(remote);
      uploads++;
      throw new Error(`Unexpected upload: ${url}`);
    },
  });
  try {
    assert.equal(await controller.syncNow(), false);
    assert.equal(errors.at(-1)?.name, "QuotaExceededError", `${errors.at(-1)?.syncStage}: ${errors.at(-1)?.message}`);
    assert.equal(errors.at(-1)?.syncStage, "apply");
    assert.equal(statuses.at(-1), "error");
    assert.equal(uploads, 0);
    assert.deepEqual([...s.values], before, "Neither content nor the merge checkpoint may advance");
    assert.deepEqual(workspaceModel.createSyncWorkspace(s, workspace), local);
  } finally { controller.stop(); }
});

test("long-title copy/import/recovery and startup healing terminate and preserve both edits", () => {
  // A separate process bounds the regression: the old implementation loops synchronously.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import * as w from ${JSON.stringify(new URL("./workspace.js", import.meta.url).href)};
    ${MemoryStorage.toString()}
    for (const length of [116, 117, 118, 119, 120]) {
      const s = new MemoryStorage(), { workspace, board } = w.loadWorkspace(s);
      const original = w.saveDocument(s, workspace, { ...board, title: '题'.repeat(length) });
      for (let n = 0; n < 3; n++) {
        w.duplicateDocument(s, workspace, original);
        w.addImportedWorkspace(s, workspace, { activeBoard: 0, boards: [original] });
        w.captureRecovery(s, workspace.activeId, original, 'delete');
        const recoveryId = w.readRecovery(s)[0].id;
        w.restoreRecovery(s, workspace, recoveryId);
      }
      const titles = workspace.boards.map(b => b.title);
      assert.equal(new Set(titles).size, titles.length);
      assert.ok(titles.every(title => title.length <= 120));
    }
    const s = new MemoryStorage(), first = w.loadWorkspace(s);
    const original = w.saveDocument(s, first.workspace, { ...first.board, title: '题'.repeat(120) });
    w.stagePendingDocument(s, first.workspace, { ...original, nodes: [{id:'a',text:'pending A',x:0,y:0}] });
    w.saveDocument(s, structuredClone(first.workspace), { ...original, nodes: [{id:'b',text:'saved B',x:0,y:0}] });
    const loaded = w.loadWorkspace(s);
    const texts = w.createSyncWorkspace(s, loaded.workspace).boards.flatMap(b => b.board.nodes.map(n => n.text));
    assert.deepEqual(texts.sort(), ['pending A', 'saved B']);
    assert.equal([...s.values.keys()].filter(k => k.startsWith('scattered-pending')).length, 0);
  `], { timeout: 4000, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test("view-only stale saves and pending replay adopt newer content without a copy", () => {
  for (const replay of [false, true]) {
    const s = new MemoryStorage(), first = loadWorkspace(s);
    const initial = saveDocument(s, first.workspace, fixture());
    const stale = structuredClone(first.workspace);
    saveDocument(s, first.workspace, { ...initial, nodes: [{ ...initial.nodes[0], text: "Peer edit" }] });
    const panned = { ...initial, view: { x: 99, y: 88, scale: 0.7 } };
    let result;
    if (replay) {
      stagePendingDocument(s, stale, panned, Date.now, { viewOnly: true });
      result = loadWorkspace(s);
    } else result = { board: saveDocument(s, stale, panned, Date.now, { viewOnly: true }), workspace: stale };
    assert.equal(result.workspace.boards.length, 1);
    assert.equal(result.board.nodes[0].text, "Peer edit");
    assert.deepEqual(result.board.view, panned.view);
  }
});

test("real concurrent edits still fork, and view-only saves never resurrect a deleted canvas", () => {
  const s = new MemoryStorage(), first = loadWorkspace(s);
  const initial = saveDocument(s, first.workspace, fixture());
  const stale = structuredClone(first.workspace);
  saveDocument(s, first.workspace, { ...initial, title: "Peer" });
  saveDocument(s, stale, { ...initial, title: "Local" });
  assert.equal(stale.boards.length, 2);
  const beforeDelete = structuredClone(stale);
  const local = workspaceModel.createSyncWorkspace(s, stale).boards.find(b => b.id === stale.activeId).board;
  deleteDocument(s, stale);
  const saved = saveDocument(s, beforeDelete, { ...local, view: { x: 20, y: 30, scale: 1 } }, Date.now, { viewOnly: true });
  assert.equal(beforeDelete.boards.length, 1);
  assert.equal(saved.title, "Peer");
});

test("refresh is read-only and does not follow another tab's active canvas", () => {
  const s = new MemoryStorage(), first = loadWorkspace(s);
  saveDocument(s, first.workspace, fixture());
  const stale = structuredClone(first.workspace), originalId = stale.activeId;
  createDocument(s, first.workspace, { ...fixture(), title: "Other" });
  const before = [...s.values];
  const board = workspaceModel.refreshWorkspace(s, stale);
  assert.equal(stale.activeId, originalId);
  assert.equal(board.title, "Shared");
  assert.equal(stale.boards.length, 2);
  assert.deepEqual([...s.values], before);
});

test("storage notifications are restricted to the tab's own account scope", () => {
  const s = new MemoryStorage(), slots = workspaceModel.createWorkspaceSlots(s);
  const key = "scattered-document-v2:example";
  const account = `gdrive-${"a".repeat(64)}`;
  const accountKey = `scattered-account-workspace-v1:${account}:${key}`;
  assert.equal(slots.ownsStorageKey(key), true);
  assert.equal(slots.ownsStorageKey(accountKey), false);
  slots.switchTo(account);
  assert.equal(slots.ownsStorageKey(accountKey), true);
  assert.equal(slots.ownsStorageKey(key), false);
  slots.switchToGuest();
  assert.equal(slots.ownsStorageKey(`scattered-guest-workspace-v1:${key}`), true);
  assert.equal(slots.ownsStorageKey(accountKey), false);
  assert.equal(slots.ownsStorageKey("scattered-drive-session-v1"), false);
  assert.equal(slots.ownsStorageKey(null), true);
});

test("single canvas backups use workspace import limits, with bounded input validation", () => {
  const make = (count, textLength = 5) => normalizeBoard({ ...blankBoard(), nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, text: "中".repeat(textLength), x: i * 5, y: 100, width: 218 })) });
  for (const board of [make(501), make(120, 6000)]) {
    assert.deepEqual(workspaceModel.parseCanvasBackup(JSON.stringify(board, null, 2)), board);
  }
  assert.throws(() => workspaceModel.parseCanvasBackup(JSON.stringify(make(20_001))), /import.tooMuchContent/);
  assert.throws(() => workspaceModel.parseCanvasBackup(" ".repeat(10 * 1024 * 1024 + 1)), /import.workspaceTooLarge/);
  assert.throws(() => workspaceModel.parseCanvasBackup('{"version":999}'), /import.unsupportedVersion/);
});

test("sharing content limits report sharing errors, not backup errors", () => {
  const large = { ...blankBoard(), nodes: Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, text: "x", x: 0, y: i })) };
  assert.throws(() => encodeSharedBoard(large), /shareTooLarge/);
});
