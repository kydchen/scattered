import { BOARD_VERSION, blankBoard, createId, normalizeBoard, parseImportedBoard } from "./model.js";

const LEGACY_BOARD_KEY = "scattered-board-v1";
const LEGACY_WORKSPACE_KEY = "scattered-workspace-v1";
const LEGACY_WORKSPACE_BACKUP_KEY = "scattered-workspace-backup-v1";
const LEGACY_BOARD_PREFIX = "scattered-document-v1:";
const LEGACY_BACKUP_PREFIX = "scattered-document-backup-v1:";
const LEGACY_RECOVERY_KEY = "scattered-recovery-v1";
const WORKSPACE_KEY = "scattered-workspace-v2";
const WORKSPACE_BACKUP_KEY = "scattered-workspace-backup-v2";
const BOARD_PREFIX = "scattered-document-v2:";
const BACKUP_PREFIX = "scattered-document-backup-v2:";
const RECOVERY_KEY = "scattered-recovery-v2";
const MIGRATION_KEY = "scattered-storage-v2-ready";
const WORKSPACE_LOCK_NAME = "scattered-workspace-v2";
const PENDING_PREFIX = "scattered-pending-document-v2:";
const PENDING_FORMAT = "scattered-pending-document";
const PENDING_STORAGE_VERSION = 1;
const PENDING_SESSION_ID = createId();
const PENDING_KEY = `${PENDING_PREFIX}${PENDING_SESSION_ID}`;
const IMPORT_JOURNAL_PREFIX = "scattered-import-journal-v1:";
const IMPORT_JOURNAL_STALE_MS = 2 * 60 * 1000;
const WORKSPACE_EXPORT_FORMAT = "scattered-workspace";
const MAX_RECOVERY = 5;
const DOCUMENT_FORMAT = "scattered-document";
const DOCUMENT_STORAGE_VERSION = 1;
export const MAX_WORKSPACE_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_WORKSPACE_IMPORT_BOARDS = 1_000;
export const MAX_WORKSPACE_IMPORT_NODES = 20_000;
export const MAX_WORKSPACE_IMPORT_EDGES = 40_000;

export function withWorkspaceLock(action) {
  const locks = globalThis.navigator?.locks;
  if (locks?.request) return locks.request(WORKSPACE_LOCK_NAME, action);
  // ponytail: Without native locks, cross-tab safety relies on revision checks and conflict copies.
  return Promise.resolve().then(action);
}

export function stagePendingDocument(storage, workspace, board, now = Date.now) {
  const boardId = workspace.activeId;
  const expectedRevision = workspace.boards.find((item) => item.id === boardId)?.revision ?? null;
  storage.setItem(PENDING_KEY, JSON.stringify({
    format: PENDING_FORMAT,
    storageVersion: PENDING_STORAGE_VERSION,
    id: createId(),
    sessionId: PENDING_SESSION_ID,
    boardId,
    expectedRevision,
    board: normalizeBoard(board),
    savedAt: now(),
  }));
}

export function clearPendingDocument(storage = localStorage) {
  removePendingKey(storage, PENDING_KEY);
}

export function loadWorkspace(storage = localStorage, now = Date.now) {
  cleanupInterruptedImports(storage, now);
  const workspace = readWorkspace(storage) || initializeV2Storage(storage, now);
  markV2Ready(storage);
  recoverPendingDocuments(storage, workspace, now);
  const activeId = workspace.boards.some((item) => item.id === workspace.activeId)
    ? workspace.activeId
    : workspace.boards[0]?.id;
  workspace.activeId = activeId;
  const loaded = readDocument(storage, activeId);
  if (loaded.board) {
    updateMetadata(workspace, activeId, loaded.board.title, undefined, loaded.revision);
    writeWorkspace(storage, workspace);
    return { workspace, board: loaded.board, recovered: loaded.recovered };
  }
  const board = blankBoard();
  const saved = saveDocument(storage, workspace, board, now);
  return { workspace, board: saved, recovered: false };
}

export function createWorkspaceBackup(storage, workspace, currentBoard) {
  const latest = mergeWorkspace(storage, workspace);
  const current = normalizeBoard(currentBoard);
  const expectedRevision = workspace.boards.find((item) => item.id === workspace.activeId)?.revision ?? null;
  const storedCurrent = readDocument(storage, workspace.activeId);
  let activeBoard = latest.boards.findIndex((item) => item.id === workspace.activeId);
  const boards = latest.boards.map((item) => {
    const loaded = readDocument(storage, item.id).board;
    if (!loaded) throw new Error("export.invalidWorkspace");
    return loaded;
  });
  const canReplaceStored = activeBoard >= 0 && (
    (expectedRevision !== null && expectedRevision === storedCurrent.revision)
    || (storedCurrent.board && boardsMatch(storedCurrent.board, current))
  );
  if (canReplaceStored) {
    boards[activeBoard] = current;
  } else {
    const title = availableTitle(current.title, boards.map((candidate) => candidate.title));
    boards.unshift(normalizeBoard({ ...current, title }));
    activeBoard = 0;
  }
  const backup = { format: WORKSPACE_EXPORT_FORMAT, version: 1, activeBoard, boards };
  validateWorkspaceContents(boards, "export.invalidWorkspace");
  if (new TextEncoder().encode(JSON.stringify(backup, null, 2)).byteLength > MAX_WORKSPACE_IMPORT_BYTES) {
    throw new Error("export.invalidWorkspace");
  }
  return backup;
}

