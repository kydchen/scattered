import assert from "node:assert/strict";
import { createDriveSync } from "./drive-sync.js";
import { blankBoard, normalizeBoard } from "./model.js";
import { cloudSnapshotHeads, createCloudSnapshot, fingerprintSyncWorkspace, mergeSyncWorkspaces } from "./sync-model.js";
import { parseSyncWorkspace } from "./workspace.js";

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function createAccountBinding(initial = null) {
  let current = initial;
  return {
    get: () => current,
    bind: (accountKey) => {
      assert.equal(current, null);
      current = accountKey;
    },
    switchTo: (accountKey) => { current = accountKey; },
  };
}

function sessionStorage(deviceId) {
  return new MemoryStorage([
    ["scattered-drive-session-v1", "v1.c2VhbGVk"],
    ["scattered-drive-device-v1", deviceId],
  ]);
}

function boardWorkspace(id, title) {
  const board = blankBoard();
  board.title = title;
  return {
    format: "scattered-sync-workspace",
    version: 1,
    activeId: id,
    boards: [{ id, revision: `revision-${id}`, updatedAt: 1, board }],
    tombstones: [],
  };
}

const localOnlyStorage = new MemoryStorage();
const localOnlyStatuses = [];
const localOnly = createDriveSync({
  apiUrl: "",
  storage: localOnlyStorage,
  onStatus: (status) => localOnlyStatuses.push(status),
});
localOnly.start();
assert.deepEqual(localOnlyStatuses, ["unavailable"]);
assert.equal(localOnlyStorage.values.size, 0);

const workspaceA = boardWorkspace("board-a", "Account A");
const storage = sessionStorage("device-1");
storage.setItem("scattered-drive-sync-v1", JSON.stringify({
  version: 1,
  lastSnapshotId: "legacy-snapshot",
  lastFingerprint: "legacy-fingerprint",
  ancestors: [],
  history: [],
  fileId: "deleted-legacy-file",
}));
const account = createAccountBinding();
const requests = [];
const statuses = [];
let lockCalls = 0;
const sync = createDriveSync({
  apiUrl: "https://broker.example",
  storage,
  getWorkspace: () => workspaceA,
  applyWorkspace: () => assert.fail("An empty remote must not replace local data"),
  canApply: () => true,
  getBoundAccount: account.get,
  bindAccount: account.bind,
  switchAccount: account.switchTo,
  onStatus: (status) => statuses.push(status),
  locks: {
    request: async (name, options, callback) => {
      lockCalls += 1;
      assert.match(name, /^scattered-drive-sync-v1:device-1$/);
      assert.equal(options.ifAvailable, true);
      return callback({ name });
    },
  },
  fetch: async (url, init = {}) => {
    const href = String(url);
    requests.push({ url: href, init });
    if (href === "https://broker.example/token") {
      return Response.json({ accessToken: "drive-token", expiresIn: 3_600 });
    }
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress,photoLink)") {
      return Response.json({ user: { permissionId: "account-a", displayName: "Account A", emailAddress: "a@example.test", photoLink: "https://lh3.googleusercontent.com/avatar-a" } });
    }
    if (href.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      return Response.json({ files: [] });
    }
    if (href.startsWith("https://www.googleapis.com/upload/drive/v3/files?")) {
      return new Response(null, { status: 200, headers: { Location: "https://upload.example/session-a" } });
    }
    if (href === "https://upload.example/session-a") {
      return Response.json({ id: "drive-file-a", version: "1" });
    }
    return new Response("unexpected", { status: 500 });
  },
});

