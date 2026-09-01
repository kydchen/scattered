import { MAX_WORKSPACE_IMPORT_BYTES, parseSyncWorkspace } from "./workspace.js";
import {
  CLOUD_SNAPSHOT_FORMAT,
  CLOUD_SNAPSHOT_VERSION,
  cloudSnapshotHeads,
  createCloudSnapshot,
  findCommonBaseIndex,
  fingerprintSyncWorkspace,
  indexSyncWorkspace,
  isDisposableSyncWorkspace,
  mergeSnapshotHistory,
  mergeSyncWorkspaces,
  parseSyncIndex,
} from "./sync-model.js";

const SESSION_KEY = "scattered-drive-session-v1";
const DEVICE_KEY = "scattered-drive-device-v1";
const STATE_KEY = "scattered-drive-sync-v1";
const DRIVE_MARK = "workspace-v1";
const SYNC_LOCK_PREFIX = "scattered-drive-sync-v1:";
const SYNC_DELAY = 1_500;
const POLL_INTERVAL = 45_000;
const MAX_CLOUD_BYTES = MAX_WORKSPACE_IMPORT_BYTES + 2 * 1024 * 1024;

export function createDriveSync(options) {
  const apiUrl = String(options.apiUrl || "").replace(/\/$/, "");
  const storage = options.storage;
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const clock = options.now || Date.now;
  const locks = options.locks || globalThis.navigator?.locks;
  const deviceId = apiUrl ? readOrCreateDeviceId(storage) : "";
  const storedSession = read(storage, SESSION_KEY);
  let session = validSession(storedSession) ? storedSession : "";
  let accessToken = null;
  let accessTokenExpiresAt = 0;
  let authenticatedAccountKey = null;
  let timer = null;
  let pollTimer = null;
  let running = false;
  let queued = false;
  let syncStage = "idle";

  const controller = {
    available: Boolean(apiUrl),
    get connected() { return Boolean(session); },
    start,
    connect,
    disconnect,
    schedule,
    syncNow,
    stop,
  };

  return controller;

  function start() {
    if (!controller.available) {
      setStatus("unavailable");
      return;
    }
    const authResult = consumeAuthFragment();
    if (validSession(authResult.session)) {
      session = authResult.session;
      accessToken = null;
      accessTokenExpiresAt = 0;
      authenticatedAccountKey = null;
      write(storage, SESSION_KEY, session);
    }
    setStatus(session ? (authResult.error ? "error" : "connected") : (authResult.error ? "error" : "disconnected"));
    globalThis.addEventListener?.("online", onWake);
    globalThis.addEventListener?.("focus", onWake);
    globalThis.document?.addEventListener?.("visibilitychange", onVisibilityChange);
    pollTimer = globalThis.setInterval?.(() => {
      if (globalThis.document?.visibilityState !== "hidden") schedule(0);
    }, POLL_INTERVAL);
    if (session) schedule(350);
  }

  function stop() {
    clearTimeout(timer);
    clearInterval(pollTimer);
    globalThis.removeEventListener?.("online", onWake);
    globalThis.removeEventListener?.("focus", onWake);
    globalThis.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
  }

  function connect() {
    if (!controller.available) return;
    const returnTo = `${globalThis.location.origin}${globalThis.location.pathname}`;
    globalThis.location.assign(`${apiUrl}/oauth/start?return_to=${encodeURIComponent(returnTo)}`);
  }

  function disconnect() {
    session = null;
    accessToken = null;
    accessTokenExpiresAt = 0;
    authenticatedAccountKey = null;
    remove(storage, SESSION_KEY);
    setStatus("disconnected");
  }

  function schedule(delay = SYNC_DELAY) {
    if (!session || !controller.available) return;
    clearTimeout(timer);
    if (!running) setStatus("connected");
    timer = setTimeout(() => { void syncNow(); }, delay);
  }

  async function syncNow() {
    clearTimeout(timer);
    timer = null;
    if (!session || !controller.available || globalThis.navigator?.onLine === false) return false;
    if (running) {
      queued = true;
      return false;
    }
    if (options.canApply && !options.canApply()) {
      schedule(900);
      return false;
    }
    running = true;
    setStatus("syncing");
    try {
      const result = await withSyncLock(performSync);
      setStatus("synced");
      if (result.conflicts > 0) options.onConflict?.(result.conflicts);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && !error.syncStage) error.syncStage = syncStage;
      if (error?.code === "busy") {
        setStatus("connected");
        schedule(900);
        return false;
      }
      if (error?.code === "auth") {
        session = null;
        accessToken = null;
        authenticatedAccountKey = null;
        remove(storage, SESSION_KEY);
      }
      if (error?.code === "account") {
        session = null;
        accessToken = null;
        accessTokenExpiresAt = 0;
        authenticatedAccountKey = null;
        remove(storage, SESSION_KEY);
      }
      options.onError?.(error);
      setStatus("error");
      return false;
    } finally {
      syncStage = "idle";
      running = false;
      if (queued) {
        queued = false;
        schedule(250);
      }
    }
  }

  async function performSync() {
    syncStage = "account";
    const driveAccountKey = await getDriveAccountKey();
    const boundAccountKey = options.getBoundAccount?.() || null;
    if (boundAccountKey && boundAccountKey !== driveAccountKey) {
      if (!options.switchAccount) throw accountMismatchError();
      syncStage = "switch";
      await options.switchAccount(driveAccountKey);
    } else if (!boundAccountKey) {
      if (!options.bindAccount) throw accountMismatchError();
      await options.bindAccount(driveAccountKey);
    }
    if (options.getBoundAccount?.() !== driveAccountKey) throw syncError("account-switch");

    syncStage = "local";
    const local = await options.getWorkspace();
    syncStage = "prepare";
    const [localIndex, localFingerprint, files] = await Promise.all([
      indexSyncWorkspace(local),
      fingerprintSyncWorkspace(local),
      listDeviceFiles(),
    ]);
    syncStage = "download";
    const snapshots = await Promise.all(files.map(readSnapshot));
    const heads = cloudSnapshotHeads(snapshots);
    if (files.length > 0 && heads.length === 0) throw syncError("snapshot-heads");
    const ownFile = files
      .filter((file) => file.appProperties?.deviceId === deviceId)
      .sort((left, right) => String(right.modifiedTime).localeCompare(String(left.modifiedTime)))[0] || null;
    const migrateLegacyState = !boundAccountKey;
    const state = readState(storage, driveAccountKey, migrateLegacyState);

    if (heads.length === 0) {
      syncStage = "snapshot";
      const snapshot = await createCloudSnapshot(local, {
        deviceId,
        history: state.history,
        ancestorIds: state.lastSnapshotId ? [state.lastSnapshotId, ...(state.ancestors || [])] : [],
      });
      syncStage = "upload";
      const uploaded = await uploadSnapshot(snapshot, ownFile?.id);
      saveState(storage, stateFromSnapshot(snapshot, localFingerprint, uploaded.id), driveAccountKey, migrateLegacyState);
      return { conflicts: 0 };
    }

    syncStage = "merge";
    const combined = await combineHeads(heads);
    const remote = combined.snapshot;
    const remoteLineage = new Set(heads.flatMap((item) => [item.snapshotId, ...(item.ancestors || [])]));
    const remoteContainsLast = Boolean(state.lastSnapshotId && remoteLineage.has(state.lastSnapshotId));
    const localChanged = !state.lastFingerprint || localFingerprint !== state.lastFingerprint;
    let nextWorkspace = remote.workspace;
    let conflicts = combined.conflicts;
    let shouldUpload = heads.length > 1;

    if (!state.lastSnapshotId && isDisposableSyncWorkspace(local)) {
      shouldUpload = true;
    } else if (localChanged || !remoteContainsLast) {
      const localSnapshot = {
        snapshotId: state.lastSnapshotId || `local-${deviceId}`,
        ancestors: state.ancestors || [],
        history: state.history || [],
        index: localIndex,
        workspace: local,
      };
      const baseIndex = state.lastSnapshotId ? findCommonBaseIndex(localSnapshot, remote) : [];
      const merged = await mergeSyncWorkspaces(local, remote.workspace, baseIndex);
      nextWorkspace = merged.workspace;
      conflicts += merged.conflicts;
      shouldUpload = true;
    }

    const nextFingerprint = await fingerprintSyncWorkspace(nextWorkspace);
    if (nextFingerprint !== localFingerprint) {
      if (options.canApply && !options.canApply()) throw busyError();
      syncStage = "apply";
      await options.applyWorkspace(nextWorkspace, localFingerprint);
    }

    if (shouldUpload || !ownFile) {
      syncStage = "snapshot";
      const snapshot = await createCloudSnapshot(nextWorkspace, {
        deviceId,
        parents: heads,
        history: mergeSnapshotHistory(state.history || [], remote.history || []),
        ancestorIds: state.lastSnapshotId ? [state.lastSnapshotId, ...(state.ancestors || [])] : [],
      });
      syncStage = "upload";
      const uploaded = await uploadSnapshot(snapshot, ownFile?.id);
      saveState(storage, stateFromSnapshot(snapshot, nextFingerprint, uploaded.id), driveAccountKey, migrateLegacyState);
    } else {
      saveState(storage, stateFromSnapshot(heads[0], nextFingerprint, ownFile?.id), driveAccountKey, migrateLegacyState);
    }
    return { conflicts };
  }

  async function withSyncLock(action) {
    if (!locks?.request) return action();
    return locks.request(`${SYNC_LOCK_PREFIX}${deviceId}`, { ifAvailable: true }, (lock) => {
      if (!lock) throw busyError();
      return action();
    });
  }

  async function combineHeads(heads) {
    const ordered = [...heads].sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
    let current = ordered[0];
    let conflicts = 0;
    for (const next of ordered.slice(1)) {
      const baseIndex = findCommonBaseIndex(current, next);
      const merged = await mergeSyncWorkspaces(current.workspace, next.workspace, baseIndex);
      const index = await indexSyncWorkspace(merged.workspace);
      conflicts += merged.conflicts;
      current = {
        snapshotId: `combined-${globalThis.crypto.randomUUID()}`,
        ancestors: unique([
          current.snapshotId,
          ...(current.ancestors || []),
          next.snapshotId,
          ...(next.ancestors || []),
        ]),
        history: mergeSnapshotHistory(
          [{ snapshotId: current.snapshotId, index: current.index }],
          current.history || [],
          [{ snapshotId: next.snapshotId, index: next.index }],
          next.history || [],
        ),
        index,
        workspace: merged.workspace,
      };
    }
    return { snapshot: current, conflicts };
  }

  async function listDeviceFiles() {
    const files = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        spaces: "appDataFolder",
        q: `appProperties has { key='scattered' and value='${DRIVE_MARK}' } and trashed=false`,
        fields: "nextPageToken,files(id,name,modifiedTime,version,appProperties)",
        pageSize: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await driveRequest(`https://www.googleapis.com/drive/v3/files?${params}`);
      const payload = await response.json();
      files.push(...(Array.isArray(payload.files) ? payload.files : []));
      pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
    } while (pageToken);
    return files;
  }

  async function readSnapshot(file) {
    const response = await driveRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
    const encoded = await response.text();
    if (new TextEncoder().encode(encoded).byteLength > MAX_CLOUD_BYTES) throw syncError("snapshot-too-large");
    let value;
    try { value = JSON.parse(encoded); } catch { throw syncError("snapshot-invalid"); }
    if (!value || value.format !== CLOUD_SNAPSHOT_FORMAT || value.version !== CLOUD_SNAPSHOT_VERSION) {
      throw syncError("snapshot-invalid");
    }
    if (!validCloudToken(value.snapshotId) || !validCloudToken(value.deviceId)) throw syncError("snapshot-invalid");
    let workspace;
    try { workspace = parseSyncWorkspace(value.workspace); } catch { throw syncError("snapshot-invalid"); }
    const index = await indexSyncWorkspace(workspace);
    const history = mergeSnapshotHistory(
      [{ snapshotId: value.snapshotId, index }],
      Array.isArray(value.history) ? value.history.filter((item) => validCloudToken(item?.snapshotId)) : [],
    );
    return {
      snapshotId: value.snapshotId,
      deviceId: value.deviceId,
      createdAt: Number(value.createdAt) || 0,
      ancestors: unique(Array.isArray(value.ancestors) ? value.ancestors.filter(validCloudToken) : []).slice(0, 48),
      history,
      index,
      workspace,
      file,
    };
  }

  async function uploadSnapshot(snapshot, fileId) {
    const encoded = JSON.stringify(snapshot);
    if (new TextEncoder().encode(encoded).byteLength > MAX_CLOUD_BYTES) throw syncError("too-large");
    const metadata = {
      name: `scattered-workspace-${deviceId}.json`,
      mimeType: "application/json",
      appProperties: { scattered: DRIVE_MARK, deviceId },
      ...(!fileId ? { parents: ["appDataFolder"] } : {}),
    };
    const path = fileId ? `/upload/drive/v3/files/${encodeURIComponent(fileId)}` : "/upload/drive/v3/files";
    const response = await driveRequest(`https://www.googleapis.com${path}?uploadType=resumable&fields=id,modifiedTime,version`, {
      method: fileId ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/json",
        "X-Upload-Content-Length": String(new TextEncoder().encode(encoded).byteLength),
      },
      body: JSON.stringify(metadata),
    });
    const location = response.headers.get("Location");
    if (!location) throw syncError("upload-session");
    const uploaded = await driveRequest(location, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: encoded,
    });
    const result = await uploaded.json();
    if (!result.id && !fileId) throw syncError("upload-result");
    return { ...result, id: result.id || fileId };
  }

  async function driveRequest(url, init = {}, retry = true) {
    const token = await getAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetcher(url, { ...init, headers });
    if (response.status === 401 && retry) {
      accessToken = null;
      accessTokenExpiresAt = 0;
      return driveRequest(url, init, false);
    }
    if (!response.ok) throw syncError(`drive-${response.status}`);
    return response;
  }

  async function getAccessToken() {
    if (accessToken && accessTokenExpiresAt > clock() + 30_000) return accessToken;
    const response = await fetcher(`${apiUrl}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session}` },
    });
    if (response.status === 401 || response.status === 403) throw authError();
    if (!response.ok) throw syncError(`broker-${response.status}`);
    const payload = await response.json();
    if (typeof payload.accessToken !== "string" || !payload.accessToken) throw syncError("broker-response");
    accessToken = payload.accessToken;
    accessTokenExpiresAt = clock() + Math.max(30, Number(payload.expiresIn) || 300) * 1_000;
    if (validSession(payload.session)) {
      session = payload.session;
      write(storage, SESSION_KEY, session);
    }
    return accessToken;
  }

  async function getDriveAccountKey() {
    if (authenticatedAccountKey) return authenticatedAccountKey;
    const response = await driveRequest("https://www.googleapis.com/drive/v3/about?fields=user(permissionId)");
    let payload;
    try { payload = await response.json(); } catch { throw syncError("account-identity"); }
    const permissionId = payload?.user?.permissionId;
    if (typeof permissionId !== "string" || !permissionId || permissionId.length > 512) {
      throw syncError("account-identity");
    }
    authenticatedAccountKey = await accountFingerprint(permissionId);
    return authenticatedAccountKey;
  }

  function consumeAuthFragment() {
    const hash = String(globalThis.location?.hash || "");
    if (!hash.startsWith("#")) return {};
    const params = new URLSearchParams(hash.slice(1));
    const nextSession = params.get("scattered-drive-session");
    const error = params.get("scattered-drive-error");
    if (!nextSession && !error) return {};
    globalThis.history?.replaceState?.(null, "", `${globalThis.location.pathname}${globalThis.location.search}`);
    return { session: nextSession || null, error: error || null };
  }

  function setStatus(status) {
    options.onStatus?.(status, Boolean(session));
  }

  function onWake() {
    if (session) schedule(150);
  }

  function onVisibilityChange() {
    if (globalThis.document?.visibilityState === "visible") onWake();
  }
}