export function parseImportedWorkspace(encoded) {
  if (typeof encoded !== "string") throw new Error("import.invalid");
  if (new TextEncoder().encode(encoded).byteLength > MAX_WORKSPACE_IMPORT_BYTES) {
    throw new Error("import.workspaceTooLarge");
  }
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.format !== WORKSPACE_EXPORT_FORMAT) return null;
  if (value.version !== 1) throw new Error("import.unsupportedVersion");
  if (!Array.isArray(value.boards)
    || value.boards.length === 0
    || value.boards.length > MAX_WORKSPACE_IMPORT_BOARDS
    || !Number.isInteger(value.activeBoard)
    || value.activeBoard < 0
    || value.activeBoard >= value.boards.length) throw new Error("import.tooMuchContent");
  const boards = value.boards.map((candidate) => parseImportedBoard(JSON.stringify(candidate), {
    maxBytes: MAX_WORKSPACE_IMPORT_BYTES,
    maxNodes: Infinity,
    maxEdges: Infinity,
  }));
  validateWorkspaceContents(boards, "import.tooMuchContent");
  return { activeBoard: value.activeBoard, boards };
}

export function addImportedWorkspace(storage, workspace, imported, now = Date.now) {
  if (!isPlainObject(imported)
    || !Array.isArray(imported.boards)
    || imported.boards.length === 0
    || imported.boards.length > MAX_WORKSPACE_IMPORT_BOARDS
    || !Number.isInteger(imported.activeBoard)
    || imported.activeBoard < 0
    || imported.activeBoard >= imported.boards.length) throw new Error("import.invalid");
  validateWorkspaceContents(imported.boards, "import.tooMuchContent");

  const nextWorkspace = mergeWorkspace(storage, workspace);
  const titles = nextWorkspace.boards.map((item) => item.title);
  const savedAt = now();
  const additions = imported.boards.map((candidate, index) => {
    const title = availableTitle(candidate.title, titles);
    titles.push(title);
    const board = normalizeBoard({ ...candidate, title });
    return { id: createId(), board, updatedAt: savedAt + index, revision: createId() };
  });
  const previousWorkspace = storage.getItem(WORKSPACE_KEY);
  const previousWorkspaceBackup = storage.getItem(WORKSPACE_BACKUP_KEY);
  const previousDocuments = additions.map(({ id }) => ({
    id,
    primary: storage.getItem(boardKey(id)),
    backup: storage.getItem(backupKey(id)),
  }));
  const importId = createId();
  const journalKey = `${IMPORT_JOURNAL_PREFIX}${importId}`;

  try {
    storage.setItem(journalKey, JSON.stringify({
      format: "scattered-import",
      version: 1,
      id: importId,
      startedAt: savedAt,
      ids: additions.map((item) => item.id),
    }));
    additions.forEach(({ id, board, revision, updatedAt }) => {
      storage.setItem(boardKey(id), encodeDocument(board, revision, updatedAt));
    });
    nextWorkspace.boards = [
      ...additions.map(({ id, board, updatedAt, revision }) => ({ id, title: board.title, updatedAt, revision })),
      ...nextWorkspace.boards,
    ];
    nextWorkspace.activeId = additions[imported.activeBoard].id;
    writeWorkspaceCopies(storage, nextWorkspace);
    removeImportJournal(storage, journalKey);
  } catch (error) {
    let restored = true;
    previousDocuments.forEach(({ id, primary, backup }) => {
      restored = restoreStorageItem(storage, boardKey(id), primary) && restored;
      restored = restoreStorageItem(storage, backupKey(id), backup) && restored;
    });
    restored = restoreStorageItem(storage, WORKSPACE_KEY, previousWorkspace) && restored;
    restored = restoreStorageItem(storage, WORKSPACE_BACKUP_KEY, previousWorkspaceBackup) && restored;
    if (restored) removeImportJournal(storage, journalKey);
    throw error;
  }
  applyWorkspace(workspace, nextWorkspace);
  return additions[imported.activeBoard].board;
}

