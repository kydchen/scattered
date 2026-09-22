import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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
  const versions = new Map();
  let frozenFiles = null;
  let frozenVersions = null;
  let uploads = 0;
  let downloads = 0;
  let failUpload = false;
  let serial = 0;
  const seed = boardWorkspace("canvas", "Canvas");
  seed.boards[0].board = normalizeBoard({ ...seed.boards[0].board, nodes: [{ id: "note", text: "initial", x: 0, y: 0 }] });
  return {
    files,
    versions,
    get uploads() { return uploads; },
    get downloads() { return downloads; },
    freeze() { frozenFiles = structuredClone(files); frozenVersions = new Map(versions); },
    unfreeze() { frozenFiles = null; frozenVersions = null; },
    failNextUpload() { failUpload = true; },
    device(id, initial = seed, storage = sessionStorage(id)) {
      const binding = createAccountBinding();
      const device = { workspace: structuredClone(initial), conflicts: 0, storage, errors: [], canApply: true, canSync: true, statuses: [], requests: [] };
      const options = {
        apiUrl: "https://broker.test",
        storage: device.storage,
        now: () => device.now ?? Date.now(),
        getBoundAccount: binding.get,
        bindAccount: binding.bind,
        getWorkspace: () => structuredClone(device.workspace),
        canSync: () => device.canSync,
        canApply: () => device.canApply,
        hasPendingChanges: () => device.pendingChanges,
        applyWorkspace: async (incoming, expected) => {
          assert.ok(device.canApply, "Never replace an active editor or gesture");
          assert.equal(await fingerprintSyncWorkspace(device.workspace), expected);
          device.workspace = structuredClone(incoming);
        },
        onConflict: (count) => { device.conflicts += count; },
        onStatus: (status) => { device.statuses.push(status); },
        onError: (error) => { device.errors.push(error); },
        fetch: async (url, init = {}) => {
          const path = new URL(url).pathname;
          device.requests.push(path);
          await device.beforeRequest?.(path);
          const response = await device.respond?.(url, init);
          if (response) return response;
          const visible = frozenFiles ?? files;
          if (path === "/token") return Response.json({ accessToken: "mock-only", expiresIn: 3600 });
          if (path === "/drive/v3/about") return Response.json({ user: { permissionId: "same-account" } });
          if (path === "/drive/v3/files") return Response.json({ files: [...visible].map(([fileId, snapshot]) => ({
            id: fileId, appProperties: { deviceId: snapshot.deviceId }, modifiedTime: "2026-09-15T00:00:00Z", version: (frozenVersions ?? versions).get(fileId),
          })) });
          if (path.startsWith("/drive/v3/files/")) { downloads += 1; return Response.json(visible.get(path.split("/").at(-1))); }
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
            versions.set(fileId, String(Number(versions.get(fileId) || 0) + 1));
            uploads += 1;
            return Response.json({ id: fileId });
          }
          throw new Error(`Unexpected mock request: ${url}`);
        },
      };
      let controller = createDriveSync(options);
      device.stop = () => controller.stop();
      device.disconnect = () => controller.disconnect();
      Object.defineProperty(device, "connected", { get: () => controller.connected });
      device.start = () => controller.start();
      device.schedule = (...args) => controller.schedule(...args);
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

// Use the actual app guards, not an always-idle approximation of the UI.
const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const ui = {
  storageReady: true, workspaceActionPending: false, boardDirty: false, mode: null,
  selectedIds: new Set(["note"]), selectedEdgeId: "edge", keyboardLinkSourceIds: null,
  menu: { hidden: true }, boardPicker: { classList: { contains: () => false } },
  searchPanel: { hidden: true }, boardTitleEditor: { hidden: true }, edgeLabelEditor: { hidden: true },
  colorPalette: { hidden: true }, editing: false,
};
ui.document = { querySelector: (selector) => selector === ".node.editing" && ui.editing ? {} : null };
const guardSource = ["canSyncDriveWorkspace", "canApplyDriveWorkspace"].map((name) => appSource.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))[0]).join("\n");
const appGuard = (name) => vm.runInNewContext(`${guardSource}; ${name}`, ui);
assert.equal(appGuard("canApplyDriveWorkspace")(), true, "Selection alone must not indefinitely block receiving remote changes");
ui.editing = true;
assert.equal(appGuard("canApplyDriveWorkspace")(), false, "Applying still waits for the active editor");
assert.equal(appGuard("canSyncDriveWorkspace")(), true, "Persisted input can upload while editing");
ui.workspaceActionPending = true;
assert.equal(appGuard("canSyncDriveWorkspace")(), false, "Account and workspace changes remain protected");