assert.equal(await sync.syncNow(), true);
assert.equal(statuses.at(-1), "synced");
assert.equal(lockCalls, 1);
assert.ok(requests.some((item) => item.url === "https://broker.example/token"));
const uploadA = requests.find((item) => item.url === "https://upload.example/session-a");
const uploadedSnapshotA = JSON.parse(uploadA.init.body);
assert.deepEqual(sync.profile, { name: "Account A", email: "a@example.test", photo: "https://lh3.googleusercontent.com/avatar-a" });
assert.ok(!uploadA.init.body.includes("a@example.test") && !uploadA.init.body.includes("avatar-a"), "Profile data stays out of canvas snapshots");
assert.equal(uploadedSnapshotA.format, "scattered-cloud-workspace");
assert.equal(uploadedSnapshotA.workspace.boards[0].id, "board-a");
assert.ok(uploadedSnapshotA.ancestors.includes("legacy-snapshot"));
const accountAKey = account.get();
assert.match(accountAKey, /^gdrive-[a-f0-9]{64}$/);
const stateKeyA = `scattered-drive-sync-v1:${accountAKey}`;
assert.match(storage.getItem(stateKeyA), /drive-file-a/);
assert.equal(storage.getItem("scattered-drive-sync-v1"), null);

const stateBeforeDisconnect = storage.getItem(stateKeyA);
sync.disconnect();
assert.equal(sync.profile, null);
assert.equal(storage.getItem("scattered-drive-session-v1"), null);
assert.equal(storage.getItem(stateKeyA), stateBeforeDisconnect);

storage.setItem("scattered-drive-session-v1", "v1.c2VhbGVk");
const reconnectRequests = [];
const reconnect = createDriveSync({
  apiUrl: "https://broker.example",
  storage,
  getWorkspace: () => workspaceA,
  applyWorkspace: () => assert.fail("An unchanged workspace must not be replaced"),
  canApply: () => true,
  getBoundAccount: account.get,
  bindAccount: () => assert.fail("A known account must not be rebound"),
  switchAccount: () => assert.fail("Reconnect must not switch workspaces"),
  fetch: async (url) => {
    const href = String(url);
    reconnectRequests.push(href);
    if (href === "https://broker.example/token") {
      return Response.json({ accessToken: "drive-token", expiresIn: 3_600 });
    }
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress,photoLink)") {
      return Response.json({ user: { permissionId: "account-a" } });
    }
    if (href.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      return Response.json({ files: [{
        id: "drive-file-a",
        modifiedTime: "2026-09-01T00:00:00Z",
        appProperties: { deviceId: "device-1" },
      }] });
    }
    if (href === "https://www.googleapis.com/drive/v3/files/drive-file-a?alt=media") {
      return new Response(JSON.stringify(uploadedSnapshotA));
    }
    if (href.includes("/upload/")) assert.fail("Reconnect must not create another cloud head");
    return new Response("unexpected", { status: 500 });
  },
});
assert.equal(await reconnect.syncNow(), true);
assert.deepEqual(reconnect.profile, { name: "", email: "", photo: "" }, "Accounts without profile fields still sync");
assert.equal(reconnectRequests.filter((url) => url.includes("/upload/")).length, 0);