export function saveDocument(storage, workspace, board, now = Date.now, options = {}) {
  const normalized = normalizeBoard(board);
  const id = workspace.activeId;
  const expectedRevision = workspace.boards.find((item) => item.id === id)?.revision ?? null;
  const nextWorkspace = mergeWorkspace(storage, workspace);
  const stored = readDocument(storage, id);
  const actualRevision = stored.revision ?? null;
  const sameBoard = stored.board ? boardsMatch(stored.board, normalized) : false;
  const sameContent = stored.board ? boardContentMatches(stored.board, normalized) : false;
  const latestItem = nextWorkspace.boards.find((item) => item.id === id);
  const deleted = nextWorkspace.tombstones.some((item) => item.id === id);

  const revisionConflict = expectedRevision !== actualRevision && !sameContent;
  if (deleted || (revisionConflict && (latestItem || options.forceConflictOnRevisionMismatch))) {
    return saveConflictCopy(storage, workspace, nextWorkspace, normalized, now, options.pendingId);
  }

  const savedAt = sameBoard && Number.isFinite(latestItem?.updatedAt) ? latestItem.updatedAt : now();
  const primary = readPrimaryDocument(storage, id);
  const revision = sameBoard && primary?.revision ? primary.revision : createId();
  ensureMetadata(nextWorkspace, id, normalized.title, savedAt, revision);
  nextWorkspace.activeId = id;
  if (!sameBoard || !primary?.revision) {
    const shouldRecover = typeof options.recoveryReason === "string"
      && options.recoveryReason
      && stored.board
      && !sameContent;
    const previousRecovery = shouldRecover ? storage.getItem(RECOVERY_KEY) : null;
    try {
      if (shouldRecover) captureRecovery(storage, id, stored.board, options.recoveryReason, now);
      persistDocument(storage, id, normalized, revision, savedAt, nextWorkspace, options.pendingId);
    } catch (error) {
      if (shouldRecover) restoreStorageItem(storage, RECOVERY_KEY, previousRecovery);
      throw error;
    }
  } else {
    writeWorkspace(storage, nextWorkspace);
  }
  applyWorkspace(workspace, nextWorkspace);
  return normalized;
}

export function replaceDocument(storage, workspace, nextBoard, reason, now = Date.now) {
  return saveDocument(storage, workspace, nextBoard, now, { recoveryReason: reason || "replace" });
}