function readState(storage, accountKey, allowLegacy = false) {
  try {
    const scoped = storage.getItem(stateStorageKey(accountKey));
    const encoded = scoped ?? (allowLegacy ? storage.getItem(STATE_KEY) : null);
    const value = JSON.parse(encoded);
    if (!value || value.version !== 1) return emptyState();
    return {
      version: 1,
      lastSnapshotId: validCloudToken(value.lastSnapshotId) ? value.lastSnapshotId : null,
      lastFingerprint: typeof value.lastFingerprint === "string" ? value.lastFingerprint : null,
      ancestors: unique(Array.isArray(value.ancestors) ? value.ancestors.filter(validCloudToken) : []).slice(0, 48),
      history: Array.isArray(value.history) ? value.history.flatMap((entry) => (
        validCloudToken(entry?.snapshotId) && parseSyncIndex(entry.index).length > 0
          ? [{ snapshotId: entry.snapshotId, index: parseSyncIndex(entry.index) }]
          : []
      )).slice(0, 8) : [],
      fileId: typeof value.fileId === "string" ? value.fileId : null,
    };
  } catch {
    return emptyState();
  }
}

function stateFromSnapshot(snapshot, fingerprint, fileId) {
  return {
    version: 1,
    lastSnapshotId: snapshot.snapshotId,
    lastFingerprint: fingerprint,
    ancestors: snapshot.ancestors || [],
    history: snapshot.history || [],
    fileId: fileId || null,
  };
}