const background = syncLab();
const tablet = background.device("tablet"), desktop = background.device("desktop");
await tablet.sync(); await desktop.sync(); await tablet.sync();
tablet.canApply = false;
tablet.edit("saved while editing");
await tablet.sync();
await desktop.sync();
assert.equal(desktop.workspace.boards[0].board.nodes[0].text, "saved while editing", "Upload does not require closing the editor or opening the logo menu");
desktop.edit("desktop concurrent edit");
await desktop.sync();
tablet.edit("tablet concurrent edit");
const tabletBeforeMerge = await fingerprintSyncWorkspace(tablet.workspace);
await tablet.sync(false);
assert.equal(await fingerprintSyncWorkspace(tablet.workspace), tabletBeforeMerge, "A deferred remote merge must not touch an active editor");
const pendingHeads = cloudSnapshotHeads([...background.files.values()]);
assert.equal(pendingHeads.length, 2, "Uploading local edits must not acknowledge unapplied remote changes");
assert.deepEqual(new Set(pendingHeads.map((item) => item.workspace.boards[0].board.nodes[0].text)), new Set(["desktop concurrent edit", "tablet concurrent edit"]));
const pendingUploads = background.uploads;
await tablet.sync(false);
assert.equal(background.uploads, pendingUploads, "Waiting for editing to end must not repeatedly upload the same local branch");
assert.equal(tablet.conflicts, 0, "Only report a conflict copy after it has actually been applied");
tablet.restart();
tablet.canApply = true;
await tablet.sync(); await desktop.sync();
assert.equal(tablet.workspace.boards.length, 2);
assert.equal(await fingerprintSyncWorkspace(tablet.workspace), await fingerprintSyncWorkspace(desktop.workspace));
const settledUploads = background.uploads;
await tablet.sync(); await desktop.sync();
const settledDownloads = background.downloads;
await tablet.sync(); await desktop.sync();
assert.equal(background.uploads, settledUploads);
assert.equal(background.downloads, settledDownloads, "Unchanged versioned snapshots must not download again");
const requestsBeforeAction = tablet.requests.length;
tablet.canSync = false;
await tablet.sync(false);
assert.equal(tablet.requests.length, requestsBeforeAction, "A critical workspace action blocks all sync work");
tablet.stop(); desktop.stop();

const cacheChecks = syncLab(), cachedDevice = cacheChecks.device("cache");
await cachedDevice.sync(); await cachedDevice.sync();
const cacheFile = [...cacheChecks.files.keys()][0];
const warmDownloads = cacheChecks.downloads;
await cachedDevice.sync();
assert.equal(cacheChecks.downloads, warmDownloads);
cacheChecks.files.get(cacheFile).parents = [42];
cacheChecks.versions.set(cacheFile, "2");
const uploadsBeforeCacheError = cacheChecks.uploads;
await cachedDevice.sync(false);
assert.equal(cachedDevice.errors.at(-1)?.syncStage, "download", "A changed file version must be downloaded and validated again");
assert.equal(cacheChecks.uploads, uploadsBeforeCacheError);
cacheChecks.files.get(cacheFile).parents = [];
await cachedDevice.sync();
cacheChecks.versions.delete(cacheFile);
const downloadsWithoutVersion = cacheChecks.downloads;
await cachedDevice.sync(); await cachedDevice.sync();
assert.equal(cacheChecks.downloads, downloadsWithoutVersion + 2, "Missing versions must never reuse cached content");
cachedDevice.stop();

const incomplete = syncLab(), uncheckpointed = incomplete.device("uncheckpointed"), other = incomplete.device("other");
await uncheckpointed.sync(); await other.sync();
uncheckpointed.edit("uploaded before checkpoint failure");
const normalSave = uncheckpointed.storage.setItem.bind(uncheckpointed.storage);
uncheckpointed.storage.setItem = (key, value) => {
  if (key.startsWith("scattered-drive-sync-v1:")) throw new Error("storage full");
  normalSave(key, value);
};
await uncheckpointed.sync(false);
uncheckpointed.storage.setItem = normalSave;
other.edit("other edit"); await other.sync();
uncheckpointed.edit("new edit after failed checkpoint");
uncheckpointed.canApply = false;
const beforeBlockedUpload = incomplete.uploads;
await uncheckpointed.sync(false);
assert.equal(incomplete.uploads, beforeBlockedUpload, "An upload without a saved checkpoint cannot be overwritten by a deferred branch");
uncheckpointed.canApply = true;
await uncheckpointed.sync(); await other.sync();
assert.ok(other.workspace.boards.some((item) => item.board.nodes[0].text === "new edit after failed checkpoint"));
assert.ok(other.workspace.boards.some((item) => item.board.nodes[0].text === "other edit"));
uncheckpointed.stop(); other.stop();