export function createDocument(storage, workspace, board = blankBoard(), now = Date.now) {
  const id = createId();
  const normalized = normalizeBoard(board);
  const nextWorkspace = mergeWorkspace(storage, workspace);
  const savedAt = now();
  const revision = createId();
  nextWorkspace.activeId = id;
  nextWorkspace.boards.unshift({ id, title: normalized.title, updatedAt: savedAt, revision });
  persistNewDocument(storage, id, normalized, revision, savedAt, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  return normalized;
}

export function switchDocument(storage, workspace, id) {
  const nextWorkspace = mergeWorkspace(storage, workspace);
  if (!nextWorkspace.boards.some((item) => item.id === id)) return null;
  const loaded = readDocument(storage, id);
  if (!loaded.board) return null;
  nextWorkspace.activeId = id;
  updateMetadata(nextWorkspace, id, loaded.board.title, undefined, loaded.revision);
  writeWorkspace(storage, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  return loaded;
}

export function duplicateDocument(storage, workspace, board, now = Date.now) {
  const latest = mergeWorkspace(storage, workspace);
  const copy = normalizeBoard({ ...board, title: copyTitle(board.title, latest.boards.map((item) => item.title)) });
  return createDocument(storage, workspace, copy, now);
}

export function deleteDocument(storage, workspace, now = Date.now) {
  const removedId = workspace.activeId;
  const nextWorkspace = mergeWorkspace(storage, workspace);
  if (nextWorkspace.tombstones.some((item) => item.id === removedId)) {
    const current = readDocument(storage, nextWorkspace.activeId).board;
    if (!current) throw new Error("The active board is unavailable");
    applyWorkspace(workspace, nextWorkspace);
    return current;
  }

  const removed = readDocument(storage, removedId);
  if (nextWorkspace.boards.some((item) => item.id === removedId) && !removed.board) {
    throw new Error("The board to delete is unavailable");
  }
  if (nextWorkspace.boards.length === 1
    && nextWorkspace.boards[0].id === removedId
    && removed.board
    && boardContentMatches(removed.board, blankBoard())) {
    applyWorkspace(workspace, nextWorkspace);
    return removed.board;
  }

  const previousRecovery = storage.getItem(RECOVERY_KEY);
  const previousWorkspace = storage.getItem(WORKSPACE_KEY);
  const previousWorkspaceBackup = storage.getItem(WORKSPACE_BACKUP_KEY);
  let nextBoard;
  let createdId = null;
  let previousCreatedDocument = null;
  try {
    if (removed.board) captureRecovery(storage, removedId, removed.board, "delete", now);
    const deletedAt = now();
    nextWorkspace.boards = nextWorkspace.boards.filter((item) => item.id !== removedId);
    nextWorkspace.tombstones = mergeTombstones(nextWorkspace.tombstones, [{ id: removedId, deletedAt }]);
    if (nextWorkspace.boards.length === 0) {
      const id = createId();
      createdId = id;
      nextBoard = blankBoard();
      const savedAt = now();
      const revision = createId();
      nextWorkspace.activeId = id;
      nextWorkspace.boards = [{ id, title: nextBoard.title, updatedAt: savedAt, revision }];
      previousCreatedDocument = storage.getItem(boardKey(id));
      storage.setItem(boardKey(id), encodeDocument(nextBoard, revision, savedAt));
    } else {
      nextWorkspace.activeId = nextWorkspace.boards[0].id;
      const loaded = readDocument(storage, nextWorkspace.activeId);
      nextBoard = loaded.board;
      if (!nextBoard) throw new Error("The next board is unavailable");
      updateMetadata(nextWorkspace, nextWorkspace.activeId, nextBoard.title, loaded.updatedAt, loaded.revision);
    }
    writeWorkspaceCopies(storage, nextWorkspace);
  } catch (error) {
    if (createdId) restoreStorageItem(storage, boardKey(createdId), previousCreatedDocument);
    restoreStorageItem(storage, RECOVERY_KEY, previousRecovery);
    restoreStorageItem(storage, WORKSPACE_KEY, previousWorkspace);
    restoreStorageItem(storage, WORKSPACE_BACKUP_KEY, previousWorkspaceBackup);
    throw error;
  }
  applyWorkspace(workspace, nextWorkspace);
  try { storage.removeItem(boardKey(removedId)); } catch {}
  try { storage.removeItem(backupKey(removedId)); } catch {}
  return nextBoard;
}

export function captureRecovery(storage, boardId, board, reason, now = Date.now) {
  const entries = readRecovery(storage);
  const normalized = normalizeBoard(board);
  if (entries[0]
    && entries[0].boardId === boardId
    && entries[0].reason === reason
    && boardsMatch(entries[0].board, normalized)) return;
  entries.unshift({ id: createId(), boardId, board: normalized, reason, savedAt: now() });
  writeRecovery(storage, entries.slice(0, MAX_RECOVERY));
}

export function restoreLatest(storage, workspace, _currentBoard, now = Date.now) {
  const entries = readRecovery(storage);
  const entry = entries[0];
  if (!entry) return null;
  const nextWorkspace = mergeWorkspace(storage, workspace);
  const id = createId();
  const savedAt = now();
  const revision = createId();
  const title = availableTitle(entry.board.title, nextWorkspace.boards.map((item) => item.title));
  const restored = normalizeBoard({ ...entry.board, title });
  nextWorkspace.activeId = id;
  nextWorkspace.boards.unshift({ id, title: restored.title, updatedAt: savedAt, revision });
  persistNewDocument(storage, id, restored, revision, savedAt, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  try {
    writeRecovery(storage, readRecovery(storage).filter((candidate) => candidate.id !== entry.id));
  } catch {
    // A duplicate recovery is safer than losing the restored board.
  }
  return restored;
}

export function hasRecovery(storage = localStorage) {
  return readRecovery(storage).length > 0;
}

function initializeV2Storage(storage, now) {
  if (storage.getItem(MIGRATION_KEY) === "1") {
    return rebuildWorkspaceFromDocuments(storage) || createInitialWorkspace(storage, blankBoard(), now);
  }
  return migrateV1Storage(storage, now);
}

function migrateV1Storage(storage, now) {
  const legacyWorkspace = parseWorkspace(storage.getItem(LEGACY_WORKSPACE_KEY))
    || parseWorkspace(storage.getItem(LEGACY_WORKSPACE_BACKUP_KEY));
  const legacyItems = new Map((legacyWorkspace?.boards || []).map((item) => [item.id, item]));
  const legacyIds = [
    ...(legacyWorkspace?.boards || []).map((item) => item.id),
    ...listDocumentIds(storage, LEGACY_BOARD_PREFIX, LEGACY_BACKUP_PREFIX),
  ];
  const seen = new Set();
  const boards = [];
  legacyIds.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const loaded = readDocumentAt(storage, id, LEGACY_BOARD_PREFIX, LEGACY_BACKUP_PREFIX);
    if (!loaded.board) return;
    const item = legacyItems.get(id);
    const updatedAt = loaded.updatedAt || item?.updatedAt || now();
    const revision = loaded.revision || item?.revision || createId();
    storage.setItem(boardKey(id), encodeDocument(loaded.board, revision, updatedAt));
    const legacyBackup = parseDocument(storage.getItem(`${LEGACY_BACKUP_PREFIX}${id}`));
    if (legacyBackup) {
      storage.setItem(backupKey(id), encodeDocument(
        legacyBackup.board,
        legacyBackup.revision || createId(),
        legacyBackup.updatedAt || updatedAt,
      ));
    }
    boards.push({ id, title: loaded.board.title, updatedAt, revision });
  });

  const legacyRecoveryEncoded = storage.getItem(LEGACY_RECOVERY_KEY);
  if (legacyRecoveryEncoded !== null) writeRecovery(storage, parseRecovery(legacyRecoveryEncoded));
  if (boards.length === 0) {
    const legacy = parseDocument(storage.getItem(LEGACY_BOARD_KEY));
    return createInitialWorkspace(storage, legacy?.board || blankBoard(), now);
  }

  const tombstones = mergeTombstones([], legacyWorkspace?.tombstones || []);
  const deletedIds = new Set(tombstones.map((item) => item.id));
  const liveBoards = boards.filter((item) => !deletedIds.has(item.id));
  if (liveBoards.length === 0) return createInitialWorkspace(storage, blankBoard(), now);
  const activeId = liveBoards.some((item) => item.id === legacyWorkspace?.activeId)
    ? legacyWorkspace.activeId
    : liveBoards[0].id;
  const workspace = { version: 1, activeId, boards: liveBoards, tombstones };
  writeWorkspace(storage, workspace);
  return workspace;
}

function createInitialWorkspace(storage, board, now) {
  const normalized = normalizeBoard(board);
  const id = createId();
  const savedAt = now();
  const revision = createId();
  const workspace = {
    version: 1,
    activeId: id,
    boards: [{ id, title: normalized.title, updatedAt: savedAt, revision }],
    tombstones: [],
  };
  storage.setItem(boardKey(id), encodeDocument(normalized, revision, savedAt));
  writeWorkspace(storage, workspace);
  return workspace;
}

function readWorkspace(storage) {
  const primary = parseWorkspace(storage.getItem(WORKSPACE_KEY));
  if (primary) return primary;
  const backup = parseWorkspace(storage.getItem(WORKSPACE_BACKUP_KEY));
  return backup ? reattachWorkspaceDocuments(storage, backup) : null;
}

function parseWorkspace(encoded) {
  try {
    const value = JSON.parse(encoded);
    if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.boards)) return null;
    const ids = new Set();
    const boards = value.boards.flatMap((item) => {
      if (!isPlainObject(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)) return [];
      ids.add(item.id);
      return [{
        id: item.id,
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : "Untitled",
        updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : 0,
        revision: typeof item.revision === "string" && item.revision ? item.revision : null,
      }];
    });
    const tombstones = mergeTombstones([], Array.isArray(value.tombstones) ? value.tombstones : []);
    const deletedIds = new Set(tombstones.map((item) => item.id));
    const liveBoards = boards.filter((item) => !deletedIds.has(item.id));
    if (liveBoards.length === 0) return null;
    const activeId = liveBoards.some((item) => item.id === value.activeId) ? value.activeId : liveBoards[0].id;
    return { version: 1, activeId, boards: liveBoards, tombstones };
  } catch {
    return null;
  }
}

