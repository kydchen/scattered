import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBoard } from "./model.js";
import { findMovedBoards, fingerprintSyncWorkspace, indexSyncWorkspace, mergeSyncWorkspaces } from "./sync-model.js";

const clone = value => structuredClone(value);
const find = (workspace, id) => workspace.boards.find(item => item.id === id);
const texts = workspace => workspace.boards.map(item => item.board.nodes[0]?.text);
const item = (id, title, text) => ({ id, revision: `r-${id}`, updatedAt: 1,
  board: normalizeBoard({ title, nodes: [{ id: "note", text, x: 0, y: 0 }], edges: [] }) });

// Generate a real conflict copy through the public merge, including its ID and title.
async function history(twin = false) {
  const base = { format: "scattered-sync-workspace", version: 1, activeId: "alpha",
    boards: [item("alpha", "甲", "shared template")], tombstones: [] };
  if (twin) base.boards.push(item("beta", "乙", "shared template"));
  const older = clone(base), holder = clone(base);
  find(older, "alpha").board.nodes[0].text = "before shared template";
  const index = await indexSyncWorkspace(base);
  let ordered = false;
  for (let n = 0; n < 1000; n += 1) {
    find(holder, "alpha").board.nodes[0].text = `holder alpha ${n}`;
    if ((await indexSyncWorkspace(holder))[0].hash.localeCompare(index[0].hash) < 0) { ordered = true; break; }
  }
  assert.ok(ordered, "The fixture must leave the holder's branch on the original canvas");
  if (twin) find(holder, "beta").board.nodes[0].text = "holder beta";
  const result = await mergeSyncWorkspaces(holder, base, await indexSyncWorkspace(older));
  const copies = result.workspace.boards.filter(entry => entry.id.startsWith("sync-"));
  assert.equal(copies.length, 1);
  assert.equal(copies[0].board.nodes[0].text, "shared template");
  const writer = clone(base);
  find(writer, "alpha").board.nodes[0].text = "latest alpha";
  return { base, writer, holder: result.workspace, carrier: clone(copies[0]), index };
}

async function bothOrders(h, check) {
  const before = JSON.stringify([h.writer, h.holder, h.index]);
  let fingerprint;
  for (const reverse of [false, true]) {
    const left = clone(reverse ? h.holder : h.writer), right = clone(reverse ? h.writer : h.holder);
    if (reverse) { left.boards.reverse(); right.boards.reverse(); }
    const result = await mergeSyncWorkspaces(left, right, h.index);
    await check(result, reverse);
    const next = await fingerprintSyncWorkspace(result.workspace);
    if (fingerprint) assert.equal(next, fingerprint, "Content must not depend on device or canvas order");
    fingerprint = next;
  }
  assert.equal(JSON.stringify([h.writer, h.holder, h.index]), before, "Merge must not mutate its inputs");
}

test("continue the verified copy, keep the holder, and follow the active writer", async () => {
  const h = await history();
  find(h.writer, "alpha").board.view.x = 123;
  find(h.holder, h.carrier.id).board.view.x = 456;
  await bothOrders(h, ({ workspace, conflicts }, reverse) => {
    assert.equal(conflicts, 0);
    assert.equal(workspace.boards.length, 2);
    assert.equal(find(workspace, h.carrier.id).board.nodes[0].text, "latest alpha");
    assert.equal(find(workspace, "alpha").board.nodes[0].text, find(h.holder, "alpha").board.nodes[0].text);
    assert.equal(workspace.activeId, reverse ? "alpha" : h.carrier.id);
    assert.equal(find(workspace, h.carrier.id).board.view.x, reverse ? 456 : 123);
  });
});

test("two template canvases cannot send different latest edits into the same copy", async () => {
  const h = await history(true);
  find(h.writer, "beta").board.nodes[0].text = "latest beta";
  await bothOrders(h, ({ workspace }) => {
    for (const text of ["latest alpha", "latest beta", "holder beta", find(h.holder, "alpha").board.nodes[0].text]) {
      assert.ok(texts(workspace).includes(text), `Missing ${text}`);
    }
    assert.equal(find(workspace, h.carrier.id).board.nodes[0].text, "latest alpha");
  });
});

test("editing the other template canvas cannot overwrite this canvas's protected copy", async () => {
  const h = await history(true);
  h.writer = clone(h.base);
  find(h.writer, "beta").board.nodes[0].text = "latest beta";
  await bothOrders(h, ({ workspace }) => {
    assert.deepEqual(find(workspace, h.carrier.id).board, h.carrier.board);
    assert.ok(texts(workspace).includes("latest beta"));
  });
});

for (const alsoRenameCarrier of [false, true]) {
  test(`a writer rename survives with its latest text (carrier renamed: ${alsoRenameCarrier})`, async () => {
    const h = await history();
    find(h.writer, "alpha").board.title = "USER-RENAMED-TITLE";
    if (alsoRenameCarrier) find(h.holder, h.carrier.id).board.title = "RENAMED-CARRIER";
    await bothOrders(h, ({ workspace }) => {
      assert.ok(workspace.boards.some(entry => entry.board.title === "USER-RENAMED-TITLE"
        && entry.board.nodes[0].text === "latest alpha"));
      assert.deepEqual(find(workspace, h.carrier.id).board, find(h.holder, h.carrier.id).board);
    });
  });
}