storage.setItem("scattered-drive-session-v1", "v1.c2VhbGVk");
const workspaceB = boardWorkspace("board-b", "Account B");
let visibleWorkspace = workspaceA;
const switchEvents = [];
let uploadedSnapshotB = null;
const switchSync = createDriveSync({
  apiUrl: "https://broker.example",
  storage,
  getWorkspace: () => {
    switchEvents.push("local");
    return visibleWorkspace;
  },
  applyWorkspace: () => assert.fail("An empty account must not replace its fresh local workspace"),
  canApply: () => true,
  getBoundAccount: account.get,
  bindAccount: () => assert.fail("Switching accounts must not claim the existing account slot"),
  switchAccount: (accountKey) => {
    switchEvents.push("switch");
    account.switchTo(accountKey);
    visibleWorkspace = workspaceB;
  },
  fetch: async (url, init = {}) => {
    const href = String(url);
    if (href === "https://broker.example/token") {
      return Response.json({ accessToken: "drive-token-b", expiresIn: 3_600 });
    }
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress,photoLink)") {
      switchEvents.push("account");
      return Response.json({ user: { permissionId: "account-b" } });
    }
    if (href.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      switchEvents.push("list");
      return Response.json({ files: [] });
    }
    if (href.startsWith("https://www.googleapis.com/upload/drive/v3/files?")) {
      return new Response(null, { status: 200, headers: { Location: "https://upload.example/session-b" } });
    }
    if (href === "https://upload.example/session-b") {
      uploadedSnapshotB = JSON.parse(init.body);
      return Response.json({ id: "drive-file-b", version: "1" });
    }
    return new Response("unexpected", { status: 500 });
  },
});
assert.equal(await switchSync.syncNow(), true);
assert.deepEqual(switchEvents.slice(0, 4), ["account", "switch", "local", "list"]);
assert.equal(uploadedSnapshotB.workspace.boards.length, 1);
assert.equal(uploadedSnapshotB.workspace.boards[0].id, "board-b");
const accountBKey = account.get();
assert.match(accountBKey, /^gdrive-[a-f0-9]{64}$/);
assert.notEqual(accountBKey, accountAKey);
assert.equal(storage.getItem(stateKeyA), stateBeforeDisconnect);
assert.match(storage.getItem(`scattered-drive-sync-v1:${accountBKey}`), /drive-file-b/);

for (const [label, remoteResponse, expectedMessage] of [
  ["unreadable", () => new Response("offline", { status: 503 }), "Drive sync failed: drive-503"],
  ["invalid", () => new Response("not-json"), "Drive sync failed: snapshot-invalid"],
  ["offline-during-download", () => {
    Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: false });
    throw new TypeError("Network disconnected");
  }, null],
]) {
  let stagedError = null;
  let lastStatus;
  let uploadAttempted = false;
  const failingRemote = createDriveSync({
    apiUrl: "https://broker.example",
    storage: sessionStorage(`device-${label}`),
    getWorkspace: () => workspaceB,
    getBoundAccount: () => accountBKey,
    bindAccount: () => assert.fail("A bound account must not be rebound"),
    switchAccount: () => assert.fail("The matching account must not switch"),
    onError: (error) => { stagedError = error; },
    onStatus: (status) => { lastStatus = status; },
    fetch: async (url) => {
      const href = String(url);
      if (href === "https://broker.example/token") {
        return Response.json({ accessToken: "drive-token-b", expiresIn: 3_600 });
      }
      if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress,photoLink)") {
        return Response.json({ user: { permissionId: "account-b", photoLink: "https://googleusercontent.com.attacker.invalid/avatar" } });
      }
      if (href.startsWith("https://www.googleapis.com/drive/v3/files?")) {
        return Response.json({ files: [{ id: "remote-file", appProperties: { deviceId: "other-device" } }] });
      }
      if (href === "https://www.googleapis.com/drive/v3/files/remote-file?alt=media") {
        return remoteResponse();
      }
      if (href.includes("/upload/")) uploadAttempted = true;
      return new Response("unexpected", { status: 500 });
    },
  });
  const onlineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine");
  try { assert.equal(await failingRemote.syncNow(), false); }
  finally {
    if (onlineDescriptor) Object.defineProperty(globalThis.navigator, "onLine", onlineDescriptor);
    else delete globalThis.navigator.onLine;
  }
  if (label === "offline-during-download") {
    assert.equal(lastStatus, "offline");
    assert.equal(stagedError, null, "Going offline does not issue a reconnect error");
  } else {
    assert.equal(stagedError?.syncStage, "download");
    assert.equal(stagedError?.message, expectedMessage);
  }
  assert.equal(failingRemote.profile.photo, "", "An untrusted avatar host is never rendered");
  assert.equal(uploadAttempted, false);
}