function rebuildWorkspaceFromDocuments(storage) {
  return reattachWorkspaceDocuments(storage, {
    version: 1,
    activeId: null,
    boards: [],
    tombstones: [],
  });
}

function reattachWorkspaceDocuments(storage, workspace) {
  const next = cloneWorkspace(workspace);
  const deletedIds = new Set(next.tombstones.map((item) => item.id));
  const indexedIds = new Set();
  const boards = [];
  const candidates = [
    ...next.boards.map((item) => item.id),
    ...listDocumentIds(storage, BOARD_PREFIX, BACKUP_PREFIX),
  ];
  candidates.forEach((id) => {
    if (indexedIds.has(id) || deletedIds.has(id)) return;
    indexedIds.add(id);
    const loaded = readDocument(storage, id);
    if (!loaded.board) return;
    const item = next.boards.find((candidate) => candidate.id === id);
    boards.push({
      id,
      title: loaded.board.title,
      updatedAt: loaded.updatedAt || item?.updatedAt || 0,
      revision: loaded.revision || item?.revision || null,
    });
  });
  boards.sort((left, right) => right.updatedAt - left.updatedAt);
  if (boards.length === 0) return null;
  next.boards = boards;
  next.activeId = boards.some((item) => item.id === workspace.activeId) ? workspace.activeId : boards[0].id;
  return next;
}

function listDocumentIds(storage, primaryPrefix, backupPrefix) {
  const ids = new Set();
  listStorageKeys(storage, [primaryPrefix, backupPrefix]).forEach((key) => {
    if (key.startsWith(primaryPrefix) && key.length > primaryPrefix.length) ids.add(key.slice(primaryPrefix.length));
    if (key.startsWith(backupPrefix) && key.length > backupPrefix.length) ids.add(key.slice(backupPrefix.length));
  });
  return [...ids];
}

