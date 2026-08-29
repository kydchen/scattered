import { applyLassoSelection, blankBoard, boardToMermaidMarkdown, clamp, connectionCurve, copySelectedGraph, createId, emptyNotePrompt, fitBoundsToViewport, hasDragIntent, nextArrowState, normalizeBoard, pasteSelectedGraph, pointInPolygon, removeConnectionsForNodes, screenToWorld, shouldDiscardDraft, shouldPinch, shouldResetPointers, toggleArrowsForNodes, toggleConnectionsToTarget } from "./model.js";
import { createBoardSvg } from "./svg-export.js";
import { captureRecovery, createDocument, deleteDocument, duplicateDocument, hasRecovery, loadWorkspace, restoreLatest, saveDocument, switchDocument } from "./workspace.js";

const THEME_KEY = "scattered-theme";
const CLIPBOARD_TYPE = "application/x-scattered-selection+json";
const viewport = document.querySelector("#viewport");
const world = document.querySelector("#world");
const nodeLayer = document.querySelector("#node-layer");
const edgeLayer = document.querySelector("#edge-layer");
const arrowMarker = document.querySelector("#edge-arrowhead");
const linkPreview = document.querySelector("#link-preview");
const lassoPath = document.querySelector("#lasso-path");
const template = document.querySelector("#node-template");
const menu = document.querySelector("#menu");
const menuButton = document.querySelector("#menu-button");
const cancelExportButton = document.querySelector("#cancel-export-button");
const exportJsonButton = document.querySelector("#export-json-button");
const exportSvgButton = document.querySelector("#export-svg-button");
const exportMermaidButton = document.querySelector("#export-mermaid-button");
const clearButton = document.querySelector("#clear-button");
const cancelClearButton = document.querySelector("#cancel-clear-button");
const themeButton = document.querySelector("#theme-button");
const themeColor = document.querySelector('meta[name="theme-color"]');
const toast = document.querySelector("#toast");
const historyTools = document.querySelector("#history-tools");
const fitButton = document.querySelector("#fit-button");
const undoButton = document.querySelector("#undo-button");
const redoButton = document.querySelector("#redo-button");
const selectionBar = document.querySelector("#selection-bar");
const colorSelectionButton = document.querySelector("#color-selection");
const arrowSelectionButton = document.querySelector("#arrow-selection");
const colorPalette = document.querySelector("#color-palette");
const disconnectSelectionButton = document.querySelector("#disconnect-selection");
const edgeToolbar = document.querySelector("#edge-toolbar");
const edgeArrowButton = document.querySelector("#edge-arrow");
const edgeLabelButton = document.querySelector("#edge-label");
const edgeDeleteButton = document.querySelector("#edge-delete");
const edgeLabelEditor = document.querySelector("#edge-label-editor");
const importInput = document.querySelector("#import-input");
const boardTitle = document.querySelector("#board-title");
const boardTitleEditor = document.querySelector("#board-title-editor");
const emptyState = document.querySelector("#empty-state");
const boardsButton = document.querySelector("#boards-button");
const boardPicker = document.querySelector("#board-picker");
const boardList = document.querySelector("#board-list");
const newBoardButton = document.querySelector("#new-board-button");
const duplicateBoardButton = document.querySelector("#duplicate-board-button");
const deleteBoardButton = document.querySelector("#delete-board-button");
const restoreButton = document.querySelector("#restore-button");
const searchButton = document.querySelector("#search-button");
const searchPanel = document.querySelector("#search-panel");
const searchInput = document.querySelector("#search-input");
const searchCount = document.querySelector("#search-count");
const searchPreviousButton = document.querySelector("#search-previous");
const searchNextButton = document.querySelector("#search-next");
const searchCloseButton = document.querySelector("#search-close");
const duplicateSelectionButton = document.querySelector("#duplicate-selection");

const initialWorkspace = initializeWorkspace();
let workspace = initialWorkspace.workspace;
let board = initialWorkspace.board;
let storageReady = initialWorkspace.storageReady;
let selectionMode = false;
let mode = null;
let saveTimer = null;
let toastTimer = null;
let edgeRenderFrame = 0;
let palmGuardUntil = 0;
let lastPenUpAt = 0;
let colorTargetIds = [];
let selectedEdgeId = null;
let spacePressed = false;
let clipboardPayload = null;
let clipboardText = "";
let searchMatches = [];
let searchIndex = -1;
const pointers = new Map();
const nodeElements = new Map();
const selectedIds = new Set();
const undoStack = [];
const redoStack = [];

renderAll();
applyView();
updateHistoryControls();
updateThemeControl();
renderBoardList();
updateRecoveryControl();

viewport.addEventListener("pointerdown", onPointerDown);
viewport.addEventListener("pointermove", onPointerMove);
viewport.addEventListener("pointerup", onPointerUp);
viewport.addEventListener("pointercancel", cancelGesture);
viewport.addEventListener("dblclick", onDoubleClick);
viewport.addEventListener("wheel", onWheel, { passive: false });
viewport.addEventListener("contextmenu", (event) => {
  if (!event.target.closest(".node-editor")) event.preventDefault();
});
document.addEventListener("keydown", onKeyDown);
document.addEventListener("copy", onCopy);
document.addEventListener("paste", onPaste);
document.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    spacePressed = false;
    viewport.classList.remove("pan-ready");
  }
});
window.addEventListener("resize", () => {
  hideColorPalette();
  renderEdges();
  updateHistoryControls();
});
window.addEventListener("blur", () => {
  spacePressed = false;
  viewport.classList.remove("pan-ready", "panning");
  cancelGesture();
});
window.addEventListener("pagehide", saveBoardNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveBoardNow();
});
boardsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (boardPicker.hidden) {
    finishCurrentInput();
    saveBoardNow();
  }
  setBoardPickerOpen(boardPicker.hidden);
});
newBoardButton.addEventListener("click", newBoard);
duplicateBoardButton.addEventListener("click", duplicateBoard);
deleteBoardButton.addEventListener("click", removeCurrentBoard);
boardList.addEventListener("click", (event) => {
  const option = event.target.closest(".board-list-option");
  if (option) openBoard(option.dataset.id);
});
menuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenuOpen(menu.hidden);
});
themeButton.addEventListener("click", toggleTheme);

document.querySelector("#export-button").addEventListener("click", showExportChoices);
cancelExportButton.addEventListener("click", disarmExport);
exportJsonButton.addEventListener("click", exportBoard);
exportSvgButton.addEventListener("click", exportSvg);
exportMermaidButton.addEventListener("click", exportMermaid);
document.querySelector("#import-button").addEventListener("click", () => importInput.click());
importInput.addEventListener("change", importBoard);
searchButton.addEventListener("click", openSearch);
restoreButton.addEventListener("click", restoreRecentBoard);
clearButton.addEventListener("click", clearBoard);
cancelClearButton.addEventListener("click", (event) => {
  event.stopPropagation();
  disarmClear();
});
undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
fitButton.addEventListener("click", fitBoard);
colorSelectionButton.addEventListener("click", (event) => {
  event.stopPropagation();
  openColorPalette([...selectedIds], event.currentTarget);
});
colorPalette.addEventListener("click", (event) => {
  event.stopPropagation();
  const swatch = event.target.closest(".color-swatch");
  if (swatch) applyColor(swatch.dataset.color);
});
arrowSelectionButton.addEventListener("click", toggleSelectionArrows);
duplicateSelectionButton.addEventListener("click", duplicateSelection);
disconnectSelectionButton.addEventListener("click", disconnectSelection);
document.querySelector("#delete-selection").addEventListener("click", deleteSelection);
edgeArrowButton.addEventListener("click", toggleSelectedEdgeArrow);
edgeLabelButton.addEventListener("click", openEdgeLabelEditor);
edgeDeleteButton.addEventListener("click", deleteSelectedEdge);
edgeLabelEditor.addEventListener("blur", () => finishEdgeLabel());
edgeLabelEditor.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    finishEdgeLabel();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    finishEdgeLabel(true);
  }
});
boardTitle.addEventListener("dblclick", (event) => {
  event.preventDefault();
  event.stopPropagation();
  editBoardTitle();
});
boardTitle.addEventListener("click", (event) => {
  if (event.detail === 0) editBoardTitle();
});
boardTitleEditor.addEventListener("blur", () => finishBoardTitle());
boardTitleEditor.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    finishBoardTitle();
  } else if (event.key === "Escape") {
    event.preventDefault();
    finishBoardTitle(true);
  }
});
searchInput.addEventListener("input", updateSearch);
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    moveSearch(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});
searchPreviousButton.addEventListener("click", () => moveSearch(-1));
searchNextButton.addEventListener("click", () => moveSearch(1));
searchCloseButton.addEventListener("click", closeSearch);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