let stagedLocalError = null;
const localErrorAccount = createAccountBinding();
const failingLocal = createDriveSync({
  apiUrl: "https://broker.example",
  storage: sessionStorage("device-local-error"),
  getWorkspace: () => { throw new Error("sync.invalidWorkspace"); },
  getBoundAccount: localErrorAccount.get,
  bindAccount: localErrorAccount.bind,
  switchAccount: localErrorAccount.switchTo,
  onError: (error) => { stagedLocalError = error; },
  fetch: async (url) => {
    const href = String(url);
    if (href === "https://broker.example/token") {
      return Response.json({ accessToken: "drive-token", expiresIn: 3_600 });
    }
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName,emailAddress,photoLink)") {
      return Response.json({ user: { permissionId: "account-local-error" } });
    }
    return new Response("unexpected", { status: 500 });
  },
});
assert.equal(await failingLocal.syncNow(), false);
assert.equal(stagedLocalError?.syncStage, "local");
assert.equal(stagedLocalError?.message, "sync.invalidWorkspace");

// Exercise the real sync controller with isolated devices and an in-memory Drive.
function syncLab() {
  const files = new Map();
  let frozenFiles = null;
  let uploads = 0;
  let failUpload = false;
  let serial = 0;
  const seed = boardWorkspace("canvas", "Canvas");
  seed.boards[0].board = normalizeBoard({ ...seed.boards[0].board, nodes: [{ id: "note", text: "initial", x: 0, y: 0 }] });
  return {
    files,
    get uploads() { return uploads; },
    freeze() { frozenFiles = structuredClone(files); },
    unfreeze() { frozenFiles = null; },
    failNextUpload() { failUpload = true; },
    device(id, initial = seed) {
      const binding = createAccountBinding();
      const device = { workspace: structuredClone(initial), conflicts: 0, storage: sessionStorage(id), errors: [] };
      const options = {
        apiUrl: "https://broker.test",
        storage: device.storage,
        getBoundAccount: binding.get,
        bindAccount: binding.bind,
        getWorkspace: () => structuredClone(device.workspace),
        canApply: () => true,
        applyWorkspace: async (incoming, expected) => {
          assert.equal(await fingerprintSyncWorkspace(device.workspace), expected);
          device.workspace = structuredClone(incoming);
        },
        onConflict: (count) => { device.conflicts += count; },
        onError: (error) => { device.errors.push(error); },
        fetch: async (url, init = {}) => {
          const path = new URL(url).pathname;
          const visible = frozenFiles ?? files;
          if (path === "/token") return Response.json({ accessToken: "mock-only", expiresIn: 3600 });
          if (path === "/drive/v3/about") return Response.json({ user: { permissionId: "same-account" } });
          if (path === "/drive/v3/files") return Response.json({ files: [...visible].map(([fileId, snapshot]) => ({
            id: fileId, appProperties: { deviceId: snapshot.deviceId }, modifiedTime: "2026-09-15T00:00:00Z",
          })) });
          if (path.startsWith("/drive/v3/files/")) return Response.json(visible.get(path.split("/").at(-1)));
          if (path.startsWith("/upload/drive/v3/files")) {
            const fileId = path.split("/")[5] || `file-${++serial}`;
            return new Response(null, { headers: { Location: `https://mock.test/session/${fileId}` } });
          }
          if (path.startsWith("/session/")) {
            if (failUpload) { failUpload = false; return new Response("offline", { status: 503 }); }
            const fileId = path.split("/").at(-1);
            const snapshot = JSON.parse(init.body);
            parseSyncWorkspace(snapshot.workspace);
            files.set(fileId, snapshot);
            uploads += 1;
            return Response.json({ id: fileId });
          }
          throw new Error(`Unexpected mock request: ${url}`);
        },
      };
      let controller = createDriveSync(options);
      device.restart = () => { controller.stop(); controller = createDriveSync(options); };
      device.sync = async (success = true) => {
        assert.equal(await controller.syncNow(), success, device.errors.at(-1)?.message);
      };
      device.edit = (text, boardId = "canvas") => {
        const item = device.workspace.boards.find((board) => board.id === boardId);
        item.board.nodes[0].text = text;
        item.revision = globalThis.crypto.randomUUID();
        item.updatedAt += 1;
      };
      return device;
    },
  };
}