function saveState(storage, state, accountKey, removeLegacy = false) {
  const key = stateStorageKey(accountKey);
  let saved = false;
  try {
    storage.setItem(key, JSON.stringify(state));
    saved = true;
  } catch {
    try {
      storage.setItem(key, JSON.stringify({ ...state, history: (state.history || []).slice(0, 2) }));
      saved = true;
    } catch {}
  }
  if (!saved) throw syncError("state-storage");
  if (removeLegacy) remove(storage, STATE_KEY);
}

function stateStorageKey(accountKey) {
  return `${STATE_KEY}:${accountKey}`;
}

function emptyState() {
  return { version: 1, lastSnapshotId: null, lastFingerprint: null, ancestors: [], history: [], fileId: null };
}

function readOrCreateDeviceId(storage) {
  const existing = read(storage, DEVICE_KEY);
  if (validCloudToken(existing)) return existing;
  const id = globalThis.crypto.randomUUID();
  write(storage, DEVICE_KEY, id);
  return id;
}

async function accountFingerprint(value) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`scattered-drive-account-v1:${value}`),
  ));
  return `gdrive-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function read(storage, key) {
  try { return storage.getItem(key) || ""; } catch { return ""; }
}

function write(storage, key, value) {
  try { storage.setItem(key, value); } catch {}
}

function remove(storage, key) {
  try { storage.removeItem(key); } catch {}
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function validCloudToken(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function validSession(value) {
  return typeof value === "string"
    && value.length <= 8_192
    && /^v1\.[A-Za-z0-9_-]+$/.test(value);
}

function syncError(reason) {
  const error = new Error(`Drive sync failed: ${reason}`);
  error.code = "sync";
  return error;
}

function authError() {
  const error = new Error("Drive authorization expired");
  error.code = "auth";
  return error;
}

function accountMismatchError() {
  const error = new Error("Drive account does not match this workspace");
  error.code = "account";
  return error;
}

function busyError() {
  const error = new Error("Workspace is busy");
  error.code = "busy";
  return error;
}
