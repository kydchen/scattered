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

export function findCommonBaseIndex(left, right, observedSnapshots = []) {
  const candidates = findCommonBaseCandidates(left, right, observedSnapshots);
  // A missing latest index is uncertainty, not permission to use an older one.
  if (!candidates.length || candidates.some(item => !Array.isArray(item.index))) return [];
  const alternatives = candidates.slice(1).map(item => new Map(item.index.map(state => [state.id, state])));
  // Multiple maximal common ancestors are possible. Use only the board states
  // on which ALL candidates agree; other boards retain conflict-copy protection.
  return candidates[0].index.filter(state => alternatives.every(index => {
    const other = index.get(state.id);
    return other && statesEqual(state, other);
  }));
}

export function findCommonBaseCandidates(left, right, observedSnapshots = []) {
  const snapshots = [left, right, ...observedSnapshots];
  const records = collectHistory(snapshots.flatMap(snapshot => [snapshot, ...(snapshot.history || [])]));
  // Keep the same bounded ancestry proof after a full device snapshot becomes
  // history. Direct-parent chains alone break when intermediate records expire.
  const graph = new Map([...records].map(([id, record]) => [id, {
    parents: record.parents === null ? null : unique([
      ...(record.parents || []), ...(record.ancestors || []),
    ]),
  }]));
  const ancestors = (starts) => {
    const seen = new Set(), pending = [...starts];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const parents = graph.get(id)?.parents;
      if (Array.isArray(parents)) pending.push(...parents);
    }
    return seen;
  };
  const rightIds = ancestors(snapshotLineage(right));
  const common = [...ancestors(snapshotLineage(left))].filter(id => rightIds.has(id)).sort();
  const older = new Set();
  // Cyclic metadata is not causal proof. Keep all possibilities instead of
  // pruning both sides of a cycle or trusting paths through corrupt history.
  if (!historyHasCycle(graph)) {
    for (const id of common) {
      const parents = graph.get(id)?.parents;
      if (Array.isArray(parents)) for (const ancestor of ancestors(parents)) older.add(ancestor);
    }
  }
  return common.filter(id => !older.has(id)).map(snapshotId => records.get(snapshotId) || { snapshotId });
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
    { snapshotId, index: currentIndex, parents, ancestors },
    ...(options.history || []),
    ...parentSnapshots.flatMap((item) => [
      item,
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
  // Enrich duplicates before truncating. Old clients omit optional parents;
  // absence means unknown, whereas [] describes a known root.
  // Index-free proofs can fill spare slots, but cannot displace usable bases.
  // Their IDs remain in lineage, so dropping a record never proves it obsolete.
  return [...collectHistory(entries).values()]
    .sort((a, b) => Number(Array.isArray(b.index)) - Number(Array.isArray(a.index)))
    .slice(0, HISTORY_LIMIT);
}

function collectHistory(entries) {
  const records = new Map();
  for (const entry of entries) {
    if (!validSnapshotId(entry?.snapshotId)) continue;
    const record = records.get(entry.snapshotId) || { snapshotId: entry.snapshotId };
    let index;
    if (entry.index !== undefined) {
      const parsed = parseSyncIndex(entry.index);
      index = Array.isArray(entry.index) && parsed.length === entry.index.length
        ? parsed.sort((a, b) => a.id.localeCompare(b.id)) : null;
    }
    const parents = entry.parents === undefined ? undefined
      : Array.isArray(entry.parents) && entry.parents.every(id => validSnapshotId(id) && id !== entry.snapshotId)
        ? unique(entry.parents).sort() : null;
    const ancestors = entry.ancestors === undefined ? undefined
      : Array.isArray(entry.ancestors) && entry.ancestors.every(id => validSnapshotId(id) && id !== entry.snapshotId)
        ? unique(entry.ancestors).slice(0, ANCESTOR_LIMIT).sort() : null;
    for (const [key, value] of [["index", index], ["parents", parents], ["ancestors", ancestors]]) {
      if (value === undefined) continue;
      // null is deliberately persistent: contradictory evidence must not become
      // trustworthy again after serialization or another richer duplicate.
      if (record[key] === undefined) record[key] = value;
      else if (JSON.stringify(record[key]) !== JSON.stringify(value)) record[key] = null;
    }
    records.set(entry.snapshotId, record);
  }
  return records;
}

function historyHasCycle(records) {
  const counts = new Map(), children = new Map();
  for (const [id, record] of records) {
    const parents = Array.isArray(record.parents) ? record.parents : [];
    counts.set(id, parents.length);
    for (const parent of parents) {
      if (!counts.has(parent)) counts.set(parent, 0);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    }
  }
  const ready = [...counts.keys()].filter(id => counts.get(id) === 0);
  let visited = 0;
  while (ready.length) {
    const id = ready.pop(); visited += 1;
    for (const child of children.get(id) || []) {
      const count = counts.get(child) - 1;
      counts.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  return visited !== counts.size;
}

function validSnapshotId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
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