function listStorageKeys(storage, prefixes) {
  try {
    if (typeof storage.key !== "function") return [];
    const length = Number(storage.length);
    if (!Number.isFinite(length)) return [];
    const keys = [];
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function markV2Ready(storage) {
  try {
    if (storage.getItem(MIGRATION_KEY) !== "1") storage.setItem(MIGRATION_KEY, "1");
  } catch {
    // The v2 workspace is already authoritative; a marker failure must not blank the loaded board.
  }
}

function recoverPendingDocuments(storage, workspace, now) {
  listStorageKeys(storage, [PENDING_PREFIX]).forEach((key) => {
    try {
      const pending = parsePendingDocument(storage.getItem(key), key.slice(PENDING_PREFIX.length));
      if (!pending) {
        removePendingKey(storage, key);
        return;
      }
      if (pendingAlreadyApplied(storage, workspace, pending)) {
        removePendingKey(storage, key);
        return;
      }
      const candidate = cloneWorkspace(workspace);
      candidate.activeId = pending.boardId;
      const item = candidate.boards.find((entry) => entry.id === pending.boardId);
      if (item) item.revision = pending.expectedRevision;
      else candidate.boards.unshift({
        id: pending.boardId,
        title: pending.board.title,
        updatedAt: pending.savedAt,
        revision: pending.expectedRevision,
      });
      saveDocument(storage, candidate, pending.board, () => pending.savedAt || now(), {
        forceConflictOnRevisionMismatch: true,
        pendingId: pending.id,
      });
      applyWorkspace(workspace, candidate);
      removePendingKey(storage, key);
    } catch {
      // Keep the journal and the already-loaded workspace for the next startup attempt.
    }
  });
}

function parsePendingDocument(encoded, keyId) {
  try {
    const value = JSON.parse(encoded);
    if (!isPlainObject(value)
      || value.format !== PENDING_FORMAT
      || value.storageVersion !== PENDING_STORAGE_VERSION
      || typeof value.id !== "string"
      || !value.id
      || value.sessionId !== keyId
      || typeof value.boardId !== "string"
      || !value.boardId
      || (value.expectedRevision !== null && (typeof value.expectedRevision !== "string" || !value.expectedRevision))) return null;
    const board = parseStoredBoard(value.board);
    if (!board) return null;
    return {
      id: value.id,
      boardId: value.boardId,
      expectedRevision: value.expectedRevision,
      board,
      savedAt: Number.isFinite(Number(value.savedAt)) ? Number(value.savedAt) : 0,
    };
  } catch {
    return null;
  }
}

function pendingAlreadyApplied(storage, workspace, pending) {
  return workspace.boards.some((item) => {
    const loaded = readDocument(storage, item.id);
    return loaded.pendingId === pending.id
      || (item.id === pending.boardId && loaded.board && boardsMatch(loaded.board, pending.board));
  });
}

function removePendingKey(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    try { storage.setItem(key, "null"); } catch {}
  }
}

function cleanupInterruptedImports(storage, now) {
  const journalKeys = listStorageKeys(storage, [IMPORT_JOURNAL_PREFIX]);
  if (journalKeys.length === 0) return;
  const timestamp = now();
  journalKeys.forEach((key) => cleanupInterruptedImport(storage, key, timestamp));
}

function cleanupInterruptedImport(storage, key, timestamp) {
  let journal;
  try { journal = JSON.parse(storage.getItem(key)); } catch { journal = null; }
  const journalId = key.slice(IMPORT_JOURNAL_PREFIX.length);
  if (!isPlainObject(journal)
    || journal.format !== "scattered-import"
    || journal.version !== 1
    || journal.id !== journalId
    || !Number.isFinite(Number(journal.startedAt))
    || !Array.isArray(journal.ids)) {
    removeImportJournal(storage, key);
    return;
  }
  // ponytail: Startup is synchronous; the freshness window avoids racing an active import without adding a second lock system.
  if (timestamp - Number(journal.startedAt) < IMPORT_JOURNAL_STALE_MS) return;
  const referenced = new Set([
    ...(parseWorkspace(storage.getItem(WORKSPACE_KEY))?.boards || []),
    ...(parseWorkspace(storage.getItem(WORKSPACE_BACKUP_KEY))?.boards || []),
  ].map((item) => item.id));
  journal.ids.forEach((id) => {
    if (typeof id !== "string" || referenced.has(id)) return;
    try { storage.removeItem(boardKey(id)); } catch {}
    try { storage.removeItem(backupKey(id)); } catch {}
  });
  removeImportJournal(storage, key);
}

function removeImportJournal(storage, key) {
  try { storage.removeItem(key); } catch {}
}

function readDocument(storage, id) {
  return readDocumentAt(storage, id, BOARD_PREFIX, BACKUP_PREFIX);
}

function readDocumentAt(storage, id, primaryPrefix, backupPrefix) {
  if (!id) return { board: null, revision: null, updatedAt: 0, recovered: false };
  const primary = parseDocument(storage.getItem(`${primaryPrefix}${id}`));
  if (primary) return { ...primary, recovered: false };
  const backup = parseDocument(storage.getItem(`${backupPrefix}${id}`));
  return backup ? { ...backup, recovered: true } : { board: null, revision: null, recovered: false };
}

function readPrimaryDocument(storage, id) {
  return parseDocument(storage.getItem(boardKey(id)));
}

function parseDocument(encoded) {
  try {
    if (!encoded) return null;
    const value = JSON.parse(encoded);
    if (isPlainObject(value) && Object.hasOwn(value, "format")) {
      if (value.format !== DOCUMENT_FORMAT || value.storageVersion !== DOCUMENT_STORAGE_VERSION) return null;
      if (typeof value.revision !== "string" || !value.revision) return null;
      const board = parseStoredBoard(value.board);
      const updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0;
      const pendingId = typeof value.pendingId === "string" && value.pendingId ? value.pendingId : null;
      return board ? { board, revision: value.revision, updatedAt, pendingId } : null;
    }
    const board = parseStoredBoard(value);
    if (!board) return null;
    const metadata = isPlainObject(value._scattered) ? value._scattered : null;
    const revision = metadata?.format === DOCUMENT_FORMAT
      && metadata.storageVersion === DOCUMENT_STORAGE_VERSION
      && typeof metadata.revision === "string"
      && metadata.revision
      ? metadata.revision
      : null;
    const updatedAt = metadata && Number.isFinite(Number(metadata.updatedAt)) ? Number(metadata.updatedAt) : 0;
    const pendingId = typeof metadata?.pendingId === "string" && metadata.pendingId ? metadata.pendingId : null;
    return { board, revision, updatedAt, pendingId };
  } catch {
    return null;
  }
}

function parseStoredBoard(value) {
  if (!isPlainObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  if (value.version !== undefined && (
    !Number.isInteger(value.version)
    || value.version < 3
    || value.version > BOARD_VERSION
  )) return null;
  try {
    return normalizeBoard(value);
  } catch {
    return null;
  }
}

function readRecovery(storage) {
  return parseRecovery(storage.getItem(RECOVERY_KEY));
}

function parseRecovery(encoded) {
  try {
    const value = JSON.parse(encoded);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!isPlainObject(entry) || typeof entry.boardId !== "string") return [];
      const board = parseStoredBoard(entry.board);
      if (!board) return [];
      const savedAt = Number(entry.savedAt) || 0;
      const reason = String(entry.reason || "replace");
      return [{
        id: typeof entry.id === "string" && entry.id ? entry.id : `${entry.boardId}\u0000${savedAt}\u0000${reason}`,
        boardId: entry.boardId,
        board,
        reason,
        savedAt,
      }];
    });
  } catch {
    return [];
  }
}

