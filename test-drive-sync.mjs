import assert from "node:assert/strict";
import { createDriveSync } from "./drive-sync.js";
import { blankBoard } from "./model.js";

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
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)") {
      return Response.json({ user: { permissionId: "account-a" } });
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
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)") {
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
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)") {
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
]) {
  let stagedError = null;
  let uploadAttempted = false;
  const failingRemote = createDriveSync({
    apiUrl: "https://broker.example",
    storage: sessionStorage(`device-${label}`),
    getWorkspace: () => workspaceB,
    getBoundAccount: () => accountBKey,
    bindAccount: () => assert.fail("A bound account must not be rebound"),
    switchAccount: () => assert.fail("The matching account must not switch"),
    onError: (error) => { stagedError = error; },
    fetch: async (url) => {
      const href = String(url);
      if (href === "https://broker.example/token") {
        return Response.json({ accessToken: "drive-token-b", expiresIn: 3_600 });
      }
      if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)") {
        return Response.json({ user: { permissionId: "account-b" } });
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
  assert.equal(await failingRemote.syncNow(), false);
  assert.equal(stagedError?.syncStage, "download");
  assert.equal(stagedError?.message, expectedMessage);
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
    if (href === "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)") {
      return Response.json({ user: { permissionId: "account-local-error" } });
    }
    return new Response("unexpected", { status: 500 });
  },
});
assert.equal(await failingLocal.syncNow(), false);
assert.equal(stagedLocalError?.syncStage, "local");
assert.equal(stagedLocalError?.message, "sync.invalidWorkspace");

console.log("drive sync checks passed");