const longRun = syncLab();
const writer = longRun.device("writer");
const dormant = longRun.device("dormant");
await writer.sync();
await dormant.sync();
await writer.sync();
for (let edit = 1; edit <= 160; edit += 1) {
  writer.edit(`edit-${edit}`);
  await writer.sync();
  assert.equal(writer.workspace.boards.length, 1, `Dormant device must not create copies at edit ${edit}`);
  assert.equal(writer.conflicts, 0);
  if (edit === 80) writer.restart();
}
await dormant.sync();
assert.equal(dormant.workspace.boards.length, 1);
assert.equal(dormant.workspace.boards[0].board.nodes[0].text, "edit-160");
await writer.sync();
const idleUploads = longRun.uploads;
for (let poll = 0; poll < 5; poll += 1) { await dormant.sync(); await writer.sync(); }
assert.equal(longRun.uploads, idleUploads, "Idle devices must not ping-pong new checkpoints");
assert.equal(dormant.conflicts, 0);

// A device which adopted remote edits must retain a usable base while dormant.
for (let edit = 161; edit <= 240; edit += 1) { writer.edit(`edit-${edit}`); await writer.sync(); }
dormant.edit("offline edit");
await dormant.sync();
await writer.sync();
assert.equal(writer.workspace.boards.length, 2, "Real concurrent edits preserve both variants exactly once");
assert.deepEqual(new Set(writer.workspace.boards.map((item) => item.board.nodes[0].text)), new Set(["edit-240", "offline edit"]));
for (let poll = 0; poll < 5; poll += 1) { await dormant.sync(); await writer.sync(); }
assert.equal(writer.workspace.boards.length, 2);
assert.equal(dormant.workspace.boards.length, 2);
assert.equal(dormant.conflicts, 1);

// Genuine simultaneous uploads remain distinct heads until merged.
const concurrent = syncLab();
const peers = [concurrent.device("left"), concurrent.device("right"), concurrent.device("third")];
for (const peer of peers) await peer.sync();
concurrent.freeze();
for (const [index, peer] of peers.entries()) { peer.edit(`concurrent-${index}`); await peer.sync(); }
concurrent.unfreeze();
for (let round = 0; round < 3; round += 1) for (const peer of peers) await peer.sync();
for (const peer of peers) {
  assert.equal(peer.workspace.boards.length, 3);
  assert.deepEqual(new Set(peer.workspace.boards.map((item) => item.board.nodes[0].text)), new Set(["concurrent-0", "concurrent-1", "concurrent-2"]));
}
const concurrentUploads = concurrent.uploads;
for (const peer of peers) await peer.sync();
assert.equal(concurrent.uploads, concurrentUploads);

// Independent canvas edits after a long offline period merge without copies.
const independent = syncLab();
const multi = independent.device("multi");
multi.workspace.boards.push({ ...structuredClone(multi.workspace.boards[0]), id: "second" });
const offline = independent.device("offline", multi.workspace);
await multi.sync(); await offline.sync();
for (let edit = 0; edit < 100; edit += 1) { multi.edit(`online-${edit}`); await multi.sync(); }
offline.edit("independent offline edit", "second");
await offline.sync(); await multi.sync();
assert.equal(offline.conflicts, 0);
assert.equal(multi.workspace.boards.length, 2);
assert.equal(multi.workspace.boards.find((item) => item.id === "canvas").board.nodes[0].text, "online-99");
assert.equal(multi.workspace.boards.find((item) => item.id === "second").board.nodes[0].text, "independent offline edit");