function writeRecovery(storage, entries) {
  storage.setItem(RECOVERY_KEY, JSON.stringify(entries));
}

function writeWorkspace(storage, workspace) {
  const previous = storage.getItem(WORKSPACE_KEY);
  const next = JSON.stringify(workspace);
  if (previous === next) return;
  if (parseWorkspace(previous)) storage.setItem(WORKSPACE_BACKUP_KEY, previous);
  storage.setItem(WORKSPACE_KEY, next);
}

function writeWorkspaceCopies(storage, workspace) {
  const next = JSON.stringify(workspace);
  storage.setItem(WORKSPACE_KEY, next);
  storage.setItem(WORKSPACE_BACKUP_KEY, next);
}

function cloneWorkspace(workspace) {
  return {
    ...workspace,
    boards: workspace.boards.map((item) => ({ ...item })),
    tombstones: (workspace.tombstones || []).map((item) => ({ ...item })),
  };
}

function applyWorkspace(target, source) {
  target.version = source.version;
  target.activeId = source.activeId;
  target.boards = source.boards;
  target.tombstones = source.tombstones;
}

function updateMetadata(workspace, id, title, updatedAt, revision) {
  const item = workspace.boards.find((candidate) => candidate.id === id);
  if (!item) return;
  if (typeof title === "string") item.title = title;
  if (Number.isFinite(updatedAt)) item.updatedAt = updatedAt;
  if (revision !== undefined) item.revision = revision;
  workspace.boards.sort((a, b) => b.updatedAt - a.updatedAt);
}

function ensureMetadata(workspace, id, title, updatedAt, revision) {
  const item = workspace.boards.find((candidate) => candidate.id === id);
  if (item) updateMetadata(workspace, id, title, updatedAt, revision);
  else workspace.boards.unshift({ id, title, updatedAt, revision });
}