if (new URLSearchParams(location.search).get("debug") === "1") {
  import("./debug-client.js")
    .then(({ startPointerDebug }) => startPointerDebug(viewport, pointerDebugState))
    .catch((error) => console.warn("Pointer debug unavailable", error));
}

function onPointerDown(event) {
  if (!event.target.closest(".color-palette, .color-handle, #color-selection")) hideColorPalette();
  if (!event.target.closest(".app-mark") && !boardTitleEditor.hidden) finishBoardTitle();
  if (!event.target.closest(".app-mark, .board-picker")) setBoardPickerOpen(false);
  if (event.target.closest(".app-mark, .board-picker, .search-panel")) return;
  if (event.target.closest(".edge-toolbar, .edge-label-editor")) return;
  if (!edgeLabelEditor.hidden) finishEdgeLabel();
  if (event.target.closest(".menu, .menu-button, .theme-button, .history-tools, .selection-bar, .color-palette, .node-actions")) return;

  const edgeElement = event.target.closest(".edge");
  if (edgeElement) {
    event.preventDefault();
    finishEditing();
    selectEdge(edgeElement.dataset.id);
    return;
  }
  clearEdgeSelection();

  const activeEditor = document.querySelector(".node.editing");
  if (event.pointerType === "touch" && activeEditor && performance.now() < palmGuardUntil) return;
  if (mode?.type === "lasso" && event.pointerType === "touch") return;

  setMenuOpen(false);

  const handle = event.target.closest(".link-handle");
  const resizeHandle = event.target.closest(".resize-handle");
  const deleteButton = event.target.closest(".node-delete");
  const editingNode = event.target.closest(".node.editing");
  if (editingNode && !handle && !resizeHandle && !deleteButton) {
    if (event.pointerType === "pen") palmGuardUntil = performance.now() + 800;
    return;
  }
  if (deleteButton) return;

  if (shouldResetPointers([...pointers.values()].map((pointer) => pointer.type), event.pointerType, event.isPrimary)) {
    cancelGesture();
  }

  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
  try {
    viewport.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture can be unavailable during synthetic QA events.
  }

  const touches = activeTouches();
  if (shouldPinch(touches.map((pointer) => pointer.type))) {
    clearLongPress();
    const [a, b] = touches;
    mode = {
      type: "pinch",
      startDistance: distance(a, b),
      startScale: board.view.scale,
      worldAtCenter: screenToWorld(midpoint(a, b), board.view),
    };
    return;
  }
  if (pointers.size > 1) return;

  if (event.pointerType === "mouse" && (event.button === 1 || spacePressed)) {
    event.preventDefault();
    finishEditing();
    mode = {
      type: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: board.view.x,
      viewY: board.view.y,
      pointerType: event.pointerType,
      moved: false,
    };
    viewport.classList.add("panning");
    return;
  }

  if (resizeHandle) {
    event.preventDefault();
    const element = resizeHandle.closest(".node");
    const node = findNode(element.dataset.id);
    finishEditing(node.id);
    selectNode(node.id);
    mode = {
      type: "resize",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      id: node.id,
      startX: event.clientX,
      startWidth: node.width || 218,
      moved: false,
    };
    return;
  }

  if (handle) {
    event.preventDefault();
    const node = handle.closest(".node");
    finishEditing(node.dataset.id);
    if (!selectedIds.has(node.dataset.id)) selectNode(node.dataset.id);
    const sourceIds = selectionMode ? [...selectedIds] : [node.dataset.id];
    mode = { type: "link", pointerId: event.pointerId, sourceIds, x: event.clientX, y: event.clientY };
    updateLinkPreview(event.clientX, event.clientY);
    return;
  }

  const node = event.target.closest(".node");
  if (node && !node.classList.contains("editing")) {
    const data = findNode(node.dataset.id);
    const wasSelected = selectedIds.has(data.id);
    const mouseToggle = event.pointerType === "mouse" && event.shiftKey;
    let tapAction = "node";
    if (mouseToggle) {
      selectionMode = true;
      if (!wasSelected) selectedIds.add(data.id);
      tapAction = wasSelected ? "toggle" : "keep";
      updateSelection();
    } else if (event.pointerType === "mouse" && selectionMode) {
      if (wasSelected) tapAction = "collapse";
      else selectNode(data.id);
    } else if (selectionMode) {
      if (!wasSelected) {
        selectedIds.add(data.id);
        updateSelection();
      }
      tapAction = wasSelected ? "toggle" : "keep";
    } else {
      selectNode(data.id);
    }
    mode = {
      type: "node",
      pointerId: event.pointerId,
      id: data.id,
      startX: event.clientX,
      startY: event.clientY,
      positions: [...selectedIds].map((id) => {
        const selected = findNode(id);
        return { id, x: selected.x, y: selected.y };
      }),
      tapAction,
      pointerType: event.pointerType,
      moved: false,
    };
    if (event.pointerType === "touch" && !selectionMode) {
      mode.longPressTimer = setTimeout(() => {
        if (mode?.type !== "node" || mode.pointerId !== event.pointerId || mode.moved) return;
        selectionMode = true;
        mode.longPressed = true;
        updateSelection();
      }, 450);
    }
    return;
  }

  if (!node) {
    if (activeEditor) selectNode(null);
    finishEditing();
    mode = event.pointerType === "pen"
      ? { type: "lasso", pointerId: event.pointerId, pointerType: event.pointerType, points: [{ x: event.clientX, y: event.clientY }], moved: false, toggle: selectionMode }
      : event.pointerType === "mouse"
        ? { type: "marquee", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, points: [], moved: false, toggle: event.shiftKey, tapCanvas: !event.shiftKey }
      : {
          type: "pan",
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          viewX: board.view.x,
          viewY: board.view.y,
          pointerType: event.pointerType,
          moved: false,
        };
  }
}

