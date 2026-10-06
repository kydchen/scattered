import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test, after } from "node:test";
import * as workspaceModel from "./workspace.js";
import { blankBoard, normalizeBoard } from "./model.js";
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
  const source = app.slice(app.indexOf("async function saveBoardNow()"), app.indexOf("\nasync function commitCurrentBoard()"));
  const context = vm.createContext({
    ...workspaceModel, Date, clearTimeout, setTimeout,
    saveTimer: null, boardDirty: true, storageReady: true, pendingSaveNeeded: true,
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
