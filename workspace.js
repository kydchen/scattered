import { blankBoard, createId, normalizeBoard } from "./model.js";

const LEGACY_BOARD_KEY = "scattered-board-v1";
const WORKSPACE_KEY = "scattered-workspace-v1";
const WORKSPACE_BACKUP_KEY = "scattered-workspace-backup-v1";
const BOARD_PREFIX = "scattered-document-v1:";
const BACKUP_PREFIX = "scattered-document-backup-v1:";
const RECOVERY_KEY = "scattered-recovery-v1";
const MAX_RECOVERY = 5;

export function loadWorkspace(storage = localStorage, now = Date.now) {
  const workspace = readWorkspace(storage) || migrateLegacyBoard(storage, now);
  const activeId = workspace.boards.some((item) => item.id === workspace.activeId)
    ? workspace.activeId
    : workspace.boards[0]?.id;
  workspace.activeId = activeId;
  const loaded = readDocument(storage, activeId);
  if (loaded.board) {
    writeWorkspace(storage, workspace);
    return { workspace, board: loaded.board, recovered: loaded.recovered };
  }
  const board = blankBoard();
  saveDocument(storage, workspace, board, now);
  return { workspace, board, recovered: false };
}

export function saveDocument(storage, workspace, board, now = Date.now) {
  const normalized = normalizeBoard(board);
  const key = boardKey(workspace.activeId);
  const next = JSON.stringify(normalized);
  const previous = storage.getItem(key);
  if (previous && previous !== next) storage.setItem(backupKey(workspace.activeId), previous);
  storage.setItem(key, next);
  const nextWorkspace = cloneWorkspace(workspace);
  updateMetadata(nextWorkspace, workspace.activeId, normalized.title, now());
  writeWorkspace(storage, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  return normalized;
}

export function createDocument(storage, workspace, board = blankBoard(), now = Date.now) {
  const id = createId();
  const normalized = normalizeBoard(board);
  const nextWorkspace = cloneWorkspace(workspace);
  nextWorkspace.activeId = id;
  nextWorkspace.boards.unshift({ id, title: normalized.title, updatedAt: now() });
  storage.setItem(boardKey(id), JSON.stringify(normalized));
  writeWorkspace(storage, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  return normalized;
}

export function switchDocument(storage, workspace, id) {
  if (!workspace.boards.some((item) => item.id === id)) return null;
  const loaded = readDocument(storage, id);
  if (!loaded.board) return null;
  const nextWorkspace = cloneWorkspace(workspace);
  nextWorkspace.activeId = id;
  writeWorkspace(storage, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  return loaded;
}

export function duplicateDocument(storage, workspace, board, now = Date.now) {
  const copy = normalizeBoard({ ...board, title: copyTitle(board.title, workspace.boards.map((item) => item.title)) });
  return createDocument(storage, workspace, copy, now);
}

export function deleteDocument(storage, workspace, board, now = Date.now) {
  captureRecovery(storage, workspace.activeId, board, "delete", now);
  const removedId = workspace.activeId;
  const nextWorkspace = cloneWorkspace(workspace);
  nextWorkspace.boards = nextWorkspace.boards.filter((item) => item.id !== removedId);
  let nextBoard;
  if (nextWorkspace.boards.length === 0) {
    const id = createId();
    nextBoard = blankBoard();
    nextWorkspace.activeId = id;
    nextWorkspace.boards = [{ id, title: nextBoard.title, updatedAt: now() }];
    storage.setItem(boardKey(id), JSON.stringify(nextBoard));
  } else {
    nextWorkspace.activeId = nextWorkspace.boards[0].id;
    nextBoard = readDocument(storage, nextWorkspace.activeId).board || blankBoard();
  }
  writeWorkspace(storage, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  storage.removeItem(boardKey(removedId));
  storage.removeItem(backupKey(removedId));
  return nextBoard;
}

export function captureRecovery(storage, boardId, board, reason, now = Date.now) {
  const entries = readRecovery(storage);
  entries.unshift({ boardId, board: normalizeBoard(board), reason, savedAt: now() });
  storage.setItem(RECOVERY_KEY, JSON.stringify(entries.slice(0, MAX_RECOVERY)));
}

export function restoreLatest(storage, workspace, currentBoard, now = Date.now) {
  const entries = readRecovery(storage);
  const entry = entries.shift();
  if (!entry) return null;
  entries.push({ boardId: workspace.activeId, board: normalizeBoard(currentBoard), reason: "replace", savedAt: now() });
  storage.setItem(RECOVERY_KEY, JSON.stringify(entries.slice(0, MAX_RECOVERY)));
  const nextWorkspace = cloneWorkspace(workspace);
  const id = nextWorkspace.boards.some((item) => item.id === entry.boardId) ? entry.boardId : createId();
  if (!nextWorkspace.boards.some((item) => item.id === id)) {
    nextWorkspace.boards.unshift({ id, title: entry.board.title, updatedAt: now() });
  }
  nextWorkspace.activeId = id;
  storage.setItem(boardKey(id), JSON.stringify(entry.board));
  updateMetadata(nextWorkspace, id, entry.board.title, now());
  writeWorkspace(storage, nextWorkspace);
  applyWorkspace(workspace, nextWorkspace);
  return entry.board;
}

export function hasRecovery(storage = localStorage) {
  return readRecovery(storage).length > 0;
}

function migrateLegacyBoard(storage, now) {
  let board = blankBoard();
  try {
    const legacy = storage.getItem(LEGACY_BOARD_KEY);
    if (legacy) board = normalizeBoard(JSON.parse(legacy));
  } catch {}
  const id = createId();
  const workspace = { version: 1, activeId: id, boards: [{ id, title: board.title, updatedAt: now() }] };
  storage.setItem(boardKey(id), JSON.stringify(board));
  writeWorkspace(storage, workspace);
  return workspace;
}

function readWorkspace(storage) {
  return parseWorkspace(storage.getItem(WORKSPACE_KEY)) || parseWorkspace(storage.getItem(WORKSPACE_BACKUP_KEY));
}

function parseWorkspace(encoded) {
  try {
    const value = JSON.parse(encoded);
    if (!value || value.version !== 1 || !Array.isArray(value.boards)) return null;
    const ids = new Set();
    const boards = value.boards.flatMap((item) => {
      if (!item || typeof item.id !== "string" || ids.has(item.id)) return [];
      ids.add(item.id);
      return [{
        id: item.id,
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : "Untitled",
        updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : 0,
      }];
    });
    if (boards.length === 0) return null;
    return { version: 1, activeId: value.activeId, boards };
  } catch {
    return null;
  }
}

function readDocument(storage, id) {
  if (!id) return { board: null, recovered: false };
  const primary = parseBoard(storage.getItem(boardKey(id)));
  if (primary) return { board: primary, recovered: false };
  const backup = parseBoard(storage.getItem(backupKey(id)));
  return { board: backup, recovered: Boolean(backup) };
}

function parseBoard(value) {
  try {
    return value ? normalizeBoard(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

function readRecovery(storage) {
  try {
    const value = JSON.parse(storage.getItem(RECOVERY_KEY));
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      try {
        if (!entry || typeof entry.boardId !== "string") return [];
        return [{
          boardId: entry.boardId,
          board: normalizeBoard(entry.board),
          reason: String(entry.reason || "replace"),
          savedAt: Number(entry.savedAt) || 0,
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function writeWorkspace(storage, workspace) {
  const previous = storage.getItem(WORKSPACE_KEY);
  if (parseWorkspace(previous)) storage.setItem(WORKSPACE_BACKUP_KEY, previous);
  storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
}

function cloneWorkspace(workspace) {
  return { ...workspace, boards: workspace.boards.map((item) => ({ ...item })) };
}

function applyWorkspace(target, source) {
  target.version = source.version;
  target.activeId = source.activeId;
  target.boards = source.boards;
}

function updateMetadata(workspace, id, title, updatedAt) {
  const item = workspace.boards.find((candidate) => candidate.id === id);
  if (!item) return;
  item.title = title;
  item.updatedAt = updatedAt;
  workspace.boards.sort((a, b) => b.updatedAt - a.updatedAt);
}

function boardKey(id) {
  return `${BOARD_PREFIX}${id}`;
}

function backupKey(id) {
  return `${BACKUP_PREFIX}${id}`;
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