function onPointerMove(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { ...pointers.get(event.pointerId), x: event.clientX, y: event.clientY });

  const touches = activeTouches();
  if (mode?.type === "pinch" && shouldPinch(touches.map((pointer) => pointer.type))) {
    const [a, b] = touches;
    const center = midpoint(a, b);
    const scale = clamp(mode.startScale * (distance(a, b) / Math.max(mode.startDistance, 1)), 0.35, 2);
    board.view.scale = scale;
    board.view.x = center.x - mode.worldAtCenter.x * scale;
    board.view.y = center.y - mode.worldAtCenter.y * scale;
    applyView();
    return;
  }

  if (mode?.type === "pan" && mode.pointerId === event.pointerId) {
    const dx = event.clientX - mode.startX;
    const dy = event.clientY - mode.startY;
    mode.moved ||= hasDragIntent(mode.pointerType, dx, dy);
    board.view.x = mode.viewX + dx;
    board.view.y = mode.viewY + dy;
    applyView();
    return;
  }

  if (mode?.type === "lasso" && mode.pointerId === event.pointerId) {
    addLassoPoints(event);
    return;
  }

  if (mode?.type === "marquee" && mode.pointerId === event.pointerId) {
    const x1 = mode.startX;
    const y1 = mode.startY;
    const x2 = event.clientX;
    const y2 = event.clientY;
    mode.moved ||= hasDragIntent("mouse", x2 - x1, y2 - y1);
    if (!mode.moved) return;
    mode.points = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
    showSelectionPath(mode.points);
    return;
  }

  if (mode?.type === "resize" && mode.pointerId === event.pointerId) {
    const screenDx = event.clientX - mode.startX;
    if (!mode.moved && Math.abs(screenDx) > 2) {
      checkpoint();
      mode.moved = true;
    }
    if (!mode.moved) return;
    applyResize(mode, event.clientX);
    return;
  }

  if (mode?.type === "node" && mode.pointerId === event.pointerId) {
    const screenDx = event.clientX - mode.startX;
    const screenDy = event.clientY - mode.startY;
    const dx = screenDx / board.view.scale;
    const dy = screenDy / board.view.scale;
    if (!mode.moved && hasDragIntent(mode.pointerType, screenDx, screenDy)) {
      clearLongPress(mode);
      checkpoint();
      mode.moved = true;
    }
    if (!mode.moved) return;
    mode.positions.forEach((start) => {
      const node = findNode(start.id);
      node.x = start.x + dx;
      node.y = start.y + dy;
      positionNode(node);
    });
    queueEdgeRender();
    return;
  }

  if (mode?.type === "link" && mode.pointerId === event.pointerId) {
    mode.x = event.clientX;
    mode.y = event.clientY;
    updateLinkPreview(event.clientX, event.clientY);
    document.querySelectorAll(".node.link-target").forEach((element) => element.classList.remove("link-target"));
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".node");
    if (target && !mode.sourceIds.includes(target.dataset.id)) target.classList.add("link-target");
  }
}

function onPointerUp(event) {
  if (event.pointerType === "pen") lastPenUpAt = performance.now();
  if (event.pointerType === "pen" && event.target.closest?.(".node.editing")) {
    palmGuardUntil = performance.now() + 800;
  }
  const currentMode = mode;
  clearLongPress(currentMode);
  pointers.delete(event.pointerId);

  if (currentMode?.type === "pinch") {
    if (pointers.size === 0) {
      mode = null;
      scheduleSave();
      updateHistoryControls();
    }
    return;
  }

  if (currentMode?.pointerId !== event.pointerId) return;

  if (currentMode?.type === "lasso" || currentMode?.type === "marquee") {
    if (currentMode.moved) finishLasso(currentMode.points, currentMode.toggle);
    else if (currentMode.type === "lasso" || currentMode.tapCanvas) handleCanvasTap();
    hideLasso();
  } else if (currentMode?.type === "pan") {
    if (!currentMode.moved) handleCanvasTap();
    else scheduleSave();
  } else if (currentMode?.type === "node") {
    if (currentMode.moved) scheduleSave();
    else if (!currentMode.longPressed && currentMode.tapAction !== "keep") {
      if (currentMode.tapAction === "toggle") toggleNodeSelection(currentMode.id);
      else if (currentMode.tapAction === "collapse") selectNode(currentMode.id);
      else handleNodeTap(currentMode.id);
    }
  } else if (currentMode?.type === "resize") {
    if (currentMode.moved) {
      applyResize(currentMode, event.clientX);
      scheduleSave();
    }
  } else if (currentMode?.type === "link") {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".node");
    if (target && !currentMode.sourceIds.includes(target.dataset.id)) {
      checkpoint();
      board.edges = toggleConnectionsToTarget(board.edges, currentMode.sourceIds, target.dataset.id);
      queueEdgeRender();
      scheduleSave();
    }
    linkPreview.toggleAttribute("hidden", true);
    document.querySelectorAll(".node.link-target").forEach((element) => element.classList.remove("link-target"));
  }

  mode = null;
  viewport.classList.remove("panning");
  updateHistoryControls();
}

function cancelGesture() {
  clearLongPress();
  pointers.clear();
  mode = null;
  viewport.classList.remove("panning");
  linkPreview.toggleAttribute("hidden", true);
  hideLasso();
  document.querySelectorAll(".node.link-target").forEach((element) => element.classList.remove("link-target"));
}

function onWheel(event) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const before = screenToWorld({ x: event.clientX, y: event.clientY }, board.view);
    board.view.scale = clamp(board.view.scale * Math.exp(-event.deltaY * 0.008), 0.35, 2);
    board.view.x = event.clientX - before.x * board.view.scale;
    board.view.y = event.clientY - before.y * board.view.scale;
  } else {
    board.view.x -= event.deltaX;
    board.view.y -= event.deltaY;
  }
  applyView();
  scheduleSave();
  updateHistoryControls();
}

function handleCanvasTap() {
  selectNode(null);
}

function toggleTheme(event) {
  event.stopPropagation();
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {}
  updateThemeControl();
}

function setMenuOpen(open) {
  if (open) setBoardPickerOpen(false);
  menu.hidden = !open;
  menuButton.setAttribute("aria-expanded", String(open));
  if (!open) {
    disarmClear();
    disarmExport();
  }
}

function setBoardPickerOpen(open) {
  boardPicker.hidden = !open;
  boardsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    setMenuOpen(false);
    renderBoardList();
  }
}

function renderBoardList() {
  const fragment = document.createDocumentFragment();
  workspace.boards.forEach((item) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "board-list-option";
    option.dataset.id = item.id;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(item.id === workspace.activeId));
    const title = document.createElement("span");
    title.className = "board-list-title";
    title.textContent = item.title || "Untitled";
    option.append(title);
    fragment.append(option);
  });
  boardList.replaceChildren(fragment);
}

function newBoard(event) {
  event?.stopPropagation();
  if (!storageReady) return showToast("本地存储不可用");
  finishCurrentInput();
  saveBoardNow();
  try {
    replaceBoard(createDocument(localStorage, workspace));
    setBoardPickerOpen(false);
  } catch {
    showToast("无法新建画布，请先导出备份");
  }
}

function duplicateBoard(event) {
  event?.stopPropagation();
  if (!storageReady) return showToast("本地存储不可用");
  finishCurrentInput();
  saveBoardNow();
  try {
    replaceBoard(duplicateDocument(localStorage, workspace, board));
    setBoardPickerOpen(false);
  } catch {
    showToast("无法复制画布，请先导出备份");
  }
}

function removeCurrentBoard(event) {
  event?.stopPropagation();
  if (!storageReady) return showToast("本地存储不可用");
  finishCurrentInput();
  saveBoardNow();
  try {
    replaceBoard(deleteDocument(localStorage, workspace, board));
    updateRecoveryControl();
    setBoardPickerOpen(false);
  } catch {
    showToast("无法删除画布");
  }
}

