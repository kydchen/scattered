import assert from "node:assert/strict";
import { createDriveSync } from "./drive-sync.js";
import { blankBoard } from "./model.js";

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
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

const workspace = {
  format: "scattered-sync-workspace",
  version: 1,
  activeId: "board-1",
  boards: [{ id: "board-1", revision: "revision-1", updatedAt: 1, board: blankBoard() }],
  tombstones: [],
};
const storage = new MemoryStorage([
  ["scattered-drive-session-v1", "v1.c2VhbGVk"],
  ["scattered-drive-device-v1", "device-1"],
]);
const requests = [];
const statuses = [];
const sync = createDriveSync({
  apiUrl: "https://broker.example",
  storage,
  getWorkspace: () => workspace,
  applyWorkspace: () => assert.fail("An empty remote must not replace local data"),
  canApply: () => true,
  onStatus: (status) => statuses.push(status),
  fetch: async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (url === "https://broker.example/token") {
      return Response.json({ accessToken: "drive-token", expiresIn: 3_600 });
    }
    if (String(url).startsWith("https://www.googleapis.com/drive/v3/files?")) {
      return Response.json({ files: [] });
    }
    if (String(url).startsWith("https://www.googleapis.com/upload/drive/v3/files?")) {
      return new Response(null, { status: 200, headers: { Location: "https://upload.example/session" } });
    }
    if (url === "https://upload.example/session") {
      return Response.json({ id: "drive-file-1", version: "1" });
    }
    return new Response("unexpected", { status: 500 });
  },
});

assert.equal(await sync.syncNow(), true);
assert.equal(statuses.at(-1), "synced");
assert.ok(requests.some((item) => item.url === "https://broker.example/token"));
const upload = requests.find((item) => item.url === "https://upload.example/session");
const uploadedSnapshot = JSON.parse(upload.init.body);
assert.equal(uploadedSnapshot.format, "scattered-cloud-workspace");
assert.equal(uploadedSnapshot.workspace.boards[0].id, "board-1");
assert.match(storage.getItem("scattered-drive-sync-v1"), /drive-file-1/);
sync.disconnect();
assert.equal(storage.getItem("scattered-drive-session-v1"), null);

console.log("drive sync checks passed");