function mergeWorkspace(storage, workspace) {
  const latest = readWorkspace(storage);
  const next = latest ? cloneWorkspace(latest) : cloneWorkspace(workspace);
  next.tombstones = mergeTombstones(next.tombstones, workspace.tombstones || []);
  const deletedIds = new Set(next.tombstones.map((item) => item.id));
  next.boards = next.boards.filter((item) => !deletedIds.has(item.id));
  const indexedIds = new Set(next.boards.map((item) => item.id));
  workspace.boards.forEach((item) => {
    if (indexedIds.has(item.id) || deletedIds.has(item.id)) return;
    const loaded = readDocument(storage, item.id);
    if (!loaded.board) return;
    next.boards.push({
      id: item.id,
      title: loaded.board.title,
      updatedAt: item.updatedAt,
      revision: loaded.revision,
    });
    indexedIds.add(item.id);
  });
  if (!next.boards.some((item) => item.id === next.activeId)) next.activeId = next.boards[0]?.id;
  return next;
}

function mergeTombstones(left = [], right = []) {
  const merged = new Map();
  [...left, ...right].forEach((item) => {
    if (!isPlainObject(item) || typeof item.id !== "string" || !item.id) return;
    const deletedAt = Number(item.deletedAt) || 0;
    if (!merged.has(item.id) || merged.get(item.id).deletedAt < deletedAt) merged.set(item.id, { id: item.id, deletedAt });
  });
  return [...merged.values()];
}

function saveConflictCopy(storage, workspace, nextWorkspace, board, now, pendingId) {
  const id = createId();
  const savedAt = now();
  const revision = createId();
  const copy = normalizeBoard({ ...board, title: copyTitle(board.title, nextWorkspace.boards.map((item) => item.title)) });
  nextWorkspace.activeId = id;
  nextWorkspace.boards.unshift({ id, title: copy.title, updatedAt: savedAt, revision });
  persistNewDocument(storage, id, copy, revision, savedAt, nextWorkspace, pendingId);
  applyWorkspace(workspace, nextWorkspace);
  return copy;
}

function persistDocument(storage, id, board, revision, updatedAt, workspace, pendingId) {
  const key = boardKey(id);
  const backup = backupKey(id);
  const previous = storage.getItem(key);
  const previousBackup = storage.getItem(backup);
  const next = encodeDocument(board, revision, updatedAt, pendingId);
  try {
    if (parseDocument(previous) && previous !== next) storage.setItem(backup, previous);
    storage.setItem(key, next);
    writeWorkspace(storage, workspace);
  } catch (error) {
    restoreStorageItem(storage, key, previous);
    restoreStorageItem(storage, backup, previousBackup);
    throw error;
  }
}

function persistNewDocument(storage, id, board, revision, updatedAt, workspace, pendingId) {
  const key = boardKey(id);
  const previous = storage.getItem(key);
  storage.setItem(key, encodeDocument(board, revision, updatedAt, pendingId));
  try {
    writeWorkspace(storage, workspace);
  } catch (error) {
    restoreStorageItem(storage, key, previous);
    throw error;
  }
}

function restoreStorageItem(storage, key, value) {
  try {
    if (storage.getItem(key) === value) return true;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    // Preserve the original storage error; backups remain the final fallback.
    return false;
  }
}

function encodeDocument(board, revision, updatedAt, pendingId) {
  return JSON.stringify({
    ...normalizeBoard(board),
    _scattered: {
      format: DOCUMENT_FORMAT,
      storageVersion: DOCUMENT_STORAGE_VERSION,
      revision,
      updatedAt,
      ...(typeof pendingId === "string" && pendingId ? { pendingId } : {}),
    },
  });
}

function boardsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateWorkspaceContents(boards, errorCode) {
  if (boards.length > MAX_WORKSPACE_IMPORT_BOARDS) throw new Error(errorCode);
  const totals = boards.reduce((result, board) => ({
    nodes: result.nodes + (Array.isArray(board?.nodes) ? board.nodes.length : Infinity),
    edges: result.edges + (Array.isArray(board?.edges) ? board.edges.length : Infinity),
  }), { nodes: 0, edges: 0 });
  if (totals.nodes > MAX_WORKSPACE_IMPORT_NODES || totals.edges > MAX_WORKSPACE_IMPORT_EDGES) {
    throw new Error(errorCode);
  }
}

function boardContentMatches(left, right) {
  const { view: _leftView, ...leftContent } = left;
  const { view: _rightView, ...rightContent } = right;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boardKey(id) {
  return `${BOARD_PREFIX}${id}`;
}

function backupKey(id) {
  return `${BACKUP_PREFIX}${id}`;
}

function availableTitle(title, titles) {
  const value = String(title || "Untitled").trim() || "Untitled";
  return titles.includes(value) ? copyTitle(value, titles) : value;
}

function copyTitle(title, titles) {
  const value = String(title || "Untitled").trim() || "Untitled";
  let number = 2;
  let candidate = `${value} · ${number}`.slice(0, 120);
  while (titles.includes(candidate)) {
    number += 1;
    candidate = `${value} · ${number}`.slice(0, 120);
  }
  return candidate;
}