// A long-running editor must keep acknowledged dormant files pinned without
// acknowledging another device's concurrent edit before actually applying it.
const busyRun = syncLab();
const busyWriter = busyRun.device("busy-writer"), busyPeer = busyRun.device("busy-peer"), oldPeer = busyRun.device("old-peer");
await busyWriter.sync(); await busyPeer.sync(); await oldPeer.sync(); await busyWriter.sync();
busyPeer.edit("remote while editing"); await busyPeer.sync();
busyWriter.canApply = false;
for (let edit = 0; edit < 65; edit += 1) { busyWriter.edit(`busy-${edit}`); await busyWriter.sync(false); }
assert.equal(cloudSnapshotHeads([...busyRun.files.values()]).length, 2, "Dormant heads must not replay after the ancestry limit during deferred merges");
busyWriter.canApply = true;
await busyWriter.sync(); await busyPeer.sync(); await oldPeer.sync();
assert.equal(busyWriter.workspace.boards.length, 2);
assert.deepEqual(new Set(busyWriter.workspace.boards.map((item) => item.board.nodes[0].text)), new Set(["remote while editing", "busy-64"]));
busyWriter.stop(); busyPeer.stop(); oldPeer.stop();

const busyIndependent = syncLab(), independentEditor = busyIndependent.device("independent-editor");
independentEditor.workspace.boards.push({ ...structuredClone(independentEditor.workspace.boards[0]), id: "second" });
const independentPeer = busyIndependent.device("independent-peer", independentEditor.workspace);
await independentEditor.sync(); await independentPeer.sync(); await independentEditor.sync();
independentPeer.edit("remote second canvas", "second"); await independentPeer.sync();
independentEditor.canApply = false;
for (let edit = 0; edit < 65; edit += 1) { independentEditor.edit(`local first canvas ${edit}`); await independentEditor.sync(false); }
independentEditor.canApply = true;
await independentEditor.sync(); await independentPeer.sync();
assert.equal(independentEditor.workspace.boards.length, 2, "A deferred branch retains its common base even during a long editing session");
assert.equal(independentEditor.conflicts, 0, "Different-canvas edits are not conflicts");
assert.equal(independentEditor.workspace.boards.find((item) => item.id === "second").board.nodes[0].text, "remote second canvas");
independentEditor.stop(); independentPeer.stop();

// Use fake scheduling only here; request and merge checks above use real code.
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
const timers = new Map(), intervals = new Map();
let timerSerial = 0;
globalThis.setTimeout = (fn, delay) => { timers.set(++timerSerial, { fn, delay }); return timerSerial; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.setInterval = (fn, delay) => { intervals.set(++timerSerial, { fn, delay }); return timerSerial; };
globalThis.clearInterval = (id) => intervals.delete(id);
try {
  const timed = syncLab(), typing = timed.device("typing");
  typing.now = 1000;
  typing.start();
  assert.equal([...intervals.values()][0].delay, 10_000, "Foreground checks run every ten seconds, not every forty-five");
  await typing.sync();
  typing.schedule();
  const firstTimer = [...timers.keys()][0];
  assert.equal(timers.get(firstTimer).delay, 800);
  for (let tick = 1; tick <= 6; tick += 1) { typing.now += 100; typing.schedule(); }
  assert.ok(timers.has(firstTimer), "Continuing to type must not postpone the existing sync deadline");
  typing.schedule(0);
  assert.equal([...timers.values()][0].delay, 0, "Focus/manual sync can move the deadline earlier");
  await typing.sync();
  typing.edit("before upload");
  typing.beforeRequest = (path) => {
    if (path.startsWith("/session/")) { typing.beforeRequest = null; typing.edit("during upload"); }
  };
  await typing.sync();
  assert.equal(typing.statuses.at(-1), "connected", "An old upload must not label newer saved changes synced");
  assert.equal(timers.size, 1, "New edits during upload schedule a follow-up");
  await typing.sync();
  assert.equal([...timed.files.values()][0].workspace.boards[0].board.nodes[0].text, "during upload");
  typing.pendingChanges = true;
  await typing.sync();
  assert.equal(typing.statuses.at(-1), "connected", "Unsaved input must not be labelled synced either");
  typing.stop();
  assert.equal(timers.size, 0);
  assert.equal(intervals.size, 0);

  // A deadline must cover token fetch, a stalled body, and an interrupted upload.
  for (const stage of ["token", "body", "upload"]) {
    const lab = syncLab(), device = lab.device(`timeout-${stage}`);
    let entered, capturedSignal;
    const waiting = new Promise(resolve => { entered = resolve; });
    device.respond = async (url, init) => {
      const path = new URL(url).pathname;
      if (!((stage === "token" && path === "/token")
        || (stage === "body" && path === "/drive/v3/files")
        || (stage === "upload" && path.startsWith("/session/")))) return;
      capturedSignal = init.signal;
      entered();
      if (stage === "body") return new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } }));
      return new Promise((_, reject) => init.signal.addEventListener("abort",
        () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    };
    device.start();
    const attempt = device.sync(false);
    await waiting;
    const deadline = [...timers.values()].find(item => item.delay === 90_000);
    assert.ok(deadline, `${stage}: sync needs a deadline, not an endless spinner`);
    deadline.fn();
    await attempt;
    assert.equal(capturedSignal.aborted, true);
    assert.match(device.errors.at(-1).message, /timeout/);
    assert.equal(device.statuses.at(-1), "error");
    assert.equal(device.connected, true, "A network timeout must not sign the user out");
    device.respond = null;
    await device.sync();
    assert.equal(device.statuses.at(-1), "synced", "The next poll can retry after timeout");
    assert.equal(device.workspace.boards.length, 1);
    assert.equal(device.conflicts, 0);
    device.stop();
    assert.equal(timers.size, 0);
    assert.equal(intervals.size, 0);
  }
} finally {
  globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
  globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval;
}