test("preserve a carrier rename when the source title still proves the baseline", async () => {
  const h = await history();
  find(h.holder, h.carrier.id).board.title = "RENAMED-CARRIER";
  await bothOrders(h, ({ workspace, conflicts }) => {
    assert.equal(conflicts, 0);
    assert.equal(find(workspace, h.carrier.id).board.title, "RENAMED-CARRIER");
    assert.equal(find(workspace, h.carrier.id).board.nodes[0].text, "latest alpha");
  });
});

test("continue after deletion of the original without resurrecting it", async () => {
  const h = await history();
  h.holder.boards = h.holder.boards.filter(entry => entry.id !== "alpha");
  h.holder.tombstones.push({ id: "alpha", deletedAt: 9 });
  h.holder.activeId = h.carrier.id;
  await bothOrders(h, ({ workspace, conflicts }) => {
    assert.equal(conflicts, 0);
    assert.equal(workspace.boards.length, 1);
    assert.equal(find(workspace, h.carrier.id).board.nodes[0].text, "latest alpha");
    assert.ok(workspace.tombstones.some(entry => entry.id === "alpha"));
  });
});

for (const reason of ["text", "position", "edge", "missing-base", "wrong-base", "base-member", "other-side", "other-deletion", "multiple", "both-sides", "invalid-receipt"]) {
  test(`uncertain continuation falls back without overwriting the copy: ${reason}`, async () => {
    const h = await history(), target = find(h.holder, h.carrier.id);
    if (reason === "text") target.board.nodes[0].text = "independent carrier edit";
    if (reason === "position") target.board.nodes[0].x = 25;
    if (reason === "edge") {
      target.board.nodes.push({ ...target.board.nodes[0], id: "second", x: 250 });
      target.board.edges.push({ id: "edge", from: "note", to: "second", arrow: "none", label: "keep edge" });
    }
    if (reason === "missing-base") h.index = [];
    if (reason === "wrong-base") h.index[0].hash = "wrong";
    if (reason === "base-member") h.index.push(...await indexSyncWorkspace({ ...h.base, boards: [h.carrier] }));
    if (reason === "other-side") h.writer.boards.push(clone(h.carrier));
    if (reason === "other-deletion") h.writer.tombstones.push({ id: h.carrier.id, deletedAt: 9 });
    if (reason === "multiple") h.holder.boards.push({ ...clone(h.carrier), id: `${h.carrier.id}-2` });
    if (reason === "both-sides") h.writer.boards.push({ ...clone(h.carrier), id: `${h.carrier.id}-2` });
    if (reason === "invalid-receipt") target.revision = "sync-cont-invalid";
    await bothOrders(h, ({ workspace }) => {
      assert.ok(texts(workspace).includes("latest alpha"));
      if (reason === "base-member") {
        assert.ok(!find(workspace, h.carrier.id), "Absence on the changed side must not become a continuation target");
      } else if (reason === "other-deletion") {
        assert.ok(!find(workspace, h.carrier.id));
        assert.ok(workspace.tombstones.some(entry => entry.id === h.carrier.id));
      } else assert.deepEqual(find(workspace, h.carrier.id).board, target.board);
    });
  });
}

for (const suffix of ["-2", "-12", "-0", "-1", "-02", "-x", "-2-extra"]) {
  test(`only canonical collision suffixes can continue: ${suffix}`, async () => {
    const h = await history();
    const target = find(h.holder, h.carrier.id);
    target.id += suffix;
    await bothOrders(h, ({ workspace, conflicts }) => {
      const expected = suffix === "-2" || suffix === "-12";
      assert.equal(find(workspace, target.id).board.nodes[0].text, expected ? "latest alpha" : "shared template");
      assert.ok(texts(workspace).includes("latest alpha"));
      if (expected) assert.equal(conflicts, 0);
    });
  });
}

test("a deleted carrier is not resurrected and replay does not allocate more copies", async () => {
  const h = await history();
  h.holder.boards = h.holder.boards.filter(entry => entry.id !== h.carrier.id);
  h.holder.tombstones.push({ id: h.carrier.id, deletedAt: 9 });
  const first = await mergeSyncWorkspaces(h.writer, h.holder, h.index);
  assert.ok(!find(first.workspace, h.carrier.id));
  assert.ok(first.workspace.tombstones.some(entry => entry.id === h.carrier.id));
  assert.ok(texts(first.workspace).includes("latest alpha"));
  for (let n = 0; n < 3; n += 1) {
    const replay = await mergeSyncWorkspaces(h.writer, first.workspace, h.index);
    assert.equal(replay.conflicts, 0);
    assert.equal(await fingerprintSyncWorkspace(replay.workspace), await fingerprintSyncWorkspace(first.workspace));
  }
});

