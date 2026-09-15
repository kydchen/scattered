const ANCESTOR_LIMIT = 48;
const HISTORY_LIMIT = 8;

export const CLOUD_SNAPSHOT_FORMAT = "scattered-cloud-workspace";
export const CLOUD_SNAPSHOT_VERSION = 1;

export async function indexSyncWorkspace(workspace) {
  const entries = [];
  for (const item of [...workspace.boards].sort((left, right) => left.id.localeCompare(right.id))) {
    entries.push({ id: item.id, kind: "board", hash: await hashBoardContent(item.board) });
  }
  const boardIds = new Set(workspace.boards.map((item) => item.id));
  workspace.tombstones
    .filter((item) => !boardIds.has(item.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((item) => entries.push({ id: item.id, kind: "deleted", hash: "deleted" }));
  return entries;
}

export async function fingerprintSyncWorkspace(workspace) {
  return hashText(JSON.stringify(await indexSyncWorkspace(workspace)));
}

export function isDisposableSyncWorkspace(workspace) {
  if (workspace.boards.length !== 1 || workspace.tombstones.length !== 0) return false;
  const board = workspace.boards[0].board;
  return board.title === "Untitled" && board.nodes.length === 0 && board.edges.length === 0;
}

export function parseSyncIndex(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    if (typeof item.id !== "string" || !item.id || ids.has(item.id)) return [];
    if (!["board", "deleted"].includes(item.kind)) return [];
    if (typeof item.hash !== "string" || !item.hash) return [];
    ids.add(item.id);
    return [{ id: item.id, kind: item.kind, hash: item.hash }];
  });
}

export function findCommonBaseIndex(left, right) {
  const rightLineage = new Set(snapshotLineage(right));
  const history = new Map();
  [...(left.history || []), ...(right.history || [])].forEach((entry) => {
    if (typeof entry?.snapshotId !== "string" || !entry.snapshotId || history.has(entry.snapshotId)) return;
    history.set(entry.snapshotId, parseSyncIndex(entry.index));
  });
  return snapshotLineage(left)
    .filter((id) => rightLineage.has(id))
    .map((id) => history.get(id))
    .find(Boolean) || [];
}

export function snapshotLineage(snapshot) {
  return unique([snapshot.snapshotId, ...(snapshot.parents || []), ...(snapshot.ancestors || [])]);
}

export function cloudSnapshotHeads(snapshots) {
  const valid = snapshots.filter((snapshot) => snapshot?.snapshotId);
  const ancestors = new Set(valid.flatMap((snapshot) => snapshotLineage(snapshot).slice(1)));
  return valid.filter((candidate) => !ancestors.has(candidate.snapshotId));
}

export async function mergeSyncWorkspaces(local, remote, baseIndex = []) {
  const [localIndex, remoteIndex] = await Promise.all([
    indexSyncWorkspace(local),
    indexSyncWorkspace(remote),
  ]);
  const localStates = stateMap(local, localIndex);
  const remoteStates = stateMap(remote, remoteIndex);
  const baseStates = new Map(parseSyncIndex(baseIndex).map((item) => [item.id, item]));
  const ids = [...new Set([...localStates.keys(), ...remoteStates.keys(), ...baseStates.keys()])].sort();
  const boards = [];
  const tombstones = [];
  const titles = new Set();
  const usedIds = new Set(ids);
  const activeReplacements = new Map();
  const copies = [];
  let conflicts = 0;

  for (const id of ids) {
    const localState = localStates.get(id) || absentState(id);
    const remoteState = remoteStates.get(id) || absentState(id);
    const baseState = baseStates.get(id) || absentState(id);

    if (statesEqual(localState, remoteState)) {
      appendState(localState, localState, boards, tombstones, titles);
      continue;
    }
    if (statesEqual(localState, baseState)) {
      appendState(remoteState, localState, boards, tombstones, titles);
      continue;
    }
    if (statesEqual(remoteState, baseState)) {
      appendState(localState, localState, boards, tombstones, titles);
      continue;
    }
    if (localState.kind === "absent") {
      appendState(remoteState, localState, boards, tombstones, titles);
      continue;
    }
    if (remoteState.kind === "absent") {
      appendState(localState, localState, boards, tombstones, titles);
      continue;
    }
    if (localState.kind === "deleted" && remoteState.kind === "deleted") {
      appendState(newerDeletion(localState, remoteState), localState, boards, tombstones, titles);
      continue;
    }

    if (localState.kind === "deleted" || remoteState.kind === "deleted") {
      const deleted = localState.kind === "deleted" ? localState : remoteState;
      const kept = localState.kind === "board" ? localState : remoteState;
      appendState(deleted, localState, boards, tombstones, titles);
      copies.push({ state: kept, id, replaceActive: localState.kind === "board" });
      continue;
    }

    const [primary, secondary] = [localState, remoteState].sort((left, right) => left.hash.localeCompare(right.hash));
    appendState(primary, localState, boards, tombstones, titles);
    copies.push({ state: secondary, id, replaceActive: localState.hash === secondary.hash });
  }

  // Resolve existing IDs first: only reuse copies which survive this merge.
  const preserved = new Map(boards.map((item) => [item.id, item]));
  for (const { state, id, replaceActive } of copies) {
    const copy = await conflictCopy(state.item, state.hash, id, titles, usedIds, preserved);
    if (!preserved.has(copy.id)) {
      boards.push(copy);
      titles.add(copy.board.title);
      usedIds.add(copy.id);
      preserved.set(copy.id, copy);
      conflicts += 1;
    }
    if (replaceActive) activeReplacements.set(id, copy.id);
  }

  boards.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const boardIds = new Set(boards.map((item) => item.id));
  const localActive = activeReplacements.get(local.activeId) || local.activeId;
  const activeId = boardIds.has(localActive)
    ? localActive
    : boardIds.has(remote.activeId)
      ? remote.activeId
      : boards[0]?.id || null;

  return {
    workspace: {
      format: local.format,
      version: local.version,
      activeId,
      boards,
      tombstones: tombstones.sort((left, right) => right.deletedAt - left.deletedAt || left.id.localeCompare(right.id)),
    },
    conflicts,
  };
}

