import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as workspaceModel from "./workspace.js";
import { blankBoard, normalizeBoard } from "./model.js";
import { encodeSharedBoard } from "./share-model.js";

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