// Tabs share persistent credentials, but must never continue with stale ones.
const SESSION_KEY = "scattered-drive-session-v1";
{
  const lab = syncLab(), first = lab.device("same-device");
  await first.sync();
  const other = lab.device("same-device", first.workspace, first.storage);
  other.disconnect();
  const uploads = lab.uploads;
  first.edit("local edit after another tab logs out");
  await first.sync(false);
  assert.equal(first.connected, false);
  assert.equal(lab.uploads, uploads, "Logout in another tab prevents later uploads");
  assert.equal(first.workspace.boards[0].board.nodes[0].text, "local edit after another tab logs out");
  first.stop(); other.stop();
}
for (const response of [() => new Response(null, { status: 401 }),
  () => Response.json({ accessToken: "old-access", session: "v1.b2xkLXJvdGF0ZWQ", expiresIn: 3600 })]) {
  const lab = syncLab(), old = lab.device("old-tab");
  let entered, finish;
  const waiting = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { finish = resolve; });
  old.respond = async () => { entered(); await released; return response(); };
  const attempt = old.sync(false);
  await waiting;
  old.storage.setItem(SESSION_KEY, "v1.bmV3LWxvZ2lu");
  finish();
  await attempt;
  assert.equal(old.storage.getItem(SESSION_KEY), "v1.bmV3LWxvZ2lu", "A late old response cannot delete or overwrite a new login");
  assert.equal(old.connected, false);
  assert.equal(lab.uploads, 0);
  old.disconnect();
  assert.equal(old.storage.getItem(SESSION_KEY), "v1.bmV3LWxvZ2lu", "Even a stale logout cannot delete a newer login");
  old.stop();
}
{
  const add = globalThis.addEventListener, remove = globalThis.removeEventListener;
  const listeners = new Set();
  globalThis.addEventListener = (name, fn) => { if (name === "storage") listeners.add(fn); };
  globalThis.removeEventListener = (name, fn) => { if (name === "storage") listeners.delete(fn); };
  const lab = syncLab(), old = lab.device("storage-event");
  try {
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    old.respond = async (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      entered();
    });
    old.start();
    const attempt = old.sync(false);
    await waiting;
    assert.equal(listeners.size, 1);
    old.storage.removeItem(SESSION_KEY);
    for (const listener of listeners) listener({ key: SESSION_KEY, storageArea: old.storage });
    await attempt;
    assert.equal(old.connected, false, "Storage events cancel in-flight sync without waiting for the next poll");
    assert.equal(old.statuses.at(-1), "disconnected");
    assert.equal(old.errors.length, 0, "An intentional logout is not a network error");
    assert.equal(lab.uploads, 0);
    old.stop();
    assert.equal(listeners.size, 0);
  } finally {
    old.stop();
    globalThis.addEventListener = add;
    globalThis.removeEventListener = remove;
  }
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