function openBoard(id) {
  if (id === workspace.activeId || !storageReady) {
    setBoardPickerOpen(false);
    return;
  }
  finishCurrentInput();
  saveBoardNow();
  try {
    const loaded = switchDocument(localStorage, workspace, id);
    if (!loaded) return;
    replaceBoard(loaded.board);
    setBoardPickerOpen(false);
  } catch {
    showToast("无法打开这个画布");
  }
}

function replaceBoard(nextBoard) {
  cancelGesture();
  board = normalizeBoard(nextBoard);
  selectedIds.clear();
  selectionMode = false;
  selectedEdgeId = null;
  undoStack.length = 0;
  redoStack.length = 0;
  closeSearch();
  renderAll();
  applyView();
  renderBoardList();
  updateHistoryControls();
}

function restoreRecentBoard(event) {
  event?.stopPropagation();
  if (!storageReady) return;
  finishCurrentInput();
  try {
    const restored = restoreLatest(localStorage, workspace, board);
    if (restored) replaceBoard(restored);
    updateRecoveryControl();
    setMenuOpen(false);
  } catch {
    showToast("无法恢复本地副本");
  }
}

function updateRecoveryControl() {
  restoreButton.hidden = !storageReady || !hasRecovery(localStorage);
}

function finishCurrentInput() {
  hideColorPalette();
  finishBoardTitle();
  finishEdgeLabel();
  finishEditing();
}

function preserveForRecovery(reason) {
  if (!storageReady) return true;
  try {
    captureRecovery(localStorage, workspace.activeId, board, reason);
    updateRecoveryControl();
    return true;
  } catch {
    showToast("无法保存恢复副本，请先导出备份");
    return false;
  }
}

function openSearch(event) {
  event?.preventDefault();
  event?.stopPropagation();
  setMenuOpen(false);
  setBoardPickerOpen(false);
  finishCurrentInput();
  searchPanel.hidden = false;
  updateSearch();
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchInput.blur();
  searchPanel.hidden = true;
  searchMatches = [];
  searchIndex = -1;
  searchInput.value = "";
  searchCount.textContent = "";
  nodeElements.forEach((element) => element.classList.remove("search-match", "search-current"));
}

function updateSearch() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  searchMatches = query
    ? board.nodes.filter((node) => node.text.toLocaleLowerCase().includes(query)).map((node) => node.id)
    : [];
  searchIndex = searchMatches.length ? clamp(searchIndex, 0, searchMatches.length - 1) : -1;
  if (searchIndex < 0 && searchMatches.length) searchIndex = 0;
  updateSearchVisuals();
  if (searchIndex >= 0) revealSearchResult();
}

function moveSearch(step) {
  if (searchMatches.length === 0) return;
  searchIndex = (searchIndex + step + searchMatches.length) % searchMatches.length;
  updateSearchVisuals();
  revealSearchResult();
}

function updateSearchVisuals() {
  const matches = new Set(searchMatches);
  const currentId = searchMatches[searchIndex];
  nodeElements.forEach((element, id) => {
    element.classList.toggle("search-match", matches.has(id));
    element.classList.toggle("search-current", id === currentId);
  });
  searchCount.textContent = searchMatches.length ? `${searchIndex + 1}/${searchMatches.length}` : searchInput.value ? "0" : "";
  searchPreviousButton.disabled = searchMatches.length < 2;
  searchNextButton.disabled = searchMatches.length < 2;
}

function revealSearchResult() {
  const id = searchMatches[searchIndex];
  const node = findNode(id, false);
  const element = nodeElements.get(id);
  if (!node || !element) return;
  board.view.x = viewport.clientWidth / 2 - (node.x + element.offsetWidth / 2) * board.view.scale;
  board.view.y = viewport.clientHeight / 2 - (node.y + element.offsetHeight / 2) * board.view.scale;
  applyView();
  scheduleSave();
}

function onCopy(event) {
  if (document.activeElement?.matches("textarea, input") || selectedIds.size === 0) return;
  const payload = copySelectedGraph(board, selectedIds);
  if (!payload) return;
  clipboardPayload = payload;
  clipboardText = payload.nodes.map((node) => node.text).filter(Boolean).join("\n\n");
  event.preventDefault();
  event.clipboardData.setData("text/plain", clipboardText);
  try {
    event.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(payload));
  } catch {}
}