// Delete versus edit preserves the edit, never resurrecting the deleted ID.
multi.workspace.boards = multi.workspace.boards.filter((item) => item.id !== "second");
multi.workspace.activeId = "canvas";
multi.workspace.tombstones.push({ id: "second", deletedAt: 1000 });
offline.edit("edit while deleted", "second");
await multi.sync(); await offline.sync(); await multi.sync();
assert.ok(multi.workspace.tombstones.some((item) => item.id === "second"));
assert.ok(!multi.workspace.boards.some((item) => item.id === "second"));
assert.ok(multi.workspace.boards.some((item) => item.board.nodes[0].text === "edit while deleted"));
const deletionCount = multi.workspace.boards.length;
for (let poll = 0; poll < 4; poll += 1) { await offline.sync(); await multi.sync(); }
assert.equal(multi.workspace.boards.length, deletionCount);

// Upload failure after applying a conflict must not multiply copies on retry.
const retry = syncLab();
const retryA = retry.device("retry-a"), retryB = retry.device("retry-b");
await retryA.sync(); await retryB.sync();
retryA.edit("first edit"); retryB.edit("second edit");
await retryA.sync();
retry.failNextUpload();
await retryB.sync(false);
assert.equal(retryB.workspace.boards.length, 2);
retryB.restart();
await retryB.sync(); await retryA.sync();
assert.equal(retryB.workspace.boards.length, 2);
assert.equal(await fingerprintSyncWorkspace(retryA.workspace), await fingerprintSyncWorkspace(retryB.workspace));

// Migration: even with no usable ancestry, legacy copies are retained and reused.
const legacy = syncLab();
const upgraded = legacy.device("upgraded");
const stale = structuredClone(upgraded.workspace);
upgraded.edit("latest before upgrade");
const alreadyMerged = await mergeSyncWorkspaces(upgraded.workspace, stale);
upgraded.workspace = alreadyMerged.workspace;
const legacyA = await createCloudSnapshot(alreadyMerged.workspace, { deviceId: "upgraded" });
const legacyB = await createCloudSnapshot(stale, { deviceId: "old-device" });
delete legacyA.parents; delete legacyB.parents;
legacy.files.set("legacy-a", legacyA); legacy.files.set("legacy-b", legacyB);
const beforeUpgrade = await fingerprintSyncWorkspace(upgraded.workspace);
await upgraded.sync();
assert.equal(await fingerprintSyncWorkspace(upgraded.workspace), beforeUpgrade, "Upgrade never cleans up or replaces existing copies");
assert.equal(upgraded.conflicts, 0);
for (let edit = 0; edit < 100; edit += 1) { upgraded.edit(`after upgrade ${edit}`); await upgraded.sync(); }
assert.equal(upgraded.workspace.boards.length, alreadyMerged.workspace.boards.length);
assert.equal(upgraded.conflicts, 0);

// Parent acknowledgements must not silently truncate at the old 48-entry limit.
const many = syncLab();
const manyWriter = many.device("many-writer");
for (let device = 0; device < 60; device += 1) {
  const old = await createCloudSnapshot(manyWriter.workspace, { deviceId: `old-${device}` });
  delete old.parents;
  many.files.set(`old-file-${device}`, old);
}
await manyWriter.sync();
for (let edit = 0; edit < 55; edit += 1) { manyWriter.edit(`many-${edit}`); await manyWriter.sync(); }
assert.equal(manyWriter.workspace.boards.length, 1);
assert.equal(manyWriter.conflicts, 0);
assert.equal(cloudSnapshotHeads([...many.files.values()]).length, 1);
const beforeInvalid = await fingerprintSyncWorkspace(manyWriter.workspace);
const uploadsBeforeInvalid = many.uploads;
many.files.get("old-file-0").parents = [42];
await manyWriter.sync(false);
assert.equal(manyWriter.errors.at(-1)?.syncStage, "download");
assert.equal(many.uploads, uploadsBeforeInvalid, "Invalid new metadata must stop uploads");
assert.equal(await fingerprintSyncWorkspace(manyWriter.workspace), beforeInvalid);

console.log("drive sync checks passed");