export async function createCloudSnapshot(workspace, options = {}) {
  const snapshotId = globalThis.crypto.randomUUID();
  const parentSnapshots = (options.parents || []).filter((item) => item?.snapshotId);
  // Pin every currently stored device snapshot. Dormant files must not become
  // new heads when the rolling ancestry window fills up. Size scales with
  // device files, not with the number of edits; the upload byte limit still applies.
  const parents = unique(parentSnapshots.map((item) => item.snapshotId));
  const ancestors = unique([
    ...parents,
    ...parentSnapshots.flatMap(snapshotLineage),
    ...(options.ancestorIds || []),
  ]).filter((id) => id !== snapshotId).slice(0, ANCESTOR_LIMIT);
  const currentIndex = await indexSyncWorkspace(workspace);
  const history = mergeHistory([
    { snapshotId, index: currentIndex },
    ...(options.history || []),
    ...parentSnapshots.flatMap((item) => [
      { snapshotId: item.snapshotId, index: item.index || [] },
      ...(item.history || []),
    ]),
  ]);
  return {
    format: CLOUD_SNAPSHOT_FORMAT,
    version: CLOUD_SNAPSHOT_VERSION,
    snapshotId,
    deviceId: String(options.deviceId || ""),
    createdAt: Number(options.createdAt || Date.now()),
    parents,
    ancestors,
    history,
    workspace,
  };
}

export function mergeSnapshotHistory(...groups) {
  return mergeHistory(groups.flat());
}

function stateMap(workspace, index) {
  const indexed = new Map(index.map((item) => [item.id, item]));
  const states = new Map();
  workspace.boards.forEach((item) => {
    const entry = indexed.get(item.id);
    if (entry) states.set(item.id, { ...entry, item });
  });
  workspace.tombstones.forEach((item) => {
    if (!states.has(item.id)) states.set(item.id, { id: item.id, kind: "deleted", hash: "deleted", deletedAt: item.deletedAt });
  });
  return states;
}

function absentState(id) {
  return { id, kind: "absent", hash: "absent" };
}

function statesEqual(left, right) {
  return left.kind === right.kind && left.hash === right.hash;
}

function appendState(state, localState, boards, tombstones, titles) {
  if (state.kind === "board") {
    const item = clone(state.item);
    if (localState.kind === "board" && localState.item.board?.view) item.board.view = clone(localState.item.board.view);
    boards.push(item);
    titles.add(item.board.title);
  } else if (state.kind === "deleted") {
    tombstones.push({ id: state.id, deletedAt: Number(state.deletedAt) || 0 });
  }
}

function newerDeletion(left, right) {
  return (Number(left.deletedAt) || 0) >= (Number(right.deletedAt) || 0) ? left : right;
}

async function conflictCopy(item, hash, originalId, titles, usedIds, preserved) {
  const copy = clone(item);
  const baseId = `sync-${stableHash(`${originalId}:${hash}`)}`;
  copy.id = baseId;
  let suffix = 2;
  while (usedIds.has(copy.id)) {
    const existing = preserved.get(copy.id);
    // The merge may have renamed a copy to avoid a title collision. Compare its
    // full content using the source title, not just its short deterministic ID.
    if (existing && await hashBoardContent({ ...existing.board, title: item.board.title }) === hash) return existing;
    copy.id = `${baseId}-${suffix}`;
    suffix += 1;
  }
  copy.revision = `sync-${hash.slice(0, 32)}`;
  copy.board.title = availableTitle(copy.board.title, titles);
  return copy;
}

function availableTitle(title, titles) {
  const value = String(title || "Untitled").trim() || "Untitled";
  if (!titles.has(value)) return value;
  let number = 2;
  const numbered = () => `${value.slice(0, 120 - ` · ${number}`.length)} · ${number}`;
  let candidate = numbered();
  while (titles.has(candidate)) {
    number += 1;
    candidate = numbered();
  }
  return candidate;
}

function mergeHistory(entries) {
  const seen = new Set();
  return entries.flatMap((entry) => {
    if (typeof entry?.snapshotId !== "string" || !entry.snapshotId || seen.has(entry.snapshotId)) return [];
    const index = parseSyncIndex(entry.index);
    if (index.length === 0) return [];
    seen.add(entry.snapshotId);
    return [{ snapshotId: entry.snapshotId, index }];
  }).slice(0, HISTORY_LIMIT);
}

async function hashBoardContent(board) {
  const { view: _view, ...content } = board;
  return hashText(JSON.stringify(content));
}

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableHash(value) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