function onPaste(event) {
  if (document.activeElement?.matches("textarea, input")) return;
  const text = event.clipboardData.getData("text/plain");
  let payload = null;
  try {
    const encoded = event.clipboardData.getData(CLIPBOARD_TYPE);
    if (encoded) payload = JSON.parse(encoded);
  } catch {}
  if (!payload && clipboardPayload && text === clipboardText) payload = clipboardPayload;
  if (payload) {
    event.preventDefault();
    pasteGraph(payload, pasteOrigin());
    return;
  }
  if (!text.trim()) return;
  event.preventDefault();
  const point = screenToWorld({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, board.view);
  checkpoint();
  const node = { id: createId(), text: text.slice(0, 20_000), x: point.x - 109, y: point.y - 24, color: "plain", width: 218 };
  board.nodes.push(node);
  selectedIds.clear();
  selectedIds.add(node.id);
  selectionMode = false;
  renderAll();
  scheduleSave();
}

function duplicateSelection(event) {
  event?.preventDefault();
  event?.stopPropagation();
  const payload = copySelectedGraph(board, selectedIds);
  if (!payload) return;
  clipboardPayload = payload;
  clipboardText = payload.nodes.map((node) => node.text).filter(Boolean).join("\n\n");
  pasteGraph(payload, pasteOrigin());
}

function pasteOrigin() {
  const selected = board.nodes.filter((node) => selectedIds.has(node.id));
  if (selected.length) {
    return {
      x: Math.min(...selected.map((node) => node.x)) + 28,
      y: Math.min(...selected.map((node) => node.y)) + 28,
    };
  }
  const center = screenToWorld({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, board.view);
  return { x: center.x - 109, y: center.y - 24 };
}

function pasteGraph(payload, origin) {
  const pasted = pasteSelectedGraph(payload, origin);
  if (!pasted) return;
  checkpoint();
  board.nodes.push(...pasted.nodes);
  board.edges.push(...pasted.edges);
  selectedIds.clear();
  pasted.nodes.forEach((node) => selectedIds.add(node.id));
  selectionMode = true;
  selectedEdgeId = null;
  renderAll();
  scheduleSave();
}

function disarmClear() {
  menu.classList.remove("confirming-clear");
  cancelClearButton.hidden = true;
  clearButton.setAttribute("aria-label", "清空画布");
}

function showExportChoices(event) {
  event.stopPropagation();
  menu.classList.add("choosing-export");
  [cancelExportButton, exportJsonButton, exportSvgButton, exportMermaidButton].forEach((button) => {
    button.hidden = false;
  });
}

function disarmExport(event) {
  event?.stopPropagation();
  menu.classList.remove("choosing-export");
  [cancelExportButton, exportJsonButton, exportSvgButton, exportMermaidButton].forEach((button) => {
    button.hidden = true;
  });
}

function updateThemeControl() {
  const dark = document.documentElement.dataset.theme === "dark";
  themeButton.setAttribute("aria-pressed", String(dark));
  themeButton.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到暗色模式");
  themeColor.content = dark ? "#16150f" : "#f5f7fb";
}

function handleNodeTap(id) {
  selectNode(id);
}

function onDoubleClick(event) {
  if (event.target.closest(".app-mark, .board-picker, .search-panel, .menu, .menu-button, .theme-button, .history-tools, .selection-bar, .color-palette, .node-actions, .node-editor")) return;
  event.preventDefault();
  const edgeElement = event.target.closest(".edge");
  if (edgeElement) {
    selectEdge(edgeElement.dataset.id);
    openEdgeLabelEditor();
    return;
  }
  const fromPen = performance.now() - lastPenUpAt < 500;
  const node = event.target.closest(".node")
    ?? document.elementFromPoint(event.clientX, event.clientY)?.closest(".node");
  if (node) {
    editNode(node.dataset.id, false, fromPen);
    return;
  }
  const point = screenToWorld({ x: event.clientX, y: event.clientY }, board.view);
  createNode(point.x, point.y, fromPen);
}

function createNode(x, y, fromPen = false) {
  checkpoint();
  const node = { id: createId(), text: "", x, y, color: "plain", width: 218 };
  board.nodes.push(node);
  updateEmptyState();
  renderNode(node, true);
  updateHistoryControls();
  selectNode(node.id);
  editNode(node.id, true, fromPen);
  scheduleSave();
}

function renderAll() {
  nodeLayer.replaceChildren();
  nodeElements.clear();
  board.nodes.forEach((node) => renderNode(node));
  updateBoardTitle();
  updateEmptyState();
  updateSelection();
  updateHistoryControls();
  queueEdgeRender();
}

function updateEmptyState() {
  emptyState.hidden = board.nodes.length > 0;
}

function updateBoardTitle() {
  boardTitle.textContent = board.title || "Untitled";
  document.title = board.title && board.title !== "Untitled" ? `${board.title} · Scattered` : "Scattered";
}

function editBoardTitle() {
  finishEdgeLabel();
  finishEditing();
  boardTitleEditor.dataset.original = board.title || "Untitled";
  boardTitleEditor.value = board.title || "Untitled";
  boardTitle.hidden = true;
  boardTitleEditor.hidden = false;
  boardTitleEditor.focus();
  boardTitleEditor.select();
}

function finishBoardTitle(cancel = false) {
  if (boardTitleEditor.hidden) return;
  const original = boardTitleEditor.dataset.original || "Untitled";
  const nextTitle = cancel ? original : boardTitleEditor.value.trim().slice(0, 120) || "Untitled";
  boardTitleEditor.hidden = true;
  boardTitle.hidden = false;
  if (nextTitle !== board.title) {
    checkpoint();
    board.title = nextTitle;
    updateBoardTitle();
    scheduleSave();
  }
}

function renderNode(node, isNew = false) {
  const element = template.content.firstElementChild.cloneNode(true);
  element.dataset.id = node.id;
  element.dataset.new = String(isNew);
  element.dataset.color = node.color || "plain";
  element.style.setProperty("--node-width", `${node.width || 218}px`);
  element.querySelector(".node-editor").value = node.text;
  syncNodeContent(element, node);
  element.querySelector(".node-delete").addEventListener("click", (event) => {
    event.stopPropagation();
    deleteNode(node.id);
  });
  element.querySelector(".color-handle").addEventListener("click", (event) => {
    event.stopPropagation();
    openColorPalette([node.id], event.currentTarget);
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finishEditing(node.id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEditing(node.id, true);
    }
  });
  element.querySelector(".node-editor").addEventListener("input", (event) => {
    const nextText = event.currentTarget.value.slice(0, 20_000);
    if (node.text !== nextText && element.dataset.editCheckpointed !== "true") {
      checkpoint();
      element.dataset.editCheckpointed = "true";
    }
    node.text = nextText;
    resizeEditor(element);
    scheduleSave();
  });
  element.querySelector(".node-editor").addEventListener("blur", () => finishEditing(node.id));
  nodeElements.set(node.id, element);
  nodeLayer.append(element);
  positionNode(node);
  return element;
}

function positionNode(node) {
  const element = nodeElements.get(node.id);
  if (!element) return;
  element.style.setProperty("--node-x", `${node.x}px`);
  element.style.setProperty("--node-y", `${node.y}px`);
}

function editNode(id, isNew = false, fromPen = false) {
  finishEditing();
  const element = nodeElements.get(id);
  if (!element) return;
  const editor = element.querySelector(".node-editor");
  element.classList.add("editing");
  element.dataset.new = String(isNew);
  element.dataset.editCheckpointed = String(isNew);
  palmGuardUntil = fromPen ? performance.now() + 1200 : 0;
  element.querySelector(".node-text").hidden = true;
  editor.hidden = false;
  resizeEditor(element);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

function finishEditing(onlyId = null, explicitCancel = false) {
  document.querySelectorAll(".node.editing").forEach((element) => {
    if (onlyId && element.dataset.id !== onlyId) return;
    const node = findNode(element.dataset.id);
    const editor = element.querySelector(".node-editor");
    const nextText = editor.value.slice(0, 20_000);
    if (node.text !== nextText) checkpoint();
    node.text = nextText;
    element.classList.remove("editing");
    editor.blur();
    if (shouldDiscardDraft(node.text, element.dataset.new === "true", explicitCancel)) {
      deleteNode(node.id);
      return;
    }
    element.dataset.new = "false";
    syncNodeContent(element, node);
    element.querySelector(".node-text").hidden = false;
    editor.hidden = true;
    scheduleSave();
    requestAnimationFrame(() => {
      renderEdges();
      updateHistoryControls();
    });
  });
}

function syncNodeContent(element, node) {
  const prompt = emptyNotePrompt(node.id);
  const empty = !node.text.trim();
  element.classList.toggle("empty-note", empty);
  element.querySelector(".node-text").textContent = empty ? prompt : node.text;
  element.querySelector(".node-editor").placeholder = prompt;
}

function resizeEditor(element) {
  const editor = element.querySelector(".node-editor");
  editor.style.height = "0";
  editor.style.height = `${Math.max(24, editor.scrollHeight)}px`;
  queueEdgeRender();
}

function selectNode(id) {
  clearEdgeSelection();
  selectedIds.clear();
  if (id) selectedIds.add(id);
  selectionMode = false;
  updateSelection();
}

function selectEdge(id) {
  const edge = findEdge(id, false);
  if (!edge) return;
  if (!edgeLabelEditor.hidden && edgeLabelEditor.dataset.edgeId !== id) finishEdgeLabel();
  selectedEdgeId = id;
  selectedIds.clear();
  selectionMode = false;
  updateSelection();
  edgeLayer.querySelectorAll(".edge").forEach((element) => {
    element.classList.toggle("selected", element.dataset.id === id);
  });
  positionEdgeControls();
}

function clearEdgeSelection() {
  if (!edgeLabelEditor.hidden) finishEdgeLabel();
  selectedEdgeId = null;
  edgeLayer.querySelectorAll(".edge.selected").forEach((element) => element.classList.remove("selected"));
  edgeToolbar.hidden = true;
  edgeLabelEditor.hidden = true;
}

function toggleSelectedEdgeArrow(event) {
  event?.stopPropagation();
  const edge = findEdge(selectedEdgeId, false);
  if (!edge) return;
  checkpoint();
  edge.arrow = nextArrowState(edge.arrow);
  renderEdges();
  scheduleSave();
}

function openEdgeLabelEditor(event) {
  event?.stopPropagation();
  const edge = findEdge(selectedEdgeId, false);
  if (!edge) return;
  edgeLabelEditor.dataset.edgeId = edge.id;
  edgeLabelEditor.dataset.original = edge.label || "";
  edgeLabelEditor.value = edge.label || "";
  edgeToolbar.hidden = true;
  edgeLabelEditor.hidden = false;
  positionEdgeControls();
  edgeLabelEditor.focus();
  edgeLabelEditor.select();
}

function finishEdgeLabel(cancel = false) {
  if (edgeLabelEditor.hidden) return;
  const edge = findEdge(edgeLabelEditor.dataset.edgeId, false);
  const nextLabel = cancel ? edgeLabelEditor.dataset.original : edgeLabelEditor.value.trim().slice(0, 120);
  edgeLabelEditor.hidden = true;
  edgeLabelEditor.blur();
  if (edge && !cancel && edge.label !== nextLabel) {
    checkpoint();
    edge.label = nextLabel;
    scheduleSave();
  }
  renderEdges();
}

function deleteSelectedEdge(event) {
  event?.stopPropagation();
  if (!findEdge(selectedEdgeId, false)) return;
  checkpoint();
  board.edges = board.edges.filter((edge) => edge.id !== selectedEdgeId);
  selectedEdgeId = null;
  edgeToolbar.hidden = true;
  edgeLabelEditor.hidden = true;
  renderEdges();
  scheduleSave();
}

function toggleNodeSelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  if (selectedIds.size === 0) selectionMode = false;
  updateSelection();
}

function updateSelection() {
  const primaryId = selectedIds.values().next().value;
  nodeElements.forEach((element, nodeId) => {
    const selected = selectedIds.has(nodeId);
    element.classList.toggle("selected", selected);
    element.classList.toggle("selection-primary", selected && nodeId === primaryId);
  });
  viewport.classList.toggle("multi-selecting", selectionMode);
  updateSelectionBar();
}

function updateSelectionBar() {
  const visible = selectionMode && selectedIds.size > 0;
  selectionBar.hidden = !visible;
  const connectedEdges = board.edges.filter((edge) => selectedIds.has(edge.from) || selectedIds.has(edge.to));
  const boundaryEdges = connectedEdges.filter((edge) => selectedIds.has(edge.from) !== selectedIds.has(edge.to));
  const directions = new Set(boundaryEdges.map((edge) => edge.arrow || "none"));
  const direction = directions.size > 1 ? "mixed" : directions.values().next().value || "none";
  arrowSelectionButton.disabled = boundaryEdges.length === 0;
  updateArrowButton(arrowSelectionButton, direction, true);
  disconnectSelectionButton.disabled = connectedEdges.length === 0;
}

function updateArrowButton(button, direction, multiple = false) {
  button.dataset.direction = direction;
  button.setAttribute("aria-pressed", direction === "none" ? "false" : direction === "mixed" ? "mixed" : "true");
  const action = direction === "forward"
    ? "反转箭头"
    : direction === "reverse"
      ? "移除箭头"
      : direction === "mixed"
        ? "统一为正向箭头"
        : "添加正向箭头";
  button.setAttribute("aria-label", multiple ? `为所选标签的连线${action}` : action);
}

function openColorPalette(ids, anchor, preferBelow = false) {
  colorTargetIds = ids.filter((id) => findNode(id, false));
  if (colorTargetIds.length === 0) return;
  const colors = new Set(colorTargetIds.map((id) => findNode(id).color || "plain"));
  colorPalette.querySelectorAll(".color-swatch").forEach((swatch) => {
    swatch.setAttribute("aria-pressed", String(colors.size === 1 && colors.has(swatch.dataset.color)));
  });
  colorPalette.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const below = (preferBelow && rect.bottom + 64 <= innerHeight) || rect.top < 64;
  colorPalette.classList.toggle("below", below);
  colorPalette.style.left = `${clamp(rect.left + rect.width / 2, 116, innerWidth - 116)}px`;
  colorPalette.style.top = `${below ? rect.bottom + 8 : rect.top - 8}px`;
}

function hideColorPalette() {
  colorTargetIds = [];
  colorPalette.hidden = true;
  colorPalette.classList.remove("below");
}

function applyColor(color) {
  const targets = new Set(colorTargetIds);
  const changed = board.nodes.filter((node) => targets.has(node.id) && node.color !== color);
  if (changed.length === 0) {
    hideColorPalette();
    return;
  }
  checkpoint();
  changed.forEach((node) => {
    node.color = color;
    nodeElements.get(node.id).dataset.color = color;
  });
  hideColorPalette();
  scheduleSave();
}

function disconnectSelection() {
  const nextEdges = removeConnectionsForNodes(board.edges, selectedIds);
  if (nextEdges.length === board.edges.length) return;
  checkpoint();
  board.edges = nextEdges;
  renderEdges();
  scheduleSave();
}

function toggleSelectionArrows(event) {
  event?.stopPropagation();
  const nextEdges = toggleArrowsForNodes(board.edges, selectedIds);
  if (nextEdges === board.edges) return;
  checkpoint();
  board.edges = nextEdges;
  renderEdges();
  scheduleSave();
}

function deleteSelection() {
  if (selectedIds.size === 0) return;
  const removedIds = new Set(selectedIds);
  checkpoint();
  board.nodes = board.nodes.filter((node) => !removedIds.has(node.id));
  board.edges = board.edges.filter((edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to));
  selectedIds.clear();
  selectionMode = false;
  renderAll();
  scheduleSave();
}

function deleteNode(id, record = true) {
  if (record) checkpoint();
  board.nodes = board.nodes.filter((node) => node.id !== id);
  board.edges = board.edges.filter((edge) => edge.from !== id && edge.to !== id);
  nodeElements.get(id)?.remove();
  nodeElements.delete(id);
  selectedIds.delete(id);
  if (selectedIds.size === 0) selectionMode = false;
  updateSelection();
  renderEdges();
  updateEmptyState();
  updateHistoryControls();
  scheduleSave();
}

function renderEdges() {
  if (edgeRenderFrame) {
    cancelAnimationFrame(edgeRenderFrame);
    edgeRenderFrame = 0;
  }
  if (selectedEdgeId && !findEdge(selectedEdgeId, false)) selectedEdgeId = null;
  const fragment = document.createDocumentFragment();
  board.edges.forEach((edge) => {
    const geometry = edgeGeometry(edge);
    if (!geometry) return;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("edge");
    group.classList.toggle("selected", edge.id === selectedEdgeId);
    group.dataset.id = edge.id;
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");
    group.setAttribute("aria-label", edge.label ? `连线：${edge.label}` : "连线");

    const pathData = geometry.path;
    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hitPath.classList.add("edge-hit");
    hitPath.setAttribute("d", pathData);
    const linePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    linePath.classList.add("edge-line");
    linePath.setAttribute("d", pathData);
    if (edge.arrow === "forward") linePath.setAttribute("marker-end", "url(#edge-arrowhead)");
    if (edge.arrow === "reverse") linePath.setAttribute("marker-start", "url(#edge-arrowhead)");
    group.append(hitPath, linePath);

    if (edge.label) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.classList.add("edge-label");
      label.setAttribute("x", geometry.midpoint.x);
      label.setAttribute("y", geometry.midpoint.y);
      label.textContent = edge.label;
      group.append(label);
    }
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      selectEdge(edge.id);
      if (event.key === "Enter") openEdgeLabelEditor();
    });
    fragment.append(group);
  });
  edgeLayer.replaceChildren(fragment);
  updateSelectionBar();
  positionEdgeControls();
}

