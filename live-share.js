import { SHARE_ID, SHARE_TOKEN, encodeSharedBoard } from "./share-model.js";

const KEY = "scattered-live-shares-v1:";

export function createLiveShare({ apiUrl, storage, getScope, getBoards, onStatus = () => {}, fetcher = fetch }) {
  let queue = Promise.resolve();
  const states = new Map();
  const scopeKey = (scope) => KEY + scope;
  const records = (scope) => {
    const value = JSON.parse(storage.getItem(scopeKey(scope)) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shareStorage");
    for (const record of Object.values(value)) {
      if (!SHARE_ID.test(record?.id) || !SHARE_TOKEN.test(record?.token)
        || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error("shareStorage");
    }
    return value;
  };
  const write = (scope, boardId, record) => {
    const next = records(scope);
    if (record) next[boardId] = record;
    else delete next[boardId];
    const encoded = JSON.stringify(next);
    storage.setItem(scopeKey(scope), encoded);
    if (storage.getItem(scopeKey(scope)) !== encoded) throw new Error("shareStorage");
  };
  const status = (scope, id, message) => {
    states.set(`${scope}:${id}`, message);
    if (scope === getScope()) onStatus(id, message);
  };
  const run = (action) => {
    const next = queue.catch(() => {}).then(() => globalThis.navigator?.locks?.request
      ? navigator.locks.request("scattered-live-shares", action) : action());
    queue = next;
    return next;
  };
  const call = async (record, method, body) => {
    const response = await fetcher(`${apiUrl}/shares/${record.id}`, {
      method,
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${record.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(method === "PUT" ? { "If-Match": `"${record.revision}"` } : {}),
      },
      ...(body ? { body } : {}),
    });
    if (response.status === 204) return null;
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "shareUnavailable");
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("shareInvalid");
    return value;
  };

  async function publish(scope, boardId, create = false) {
    if (scope !== getScope()) return;
    let record = records(scope)[boardId];
    if (!record || record.blocked) return;
    if (!record.revision && !create) return;
    try {
      const item = getBoards().find((item) => item.id === boardId);
      if (!item) {
        await revoke(scope, boardId); // Also handles deletions arriving through Drive or another tab.
        return;
      }
      const payload = encodeSharedBoard(item.board, item.connectionStyle);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      if (record.fingerprint === digest) { status(scope, boardId, "shareLive"); return; }
      status(scope, boardId, "shareUploading");
      if (!record.revision) {
        if (!create) return; // An unsuccessful first upload needs explicit retry, not surprise publication later.
        const result = await call(record, "POST", payload);
        record = { ...record, revision: result.revision };
        write(scope, boardId, record);
      }
      const result = await call(record, "PUT", payload);
      write(scope, boardId, { ...record, revision: result.revision, fingerprint: digest });
      status(scope, boardId, "shareLive");
    } catch (error) {
      if (["shareConflict", "shareForbidden", "shareMissing"].includes(error.message)) {
        write(scope, boardId, { ...record, blocked: true });
      }
      status(scope, boardId, error.message);
      throw error;
    }
  }

  async function revoke(scope, boardId) {
    const record = records(scope)[boardId];
    if (!record) return;
    status(scope, boardId, "shareStopping");
    try {
      await call(record, "DELETE");
      write(scope, boardId, null);
      status(scope, boardId, "shareOff");
    } catch (error) {
      status(scope, boardId, "shareStopFailed");
      throw error;
    }
  }

  return {
    get available() { return Boolean(apiUrl); },
    current(boardId) {
      const record = records(getScope())[boardId];
      return record ? { id: record.id, ready: record.revision > 0, blocked: Boolean(record.blocked) } : null;
    },
    state(boardId) { return states.get(`${getScope()}:${boardId}`) || (this.current(boardId)?.ready ? "shareLive" : "shareOff"); },
    enable(boardId) {
      const scope = getScope();
      return run(async () => {
        if (!apiUrl) throw new Error("shareUnavailable");
        if (scope !== getScope()) throw new Error("shareUnavailable");
        if (!getBoards().some((item) => item.id === boardId)) throw new Error("shareMissing");
        if (!records(scope)[boardId]) {
          const hex = () => crypto.randomUUID().replaceAll("-", "");
          // Persist the write capability BEFORE any upload. It never enters links or board exports.
          write(scope, boardId, { id: hex(), token: hex() + hex(), revision: 0 });
        }
        await publish(scope, boardId, true);
      });
    },
    stop(boardId) {
      const scope = getScope();
      return run(() => revoke(scope, boardId));
    },
    update() {
      const scope = getScope();
      return run(async () => {
        if (!apiUrl || scope !== getScope()) return;
        for (const boardId of Object.keys(records(scope))) {
          try { await publish(scope, boardId); } catch { /* Status remains visible; retry after connectivity returns. */ }
        }
      });
    },
  };
}