test("successive drafts keep the same verified carrier across serialized checkpoints", async () => {
  const h = await history();
  let source = h.base, holder = h.holder;
  for (let n = 0; n < 12; n += 1) {
    const next = clone(source);
    find(next, "alpha").board.nodes[0].text = `draft-${n}`;
    const result = await mergeSyncWorkspaces(next, holder, await indexSyncWorkspace(source));
    assert.equal(result.conflicts, 0, `Draft ${n} must not start another copy`);
    assert.equal(result.workspace.boards.length, 2);
    assert.equal(find(result.workspace, h.carrier.id).board.nodes[0].text, `draft-${n}`);
    holder = JSON.parse(JSON.stringify(result.workspace));
    source = next;
  }
});

for (const changed of ["source-id", "copy-id", "hash", "title", "body"]) {
  test(`a continuation receipt cannot be reused with a different ${changed}`, async () => {
    const h = await history();
    const continued = (await mergeSyncWorkspaces(h.writer, h.holder, h.index)).workspace;
    const base = clone(h.writer), writer = clone(base), target = find(continued, h.carrier.id);
    if (changed === "source-id") {
      for (const workspace of [base, writer, continued]) {
        find(workspace, "alpha").id = "different-source";
        workspace.activeId = "different-source";
      }
    }
    if (changed === "copy-id") target.id += "-2";
    if (changed === "hash") find(base, "alpha").board.nodes[0].text = "unrelated base";
    if (changed === "title") writer.boards[0].board.title = "Writer's new title";
    if (changed === "body") target.board.nodes[0].text = "independent copy edit";
    writer.boards[0].board.nodes[0].text = "next draft";
    await bothOrders({ writer, holder: continued, index: await indexSyncWorkspace(base) }, ({ workspace }) => {
      assert.deepEqual(find(workspace, target.id).board, target.board);
      assert.ok(texts(workspace).includes("next draft"));
      if (changed === "title") assert.ok(workspace.boards.some(entry => entry.board.title === "Writer's new title"
        && entry.board.nodes[0].text === "next draft"));
    });
  });
}

test("follow a fresh verified copy before and after continuation, independent of view", async () => {
  const h = await history();
  find(h.holder, h.carrier.id).board.view.x = 999;
  assert.deepEqual([...await findMovedBoards(h.base, h.holder)], [["alpha", h.carrier.id]]);
  const continued = (await mergeSyncWorkspaces(h.writer, h.holder, h.index)).workspace;
  assert.deepEqual([...await findMovedBoards(h.writer, continued)], [["alpha", h.carrier.id]]);
  assert.equal((await findMovedBoards(continued, clone(continued))).size, 0, "Applying/reloading the same content is silent");
});

for (const invalid of ["source", "body", "receipt", "ambiguous", "known", "local-deletion", "incoming-deletion", "unchanged"]) {
  test(`following rejects an unproven or unnecessary move: ${invalid}`, async () => {
    const h = await history();
    const copy = find(h.holder, h.carrier.id);
    if (invalid === "source") find(h.base, "alpha").id = "unrelated";
    if (invalid === "body") copy.board.nodes[0].text = "independent change";
    if (invalid === "receipt") copy.revision = "sync-cont-invalid";
    if (invalid === "ambiguous") h.holder.boards.push({ ...clone(copy), id: `${copy.id}-2` });
    if (invalid === "known") h.base.boards.push(clone(copy));
    if (invalid === "local-deletion") h.base.tombstones.push({ id: copy.id, deletedAt: 9 });
    if (invalid === "incoming-deletion") h.holder.tombstones.push({ id: copy.id, deletedAt: 9 });
    if (invalid === "unchanged") find(h.holder, "alpha").board = clone(find(h.base, "alpha").board);
    assert.equal((await findMovedBoards(h.base, h.holder)).size, 0);
  });
}

for (const alphaConflict of [false, true]) {
  test(`same-content canvases follow only their own copies (alpha conflict: ${alphaConflict})`, async () => {
    const local = { format: "scattered-sync-workspace", version: 1, activeId: "alpha",
      boards: [item("alpha", "甲", "same template"), item("beta", "乙", "same template")], tombstones: [] };
    const base = clone(local), remote = clone(local);
    find(base, "beta").board.nodes[0].text = "older beta";
    if (alphaConflict) find(base, "alpha").board.nodes[0].text = "older alpha";
    const hashes = await indexSyncWorkspace(local);
    for (const id of ["alpha", "beta"]) {
      let ordered = false;
      for (let n = 0; n < 1000; n++) {
        find(remote, id).board.nodes[0].text = `remote ${id} ${n}`;
        if ((await indexSyncWorkspace(remote)).find(item => item.id === id).hash < hashes.find(item => item.id === id).hash) { ordered = true; break; }
      }
      assert.ok(ordered);
    }
    const incoming = (await mergeSyncWorkspaces(local, remote, await indexSyncWorkspace(base))).workspace;
    const moved = await findMovedBoards(local, incoming);
    assert.equal(moved.size, alphaConflict ? 2 : 1);
    assert.equal(find(incoming, moved.get("beta")).board.title, "乙 · 2");
    if (alphaConflict) assert.equal(find(incoming, moved.get("alpha")).board.title, "甲 · 2");
    else assert.ok(!moved.has("alpha"));
  });
}