function queueEdgeRender() {
  if (edgeRenderFrame) return;
  edgeRenderFrame = requestAnimationFrame(() => {
    edgeRenderFrame = 0;
    renderEdges();
  });
}

function applyResize(target, screenX) {
  if (target.appliedX === screenX) return;
  target.appliedX = screenX;
  const node = findNode(target.id);
  node.width = clamp(target.startWidth + (screenX - target.startX) / board.view.scale, 160, 520);
  nodeElements.get(node.id).style.setProperty("--node-width", `${node.width}px`);
  queueEdgeRender();
}

function updateLinkPreview(screenX, screenY) {
  const to = screenToWorld({ x: screenX, y: screenY }, board.view);
  const paths = mode.sourceIds.flatMap((id) => {
    const from = nodeCenter(id);
    return from ? [connectionCurve(from, to).path] : [];
  });
  if (paths.length === 0) return;
  linkPreview.setAttribute("d", paths.join(" "));
  linkPreview.toggleAttribute("hidden", false);
}

function nodeCenter(id) {
  const node = findNode(id, false);
  const element = nodeElements.get(id);
  if (!node || !element) return null;
  return { x: node.x + element.offsetWidth / 2, y: node.y + element.offsetHeight / 2 };
}

function edgeGeometry(edge) {
  const fromCenter = nodeCenter(edge.from);
  const toCenter = nodeCenter(edge.to);
  if (!fromCenter || !toCenter) return null;
  let from = nodeAnchor(edge.from, toCenter);
  let to = nodeAnchor(edge.to, fromCenter);
  if (edge.arrow) {
    const distance = Math.hypot(from.x - to.x, from.y - to.y);
    const inset = 5 / board.view.scale;
    if (distance > inset) {
      if (edge.arrow === "reverse") {
        from = {
          x: from.x + (to.x - from.x) / distance * inset,
          y: from.y + (to.y - from.y) / distance * inset,
        };
      } else {
        to = {
          x: to.x + (from.x - to.x) / distance * inset,
          y: to.y + (from.y - to.y) / distance * inset,
        };
      }
    }
  }
  const curve = connectionCurve(from, to);
  return {
    from,
    to,
    path: curve.path,
    midpoint: curve.midpoint,
  };
}

function nodeAnchor(id, toward) {
  const center = nodeCenter(id);
  const element = nodeElements.get(id);
  if (!center || !element) return center;
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (dx === 0 && dy === 0) return center;
  const xScale = dx === 0 ? Infinity : element.offsetWidth / 2 / Math.abs(dx);
  const yScale = dy === 0 ? Infinity : element.offsetHeight / 2 / Math.abs(dy);
  const scale = Math.min(xScale, yScale);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function positionEdgeControls() {
  const edge = findEdge(selectedEdgeId, false);
  const geometry = edge && edgeGeometry(edge);
  if (!edge || !geometry) {
    edgeToolbar.hidden = true;
    edgeLabelEditor.hidden = true;
    return;
  }
  const screenX = board.view.x + geometry.midpoint.x * board.view.scale;
  const screenY = board.view.y + geometry.midpoint.y * board.view.scale;
  const top = clamp(screenY + (screenY < 90 ? 46 : -46), 34, innerHeight - 34);
  const left = clamp(screenX, edgeLabelEditor.hidden ? 78 : 118, innerWidth - (edgeLabelEditor.hidden ? 78 : 118));
  const target = edgeLabelEditor.hidden ? edgeToolbar : edgeLabelEditor;
  target.style.left = `${left}px`;
  target.style.top = `${top}px`;
  edgeToolbar.hidden = !edgeLabelEditor.hidden;
  updateArrowButton(edgeArrowButton, edge.arrow || "none");
  edgeLabelButton.setAttribute("aria-pressed", String(Boolean(edge.label)));
}

function applyView() {
  const { x, y, scale } = board.view;
  world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  world.style.setProperty("--control-scale", String(1 / scale));
  world.style.setProperty("--direct-control-offset", `${-(22 + 34 / scale)}px`);
  world.style.setProperty("--node-actions-top", `${-(27 + 39 / scale)}px`);
  viewport.style.setProperty("--grid-x", `${x}px`);
  viewport.style.setProperty("--grid-y", `${y}px`);
  viewport.style.setProperty("--grid-size", `${28 * scale}px`);
  const markerSize = 12 / scale;
  arrowMarker.setAttribute("markerWidth", markerSize);
  arrowMarker.setAttribute("markerHeight", markerSize);
  positionEdgeControls();
}

function fitBoard() {
  finishEdgeLabel();
  finishEditing();
  const nextView = fittedView();
  if (!nextView) return;
  board.view = nextView;
  applyView();
  scheduleSave();
  updateHistoryControls();
}

function fittedView() {
  const bounds = boardBounds();
  return bounds
    ? fitBoundsToViewport(bounds, { width: viewport.clientWidth, height: viewport.clientHeight }, 72)
    : null;
}

function boardBounds() {
  if (board.nodes.length === 0) return null;
  const bounds = board.nodes.reduce((result, node) => {
    const element = nodeElements.get(node.id);
    if (!element) return result;
    result.left = Math.min(result.left, node.x);
    result.top = Math.min(result.top, node.y);
    result.right = Math.max(result.right, node.x + element.offsetWidth);
    result.bottom = Math.max(result.bottom, node.y + element.offsetHeight);
    return result;
  }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  return Number.isFinite(bounds.left) ? bounds : null;
}

function onKeyDown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    openSearch(event);
    return;
  }
  if (!document.activeElement?.matches("textarea, input") && event.code === "Space") {
    event.preventDefault();
    spacePressed = true;
    viewport.classList.add("pan-ready");
    return;
  }
  if (document.activeElement?.matches("textarea, input")) return;
  if (event.key === "Escape" && !searchPanel.hidden) {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (event.key === "Escape" && !boardPicker.hidden) {
    event.preventDefault();
    setBoardPickerOpen(false);
    return;
  }
  if (event.key === "Escape" && !colorPalette.hidden) {
    event.preventDefault();
    hideColorPalette();
    return;
  }
  if (event.key === "Escape" && menu.classList.contains("choosing-export")) {
    event.preventDefault();
    disarmExport();
    return;
  }
  if (event.key === "Escape" && menu.classList.contains("confirming-clear")) {
    event.preventDefault();
    disarmClear();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    clearEdgeSelection();
    selectedIds.clear();
    board.nodes.forEach((node) => selectedIds.add(node.id));
    selectionMode = selectedIds.size > 0;
    updateSelection();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && selectedIds.size > 0) {
    event.preventDefault();
    duplicateSelection();
  } else if ((event.key === "Backspace" || event.key === "Delete") && selectedEdgeId) {
    event.preventDefault();
    deleteSelectedEdge();
  } else if ((event.key === "Backspace" || event.key === "Delete") && selectedIds.size > 0) {
    event.preventDefault();
    if (selectionMode) deleteSelection();
    else deleteNode(selectedIds.values().next().value);
  } else if (event.key === "Escape") {
    if (selectedEdgeId) clearEdgeSelection();
    else selectNode(null);
  }
}

function initializeWorkspace() {
  try {
    return { ...loadWorkspace(localStorage), storageReady: true };
  } catch {
    const id = createId();
    return {
      workspace: { version: 1, activeId: id, boards: [{ id, title: "Untitled", updatedAt: 0 }] },
      board: blankBoard(),
      recovered: false,
      storageReady: false,
    };
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveBoardNow, 180);
}

function saveBoardNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!storageReady) return;
  syncOpenInputs();
  try {
    saveDocument(localStorage, workspace, board);
    renderBoardList();
  } catch {
    showToast("自动保存失败，请先导出备份");
  }
}

function syncOpenInputs() {
  const nextTitle = !boardTitleEditor.hidden ? boardTitleEditor.value.trim().slice(0, 120) || "Untitled" : board.title;
  const openEdge = !edgeLabelEditor.hidden ? findEdge(edgeLabelEditor.dataset.edgeId, false) : null;
  const nextEdgeLabel = openEdge ? edgeLabelEditor.value.trim().slice(0, 120) : null;
  if (nextTitle !== board.title || (openEdge && nextEdgeLabel !== openEdge.label)) checkpoint();
  board.title = nextTitle;
  if (!edgeLabelEditor.hidden) {
    if (openEdge) openEdge.label = nextEdgeLabel;
  }
  document.querySelectorAll(".node.editing").forEach((element) => {
    const node = findNode(element.dataset.id, false);
    if (node) node.text = element.querySelector(".node-editor").value.slice(0, 20_000);
  });
}

function snapshotState() {
  return JSON.stringify({
    title: board.title,
    nodes: board.nodes,
    edges: board.edges,
    selectedIds: [...selectedIds],
    selectionMode,
  });
}

function checkpoint() {
  const snapshot = snapshotState();
  if (undoStack.at(-1) !== snapshot) undoStack.push(snapshot);
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
  updateHistoryControls();
}

function undo() {
  hideColorPalette();
  finishBoardTitle();
  finishEdgeLabel();
  finishEditing();
  applyHistory(undoStack, redoStack);
}

function redo() {
  hideColorPalette();
  finishBoardTitle();
  finishEdgeLabel();
  finishEditing();
  applyHistory(redoStack, undoStack);
}

function applyHistory(source, target) {
  const snapshot = source.pop();
  if (!snapshot) return;
  target.push(snapshotState());
  const restored = JSON.parse(snapshot);
  board.title = restored.title || "Untitled";
  board.nodes = restored.nodes;
  board.edges = restored.edges;
  const existingIds = new Set(board.nodes.map((node) => node.id));
  selectedIds.clear();
  restored.selectedIds.filter((id) => existingIds.has(id)).forEach((id) => selectedIds.add(id));
  selectionMode = restored.selectionMode && selectedIds.size > 0;
  selectedEdgeId = null;
  renderAll();
  scheduleSave();
  updateHistoryControls();
}

function updateHistoryControls() {
  const targetView = fittedView();
  fitButton.disabled = !targetView || (
    Math.abs(board.view.x - targetView.x) < 0.5
    && Math.abs(board.view.y - targetView.y) < 0.5
    && Math.abs(board.view.scale - targetView.scale) < 0.001
  );
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
  historyTools.hidden = board.nodes.length === 0 && undoStack.length === 0 && redoStack.length === 0;
}

function prepareExport(closeMenu = true) {
  finishBoardTitle();
  finishEdgeLabel();
  finishEditing();
  if (closeMenu) setMenuOpen(false);
}

function exportBoard() {
  prepareExport();
  downloadText(JSON.stringify(board, null, 2), "application/json", "json");
}

function exportMermaid() {
  prepareExport();
  downloadText(boardToMermaidMarkdown(board), "text/markdown;charset=utf-8", "md");
}

async function exportSvg(event) {
  event.stopPropagation();
  prepareExport();
  try {
    const filename = `${exportFileName()}.svg`;
    const file = new File([createBoardSvg(board)], filename, { type: "image/svg+xml" });
    const shareData = { files: [file], title: board.title || "Scattered" };
    const canShare = navigator.maxTouchPoints > 0 && navigator.share && navigator.canShare?.(shareData);
    if (canShare) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    downloadBlob(file, filename);
  } catch {
    showToast("SVG 导出失败");
  }
}

function downloadText(content, type, extension) {
  const blob = new Blob([content], { type });
  downloadBlob(blob, `${exportFileName()}.${extension}`);
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
}

function exportFileName() {
  const title = (board.title || "Scattered")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Scattered";
  return `${title}-${new Date().toISOString().slice(0, 10)}`;
}

async function importBoard(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  try {
    const imported = normalizeBoard(JSON.parse(await file.text()));
    checkpoint();
    if (!preserveForRecovery("import")) return;
    board = imported;
    selectedIds.clear();
    selectionMode = false;
    selectedEdgeId = null;
    renderAll();
    applyView();
    scheduleSave();
    updateRecoveryControl();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "无法导入这个文件");
  } finally {
    setMenuOpen(false);
  }
}

function clearBoard() {
  if (!menu.classList.contains("confirming-clear")) {
    menu.classList.add("confirming-clear");
    cancelClearButton.hidden = false;
    clearButton.setAttribute("aria-label", "确认清空画布");
    return;
  }
  checkpoint();
  if (!preserveForRecovery("clear")) return;
  board = blankBoard();
  selectedIds.clear();
  selectionMode = false;
  selectedEdgeId = null;
  renderAll();
  applyView();
  scheduleSave();
  updateRecoveryControl();
  setMenuOpen(false);
}

function showToast(message) {
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 1800);
}

function findNode(id, required = true) {
  const node = board.nodes.find((item) => item.id === id);
  if (!node && required) throw new Error(`Missing node: ${id}`);
  return node;
}

function findEdge(id, required = true) {
  const edge = board.edges.find((item) => item.id === id);
  if (!edge && required) throw new Error(`Missing edge: ${id}`);
  return edge;
}

function pointerDebugState() {
  return {
    mode: mode && {
      type: mode.type,
      pointerId: mode.pointerId,
      pointerType: mode.pointerType,
      moved: !!mode.moved,
    },
    pointers: [...pointers.entries()].map(([id, pointer]) => ({ id, type: pointer.type })),
    selectedEdgeId,
    palmGuardUntil: Math.round(palmGuardUntil),
    scale: Number(board.view.scale.toFixed(3)),
  };
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function addLassoPoints(event) {
  const samples = event.getCoalescedEvents?.() || [];
  const events = samples.length > 0 ? samples : [event];
  events.forEach((sample) => {
    const point = { x: sample.clientX, y: sample.clientY };
    const previous = mode.points.at(-1);
    if (distance(previous, point) >= 2) mode.points.push(point);
  });
  const movement = {
    x: mode.points.at(-1).x - mode.points[0].x,
    y: mode.points.at(-1).y - mode.points[0].y,
  };
  mode.moved ||= hasDragIntent(mode.pointerType, movement.x, movement.y);
  if (!mode.moved) return;
  showSelectionPath(mode.points);
}

function showSelectionPath(points) {
  lassoPath.setAttribute("d", `${points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")} Z`);
  lassoPath.toggleAttribute("hidden", false);
}

function finishLasso(points, toggle = selectionMode) {
  if (points.length < 3) return;
  const enclosed = board.nodes.flatMap((node) => {
    const rect = nodeElements.get(node.id)?.getBoundingClientRect();
    if (!rect) return [];
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return pointInPolygon(center, points) ? [node.id] : [];
  });
  if (enclosed.length === 0 && toggle) return;
  const nextSelection = applyLassoSelection(selectedIds, enclosed, toggle);
  selectedIds.clear();
  nextSelection.forEach((id) => selectedIds.add(id));
  selectionMode = selectedIds.size > 0;
  updateSelection();
}

function hideLasso() {
  lassoPath.toggleAttribute("hidden", true);
  lassoPath.removeAttribute("d");
}

function clearLongPress(target = mode) {
  if (!target?.longPressTimer) return;
  clearTimeout(target.longPressTimer);
  target.longPressTimer = null;
}

function activeTouches() {
  return [...pointers.values()].filter((pointer) => pointer.type === "touch");
}
