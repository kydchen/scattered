import { MIN_VIEW_SCALE, applyLassoSelection, blankBoard, boardToMermaidMarkdown, clamp, connectionCurve, copySelectedGraph, createId, emptyNotePrompt, emptyNotePromptLanguage, fitBoundsToViewport, hasDragIntent, minimumRevealDelta, nextArrowState, normalizeBoard, parseImportedBoard, pasteSelectedGraph, pointInPolygon, rectIntersectsViewport, removeConnectionsForNodes, screenToWorld, shouldDiscardDraft, shouldPinch, shouldResetPointers, toggleArrowsForNodes, toggleConnectionsToTarget } from "./model.js";
import { createBoardSvg } from "./svg-export.js";
import { MAX_WORKSPACE_IMPORT_BYTES, addImportedWorkspace, applySyncWorkspace, clearPendingDocument, createDocument, createSyncWorkspace, createWorkspaceSlots, deleteDocument, duplicateDocument, hasRecovery, loadWorkspace, parseImportedWorkspace, replaceDocument, restoreLatest, saveDocument, stagePendingDocument, switchDocument, withWorkspaceLock } from "./workspace.js";
import { fingerprintSyncWorkspace, isDisposableSyncWorkspace, mergeSyncWorkspaces } from "./sync-model.js";
import { createDriveSync } from "./drive-sync.js";
import { DRIVE_SYNC_API } from "./sync-config.js";
import { applyTranslations, hasMessage, t } from "./i18n.js";

const THEME_KEY = "scattered-theme";
const CONNECTION_STYLE_KEY = "scattered-connection-style";
const CLIPBOARD_TYPE = "application/x-scattered-selection+json";
const DEFAULT_NODE_WIDTH = 218;
const DEFAULT_NODE_HEIGHT = 48;
const CREATION_SAFE_INSETS = { left: 24, right: 24, top: 72, bottom: 72 };
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
const exportButton = document.querySelector("#export-button");
const cancelExportButton = document.querySelector("#cancel-export-button");
const exportJsonButton = document.querySelector("#export-json-button");
const exportSvgButton = document.querySelector("#export-svg-button");
const exportMermaidButton = document.querySelector("#export-mermaid-button");
const importButton = document.querySelector("#import-button");
const clearButton = document.querySelector("#clear-button");
const cancelClearButton = document.querySelector("#cancel-clear-button");
const themeButton = document.querySelector("#theme-button");
const themeColor = document.querySelector('meta[name="theme-color"]');
const toast = document.querySelector("#toast");
const announcer = document.querySelector("#announcer");
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
const cancelDeleteBoardButton = document.querySelector("#cancel-delete-board-button");
const restoreButton = document.querySelector("#restore-button");
const driveSyncButton = document.querySelector("#drive-sync-button");
const cancelDriveButton = document.querySelector("#cancel-drive-button");
const disconnectDriveButton = document.querySelector("#disconnect-drive-button");
const searchButton = document.querySelector("#search-button");
const connectionStyleButton = document.querySelector("#connection-style-button");
const searchPanel = document.querySelector("#search-panel");
const searchInput = document.querySelector("#search-input");
const searchCount = document.querySelector("#search-count");
const searchPreviousButton = document.querySelector("#search-previous");
const searchNextButton = document.querySelector("#search-next");
const searchCloseButton = document.querySelector("#search-close");
const duplicateSelectionButton = document.querySelector("#duplicate-selection");

const workspaceSlots = createWorkspaceSlots(localStorage);
const workspaceStorage = workspaceSlots.storage;
const initialWorkspace = initializeWorkspace();
let workspace = initialWorkspace.workspace;
let board = initialWorkspace.board;
let storageReady = initialWorkspace.storageReady;
let selectionMode = false;
let mode = null;
let saveTimer = null;
let toastTimer = null;
let boardDirty = false;
let saveFailureMessage = "";
let workspaceActionPending = false;
let connectionStyle = readConnectionStyle();
let edgeRenderFrame = 0;
let dragAutoPanFrame = 0;
let dragAutoPanAt = 0;
let revealMotionTimer = null;
let revealViewportFrame = 0;
let palmGuardUntil = 0;
let lastPenUpAt = 0;
let colorTargetIds = [];
let selectedEdgeId = null;
let spacePressed = false;
let clipboardPayload = null;
let clipboardText = "";
let searchMatches = [];
let searchIndex = -1;
let keyboardLinkSourceIds = null;
let colorAnchor = null;
let searchReturnFocus = null;
let announcementFrame = 0;
let driveErrorNotified = false;
const pointers = new Map();
const nodeElements = new Map();
const selectedIds = new Set();
const undoStack = [];
const redoStack = [];
const driveSync = createDriveSync({
  apiUrl: storageReady ? DRIVE_SYNC_API : "",
  storage: localStorage,
  getWorkspace: () => createSyncWorkspace(workspaceStorage, workspace),
  getBoundAccount: () => workspaceSlots.accountKey,
  bindAccount: bindDriveAccount,
  switchAccount: switchDriveAccount,
  applyWorkspace: applyDriveWorkspace,
  canApply: canApplyDriveWorkspace,
  onStatus: updateDriveSyncControl,
  onConflict: (count) => showToast(t("driveConflict", { count }), false, 4_800),
  onError: (error) => {
    driveErrorNotified = true;
    showToast(`${t("driveSyncFailed")} · ${driveSyncErrorCode(error)}`);
  },
});

if (!driveSync.connected && workspaceSlots.accountKey) {
  workspaceSlots.switchToGuest();
  const guestWorkspace = initializeWorkspace();
  workspace = guestWorkspace.workspace;
  board = guestWorkspace.board;
  storageReady = guestWorkspace.storageReady;
}

syncVisualViewportChrome();
applyTranslations();
renderAll();
applyView();
updateHistoryControls();
updateThemeControl();
updateConnectionStyleControl();
renderBoardList();
updateRecoveryControl();
if (!storageReady) markSaveFailure(t("errorStorageUnavailable"));

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
["beforeinput", "click", "dblclick", "pointerdown", "pointermove", "pointerup", "wheel", "paste", "keydown"]
  .forEach((type) => document.addEventListener(type, blockWorkspaceInteraction, { capture: true, passive: false }));
document.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    spacePressed = false;
    viewport.classList.remove("pan-ready");
  }
});
window.addEventListener("resize", () => {
  hideColorPalette();
  syncVisualViewportChrome();
  renderEdges();
  updateHistoryControls();
  revealEditingNode();
});
window.addEventListener("pageshow", restoreVisibleViewport);
window.visualViewport?.addEventListener("resize", handleVisualViewportChange);
window.visualViewport?.addEventListener("scroll", handleVisualViewportChange);
window.addEventListener("blur", () => {
  spacePressed = false;
  viewport.classList.remove("pan-ready", "panning");
  cancelGesture();
  disarmClear();
  disarmDeleteBoard();
});
window.addEventListener("pagehide", () => {
  stagePendingSave();
  void saveBoardNow();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    disarmClear();
    disarmDeleteBoard();
    stagePendingSave();
    void saveBoardNow();
  } else {
    restoreVisibleViewport();
  }
});

function restoreVisibleViewport() {
  if (document.visibilityState === "hidden") return;
  syncVisualViewportChrome();
  requestAnimationFrame(() => {
    syncVisualViewportChrome();
    renderEdges();
    updateHistoryControls();
  });
}

function handleVisualViewportChange() {
  syncVisualViewportChrome();
  revealEditingNode();
}

function syncVisualViewportChrome() {
  const visual = window.visualViewport;
  const offsetTop = Number.isFinite(visual?.offsetTop) ? Math.max(0, visual.offsetTop) : 0;
  viewport.style.setProperty("--visual-offset-top", `${offsetTop}px`);
}

boardsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  if (boardPicker.hidden) {
    finishCurrentInput();
    void saveBoardNow();
  }
  setBoardPickerOpen(boardPicker.hidden);
});
newBoardButton.addEventListener("click", newBoard);
duplicateBoardButton.addEventListener("click", duplicateBoard);
deleteBoardButton.addEventListener("click", removeCurrentBoard);
cancelDeleteBoardButton.addEventListener("click", (event) => {
  event.stopPropagation();
  disarmDeleteBoard();
  deleteBoardButton.focus();
});
boardList.addEventListener("click", (event) => {
  const option = event.target.closest(".board-list-option");
  if (option) openBoard(option.dataset.id);
});
menuButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenuOpen(menu.hidden);
});
themeButton.addEventListener("click", toggleTheme);

exportButton.addEventListener("click", showExportChoices);
cancelExportButton.addEventListener("click", (event) => disarmExport(event, true));
exportJsonButton.addEventListener("click", exportBoard);
exportSvgButton.addEventListener("click", exportSvg);
exportMermaidButton.addEventListener("click", exportMermaid);
importButton.addEventListener("click", () => importInput.click());
importInput.addEventListener("change", importBoard);
searchButton.addEventListener("click", openSearch);
connectionStyleButton.addEventListener("click", toggleConnectionStyle);
restoreButton.addEventListener("click", restoreRecentBoard);
driveSyncButton.addEventListener("click", useDriveSync);
cancelDriveButton.addEventListener("click", (event) => {
  event.stopPropagation();
  disarmDriveControls();
  driveSyncButton.focus();
});
disconnectDriveButton.addEventListener("click", (event) => { void disconnectDriveAccount(event); });
clearButton.addEventListener("click", clearBoard);
cancelClearButton.addEventListener("click", (event) => {
  event.stopPropagation();
  disarmClear();
  clearButton.focus();
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
    const edgeId = edgeLabelEditor.dataset.edgeId;
    finishEdgeLabel();
    requestAnimationFrame(() => focusEdge(edgeId));
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    const edgeId = edgeLabelEditor.dataset.edgeId;
    finishEdgeLabel(true);
    requestAnimationFrame(() => focusEdge(edgeId));
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
    event.stopPropagation();
    finishBoardTitle();
    boardTitle.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    finishBoardTitle(true);
    boardTitle.focus();
  }
});
searchInput.addEventListener("input", updateSearch);
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    moveSearch(event.shiftKey ? -1 : 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeSearch(true);
  }
});
searchPreviousButton.addEventListener("click", () => moveSearch(-1));
searchNextButton.addEventListener("click", () => moveSearch(1));
searchCloseButton.addEventListener("click", () => closeSearch(true));

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

driveSync.start();

if (new URLSearchParams(location.search).get("debug") === "1") {
  import("./debug-client.js")
    .then(({ startPointerDebug }) => startPointerDebug(viewport, pointerDebugState))
    .catch((error) => console.warn("Pointer debug unavailable", error));
}

function onPointerDown(event) {
  finishRevealMotion();
  if (keyboardLinkSourceIds) {
    const control = event.target.closest(".app-mark, .board-picker, .search-panel, .edge-toolbar, .edge-label-editor, .menu, .menu-button, .theme-button, .history-tools, .selection-bar, .color-palette, .node-actions, .resize-handle, .link-handle");
    const primaryPointer = event.pointerType !== "mouse" || event.button === 0;
    if (primaryPointer && !control) {
      const target = event.target.closest(".node");
      if (target) {
        event.preventDefault();
        if (keyboardLinkSourceIds.includes(target.dataset.id)) cancelKeyboardLink(false);
        else connectKeyboardLinkTo(target.dataset.id);
        return;
      }
      if (isBlankCanvasTarget(event.target)) {
        event.preventDefault();
        const sourceIds = [...keyboardLinkSourceIds];
        const point = screenToWorld({ x: event.clientX, y: event.clientY }, board.view);
        finishKeyboardLink();
        createNode(point.x, point.y, event.pointerType === "pen", sourceIds);
        announce(t("linkedNoteCreated"));
        return;
      }
    }
    finishKeyboardLink();
  }
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
    mode = {
      type: "link",
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      sourceIds,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    updateLinkPreview(sourceIds, event.clientX, event.clientY);
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
  if (keyboardLinkSourceIds && event.pointerType !== "touch") {
    updateLinkPreview(keyboardLinkSourceIds, event.clientX, event.clientY);
    updateLinkTarget(keyboardLinkSourceIds, event.clientX, event.clientY);
    return;
  }
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { ...pointers.get(event.pointerId), x: event.clientX, y: event.clientY });

  const touches = activeTouches();
  if (mode?.type === "pinch" && shouldPinch(touches.map((pointer) => pointer.type))) {
    const [a, b] = touches;
    const center = midpoint(a, b);
    const scale = clamp(mode.startScale * (distance(a, b) / Math.max(mode.startDistance, 1)), MIN_VIEW_SCALE, 2);
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
    if (!mode.moved && hasDragIntent(mode.pointerType, screenDx, screenDy)) {
      clearLongPress(mode);
      checkpoint();
      mode.moved = true;
    }
    if (!mode.moved) return;
    moveDraggedNodes(mode, event.clientX, event.clientY);
    requestDragAutoPan();
    return;
  }

  if (mode?.type === "link" && mode.pointerId === event.pointerId) {
    if (!mode.moved && hasDragIntent(mode.pointerType, event.clientX - mode.startX, event.clientY - mode.startY)) {
      mode.moved = true;
    }
    mode.x = event.clientX;
    mode.y = event.clientY;
    updateLinkPreview(mode.sourceIds, event.clientX, event.clientY);
    updateLinkTarget(mode.sourceIds, event.clientX, event.clientY);
    if (mode.moved) requestDragAutoPan();
  }
}

function moveDraggedNodes(target, screenX, screenY) {
  const dx = (screenX - target.startX) / board.view.scale;
  const dy = (screenY - target.startY) / board.view.scale;
  target.positions.forEach((start) => {
    const node = findNode(start.id);
    node.x = start.x + dx;
    node.y = start.y + dy;
    positionNode(node);
  });
  queueEdgeRender();
}

function edgeAutoPanVelocity(point, bounds, inset = 56, maxSpeed = 640) {
  const axis = (value, start, size) => {
    const end = start + size;
    const zone = Math.max(1, Math.min(inset, size / 2));
    if (value < start + zone) {
      const strength = 1 - Math.max(0, value - start) / zone;
      return maxSpeed * strength * strength;
    }
    if (value > end - zone) {
      const strength = 1 - Math.max(0, end - value) / zone;
      return -maxSpeed * strength * strength;
    }
    return 0;
  };
  return {
    x: axis(point.x, bounds.left, bounds.width),
    y: axis(point.y, bounds.top, bounds.height),
  };
}

function requestDragAutoPan() {
  if (!dragAutoPanFrame) dragAutoPanFrame = requestAnimationFrame(runDragAutoPan);
}

function runDragAutoPan(timestamp) {
  dragAutoPanFrame = 0;
  if (!mode?.moved || !["node", "link"].includes(mode.type)) {
    dragAutoPanAt = 0;
    return;
  }
  const pointer = pointers.get(mode.pointerId);
  if (!pointer) {
    dragAutoPanAt = 0;
    return;
  }
  const visual = window.visualViewport;
  const velocity = edgeAutoPanVelocity(pointer, {
    left: 0,
    top: 0,
    width: visual?.width || viewport.clientWidth,
    height: visual?.height || viewport.clientHeight,
  });
  if (!velocity.x && !velocity.y) {
    dragAutoPanAt = 0;
    return;
  }
  const elapsed = dragAutoPanAt ? Math.min((timestamp - dragAutoPanAt) / 1000, 0.032) : 0;
  dragAutoPanAt = timestamp;
  if (elapsed > 0) {
    const dx = velocity.x * elapsed;
    const dy = velocity.y * elapsed;
    board.view.x += dx;
    board.view.y += dy;
    mode.autoPanned = true;
    if (mode.type === "node") {
      mode.startX += dx;
      mode.startY += dy;
      moveDraggedNodes(mode, pointer.x, pointer.y);
    }
    applyView();
    if (mode.type === "link") {
      updateLinkPreview(mode.sourceIds, pointer.x, pointer.y);
      updateLinkTarget(mode.sourceIds, pointer.x, pointer.y);
    }
  }
  dragAutoPanFrame = requestAnimationFrame(runDragAutoPan);
}

function stopDragAutoPan() {
  cancelAnimationFrame(dragAutoPanFrame);
  dragAutoPanFrame = 0;
  dragAutoPanAt = 0;
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
  stopDragAutoPan();

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
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const target = hit?.closest(".node");
    if (target) {
      if (!currentMode.sourceIds.includes(target.dataset.id)) {
        checkpoint();
        board.edges = toggleConnectionsToTarget(board.edges, currentMode.sourceIds, target.dataset.id);
        queueEdgeRender();
        scheduleSave();
      }
    } else {
      const moved = currentMode.moved
        || hasDragIntent(currentMode.pointerType, event.clientX - currentMode.startX, event.clientY - currentMode.startY);
      if (moved && isBlankCanvasTarget(hit)) {
        const point = screenToWorld({ x: event.clientX, y: event.clientY }, board.view);
        createNode(point.x, point.y, event.pointerType === "pen", currentMode.sourceIds);
      }
    }
    linkPreview.toggleAttribute("hidden", true);
    document.querySelectorAll(".node.link-target").forEach((element) => element.classList.remove("link-target"));
  }

  if (currentMode?.autoPanned) scheduleSave();
  mode = null;
  viewport.classList.remove("panning");
  updateHistoryControls();
}

function cancelGesture() {
  const autoPanned = mode?.autoPanned;
  stopDragAutoPan();
  clearLongPress();
  pointers.clear();
  mode = null;
  finishKeyboardLink();
  viewport.classList.remove("panning");
  linkPreview.toggleAttribute("hidden", true);
  hideLasso();
  document.querySelectorAll(".node.link-target").forEach((element) => element.classList.remove("link-target"));
  if (autoPanned) scheduleSave();
}

function onWheel(event) {
  event.preventDefault();
  finishRevealMotion();
  if (event.ctrlKey || event.metaKey) {
    const before = screenToWorld({ x: event.clientX, y: event.clientY }, board.view);
    board.view.scale = clamp(board.view.scale * Math.exp(-event.deltaY * 0.008), MIN_VIEW_SCALE, 2);
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

function readConnectionStyle() {
  try {
    return localStorage.getItem(CONNECTION_STYLE_KEY) === "curved" ? "curved" : "straight";
  } catch {
    return "straight";
  }
}

function toggleConnectionStyle(event) {
  event.stopPropagation();
  connectionStyle = connectionStyle === "straight" ? "curved" : "straight";
  try {
    localStorage.setItem(CONNECTION_STYLE_KEY, connectionStyle);
  } catch {}
  updateConnectionStyleControl();
  renderEdges();
}

function setMenuOpen(open) {
  if (open) setBoardPickerOpen(false);
  menu.hidden = !open;
  menuButton.setAttribute("aria-expanded", String(open));
  if (open) requestAnimationFrame(() => exportButton.focus());
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
    if (driveSync.connected) driveSync.schedule(0);
    requestAnimationFrame(() => boardList.querySelector('[aria-current="true"]')?.focus() || newBoardButton.focus());
  } else {
    disarmDeleteBoard();
    disarmDriveControls();
  }
}

async function useDriveSync(event) {
  event.stopPropagation();
  if (driveSync.connected) {
    driveSync.schedule(0);
    disarmDeleteBoard();
    boardPicker.classList.add("managing-drive");
    cancelDriveButton.hidden = false;
    disconnectDriveButton.hidden = false;
    requestAnimationFrame(() => cancelDriveButton.focus());
    return;
  }
  if (!await commitCurrentBoard()) return;
  driveSync.connect();
}

async function disconnectDriveAccount(event) {
  event.stopPropagation();
  if (!beginWorkspaceAction()) return;
  const previousAccount = workspaceSlots.accountKey;
  try {
    if (!await commitCurrentBoard()) return;
    driveSync.disconnect();
    workspaceSlots.switchToGuest();
    const loaded = await withWorkspaceLock(() => loadWorkspace(workspaceStorage));
    workspace = loaded.workspace;
    replaceBoard(loaded.board);
    clearSaveFailure();
    updateRecoveryControl();
    setBoardPickerOpen(false);
    boardsButton.focus();
  } catch {
    if (previousAccount) workspaceSlots.switchTo(previousAccount);
    showToast(t("driveSyncFailed"));
  } finally {
    endWorkspaceAction();
  }
}

function disarmDriveControls() {
  boardPicker.classList.remove("managing-drive");
  cancelDriveButton.hidden = true;
  disconnectDriveButton.hidden = true;
}

function updateDriveSyncControl(status) {
  driveSyncButton.hidden = status === "unavailable";
  driveSyncButton.dataset.status = status;
  driveSyncButton.setAttribute("aria-busy", String(status === "syncing"));
  const label = {
    unavailable: "connectDrive",
    disconnected: "connectDrive",
    connected: "driveConnected",
    syncing: "driveSyncing",
    synced: "driveSynced",
    error: "driveSyncError",
  }[status] || "connectDrive";
  driveSyncButton.setAttribute("aria-label", t(label));
  if (status === "synced") driveErrorNotified = false;
  if (status === "error" && !driveErrorNotified) {
    driveErrorNotified = true;
    showToast(t("driveSyncFailed"));
  }
  if (["unavailable", "disconnected"].includes(status)) disarmDriveControls();
}

function driveSyncErrorCode(error) {
  const stage = typeof error?.syncStage === "string" && /^[a-z]+$/.test(error.syncStage)
    ? `${error.syncStage}-`
    : "";
  if (error?.code === "auth") return `${stage}auth`;
  const matched = /^Drive sync failed: ([a-z0-9-]+)$/.exec(String(error?.message || ""));
  if (matched) return `${stage}${matched[1]}`;
  if (error?.name === "TypeError") return `${stage}network`;
  const internal = /^([a-z]+)\.([A-Za-z0-9.]+)$/.exec(String(error?.message || ""));
  if (internal) return `${stage}${internal.slice(1).join("-").toLowerCase()}`;
  const name = String(error?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${stage}${!name || name === "error" ? "unknown" : name}`;
}

function canApplyDriveWorkspace() {
  return storageReady
    && !workspaceActionPending
    && !boardDirty
    && !mode
    && selectedIds.size === 0
    && !selectedEdgeId
    && menu.hidden
    && searchPanel.hidden
    && !document.querySelector(".node.editing")
    && boardTitleEditor.hidden
    && edgeLabelEditor.hidden;
}

async function applyDriveWorkspace(nextWorkspace, expectedFingerprint) {
  if (!canApplyDriveWorkspace() || !beginWorkspaceAction()) throw driveBusyError();
  try {
    const incomingActive = nextWorkspace.boards.find((item) => item.id === workspace.activeId)?.board || null;
    const activeWouldChange = !incomingActive || syncBoardContent(incomingActive) !== syncBoardContent(board);
    const applied = await withWorkspaceLock(async () => {
      const latest = createSyncWorkspace(workspaceStorage, workspace);
      if (await fingerprintSyncWorkspace(latest) !== expectedFingerprint) throw driveBusyError();
      const localIds = new Set(latest.boards.map((item) => item.id));
      const nextBoard = applySyncWorkspace(workspaceStorage, workspace, nextWorkspace);
      return { nextBoard, fitIncoming: !localIds.has(workspace.activeId) };
    });
    if (activeWouldChange) replaceBoard(applied.nextBoard, applied.fitIncoming);
    else renderBoardList();
    clearSaveFailure();
    updateRecoveryControl();
  } finally {
    endWorkspaceAction();
  }
}

async function switchDriveAccount(accountKey) {
  if (!canApplyDriveWorkspace() || !beginWorkspaceAction()) throw driveBusyError();
  const previousAccount = workspaceSlots.accountKey;
  const previousWasGuest = workspaceSlots.isGuest;
  const previousWorkspace = workspace;
  const previousBoard = board;
  try {
    const loaded = await withWorkspaceLock(async () => {
      const guest = previousWasGuest ? createSyncWorkspace(workspaceStorage, workspace) : null;
      workspaceSlots.switchTo(accountKey);
      const account = loadWorkspace(workspaceStorage);
      if (!guest || isDisposableSyncWorkspace(guest)) {
        if (guest) workspaceSlots.resetGuest();
        return account;
      }
      const accountSnapshot = createSyncWorkspace(workspaceStorage, account.workspace);
      const claimed = isDisposableSyncWorkspace(accountSnapshot)
        ? guest
        : (await mergeSyncWorkspaces(guest, accountSnapshot, [])).workspace;
      const claimedBoard = applySyncWorkspace(workspaceStorage, account.workspace, claimed);
      workspaceSlots.resetGuest();
      return { workspace: account.workspace, board: claimedBoard };
    });
    workspace = loaded.workspace;
    replaceBoard(loaded.board);
    clearSaveFailure();
    updateRecoveryControl();
  } catch (error) {
    if (previousWasGuest) workspaceSlots.switchToGuest();
    else if (previousAccount) workspaceSlots.switchTo(previousAccount);
    workspace = previousWorkspace;
    replaceBoard(previousBoard);
    throw error;
  } finally {
    endWorkspaceAction();
  }
}

async function bindDriveAccount(accountKey) {
  if (workspaceSlots.isGuest) {
    await switchDriveAccount(accountKey);
    return;
  }
  workspaceSlots.bind(accountKey);
}

function syncBoardContent(value) {
  const { view: _view, ...content } = normalizeBoard(value);
  return JSON.stringify(content);
}

function driveBusyError() {
  const error = new Error("Workspace changed during cloud sync");
  error.code = "busy";
  return error;
}

function armDeleteBoard() {
  boardPicker.classList.add("confirming-delete");
  cancelDeleteBoardButton.hidden = false;
  deleteBoardButton.setAttribute("aria-label", t("confirmDeleteBoard"));
}

function disarmDeleteBoard() {
  boardPicker.classList.remove("confirming-delete");
  cancelDeleteBoardButton.hidden = true;
  deleteBoardButton.setAttribute("aria-label", t("deleteBoard"));
}

function beginWorkspaceAction() {
  if (workspaceActionPending) return false;
  workspaceActionPending = true;
  if (["node", "resize", "pan", "pinch"].includes(mode?.type)) boardDirty = true;
  cancelGesture();
  boardPicker.setAttribute("aria-busy", "true");
  menu.setAttribute("aria-busy", "true");
  [newBoardButton, duplicateBoardButton, deleteBoardButton, cancelDeleteBoardButton, restoreButton, driveSyncButton, cancelDriveButton, disconnectDriveButton, clearButton, cancelClearButton, importButton]
    .forEach((button) => { button.disabled = true; });
  return true;
}

function endWorkspaceAction() {
  workspaceActionPending = false;
  boardPicker.setAttribute("aria-busy", "false");
  menu.setAttribute("aria-busy", "false");
  [newBoardButton, duplicateBoardButton, deleteBoardButton, cancelDeleteBoardButton, restoreButton, driveSyncButton, cancelDriveButton, disconnectDriveButton, clearButton, cancelClearButton, importButton]
    .forEach((button) => { button.disabled = false; });
}

function blockWorkspaceInteraction(event) {
  if (!workspaceActionPending) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function renderBoardList() {
  const fragment = document.createDocumentFragment();
  workspace.boards.forEach((item) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "board-list-option";
    option.dataset.id = item.id;
    if (item.id === workspace.activeId) option.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "board-list-title";
    title.textContent = item.title || "Untitled";
    option.append(title);
    fragment.append(option);
  });
  boardList.replaceChildren(fragment);
}

async function newBoard(event) {
  event?.stopPropagation();
  if (!beginWorkspaceAction()) return;
  try {
    if (!await commitCurrentBoard()) return;
    replaceBoard(await withWorkspaceLock(() => createDocument(workspaceStorage, workspace)));
    driveSync.schedule();
    setBoardPickerOpen(false);
    boardsButton.focus();
  } catch {
    showToast(t("errorCreateBoard"));
  } finally {
    endWorkspaceAction();
  }
}

async function duplicateBoard(event) {
  event?.stopPropagation();
  if (!beginWorkspaceAction()) return;
  try {
    if (!await commitCurrentBoard()) return;
    replaceBoard(await withWorkspaceLock(() => duplicateDocument(workspaceStorage, workspace, board)));
    driveSync.schedule();
    setBoardPickerOpen(false);
    boardsButton.focus();
  } catch {
    showToast(t("errorDuplicateBoard"));
  } finally {
    endWorkspaceAction();
  }
}

async function removeCurrentBoard(event) {
  event?.stopPropagation();
  if (!boardPicker.classList.contains("confirming-delete")) {
    armDeleteBoard();
    return;
  }
  if (!beginWorkspaceAction()) return;
  try {
    if (!await commitCurrentBoard()) return;
    replaceBoard(await withWorkspaceLock(() => deleteDocument(workspaceStorage, workspace)));
    driveSync.schedule();
    clearSaveFailure();
    updateRecoveryControl();
    setBoardPickerOpen(false);
    boardsButton.focus();
  } catch {
    markSaveFailure(t("errorDeleteBoard"));
  } finally {
    endWorkspaceAction();
  }
}

async function openBoard(id) {
  if (id === workspace.activeId) {
    setBoardPickerOpen(false);
    boardsButton.focus();
    return;
  }
  if (!beginWorkspaceAction()) return;
  try {
    if (!await commitCurrentBoard()) return;
    const loaded = await withWorkspaceLock(() => switchDocument(workspaceStorage, workspace, id));
    if (!loaded) return;
    replaceBoard(loaded.board);
    setBoardPickerOpen(false);
    boardsButton.focus();
  } catch {
    showToast(t("errorOpenBoard"));
  } finally {
    endWorkspaceAction();
  }
}

function replaceBoard(nextBoard, fitIncoming = false) {
  cancelGesture();
  board = normalizeBoard(nextBoard);
  boardDirty = false;
  selectedIds.clear();
  selectionMode = false;
  selectedEdgeId = null;
  undoStack.length = 0;
  redoStack.length = 0;
  closeSearch();
  renderAll();
  applyView();
  fitOpenedBoardIfOffscreen(fitIncoming);
  renderBoardList();
  updateHistoryControls();
}

function fitOpenedBoardIfOffscreen(force = false) {
  const visual = { left: 0, top: 0, width: viewport.clientWidth, height: viewport.clientHeight };
  if (!visual.width || !visual.height || board.nodes.length === 0) return;
  const hasVisibleNode = board.nodes.some((node) => {
    const element = nodeElements.get(node.id);
    if (!element) return false;
    const left = board.view.x + node.x * board.view.scale;
    const top = board.view.y + node.y * board.view.scale;
    return rectIntersectsViewport({
      left,
      top,
      right: left + element.offsetWidth * board.view.scale,
      bottom: top + element.offsetHeight * board.view.scale,
    }, visual);
  });
  if (!force && hasVisibleNode) return;
  const nextView = fittedView();
  if (!nextView) return;
  board.view = nextView;
  applyView();
  scheduleSave();
}

async function restoreRecentBoard(event) {
  event?.stopPropagation();
  if (!beginWorkspaceAction()) return;
  try {
    if (!await commitCurrentBoard()) return;
    const restored = await withWorkspaceLock(() => restoreLatest(workspaceStorage, workspace, board));
    if (restored) {
      replaceBoard(restored);
      driveSync.schedule();
    }
    updateRecoveryControl();
    setBoardPickerOpen(false);
    setMenuOpen(false);
    boardsButton.focus();
  } catch {
    showToast(t("errorRestoreBoard"));
  } finally {
    endWorkspaceAction();
  }
}

function updateRecoveryControl() {
  restoreButton.hidden = !storageReady || !hasRecovery(workspaceStorage);
}

function finishCurrentInput() {
  hideColorPalette();
  finishBoardTitle();
  finishEdgeLabel();
  finishEditing();
}

function openSearch(event) {
  event?.preventDefault();
  event?.stopPropagation();
  const active = document.activeElement;
  const returnFocus = active?.closest?.(".search-panel")
    ? searchReturnFocus
    : active?.closest?.("#menu")
      ? menuButton
      : active?.closest?.(".board-picker")
        ? boardsButton
        : active?.closest?.(".color-palette")
          ? colorAnchor
          : active === boardTitleEditor
            ? boardTitle
            : active === edgeLabelEditor
              ? menuButton
              : active?.closest?.(".node") || active;
  setMenuOpen(false);
  setBoardPickerOpen(false);
  finishCurrentInput();
  searchReturnFocus = returnFocus && returnFocus !== document.body ? returnFocus : menuButton;
  searchPanel.hidden = false;
  searchButton.setAttribute("aria-expanded", "true");
  updateSearch();
  searchInput.focus();
  searchInput.select();
}

function closeSearch(restoreFocus = false) {
  searchInput.blur();
  searchPanel.hidden = true;
  searchButton.setAttribute("aria-expanded", "false");
  searchMatches = [];
  searchIndex = -1;
  searchInput.value = "";
  searchCount.textContent = "";
  nodeElements.forEach((element) => element.classList.remove("search-match", "search-current"));
  if (restoreFocus) searchReturnFocus?.focus?.();
  searchReturnFocus = null;
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
  const current = findNode(currentId, false);
  if (current) {
    searchCount.setAttribute("aria-label", t("searchPosition", {
      current: searchIndex + 1,
      total: searchMatches.length,
      text: accessibleNoteText(current),
    }));
  } else {
    searchCount.removeAttribute("aria-label");
  }
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
  requestAnimationFrame(() => nodeElements.get(node.id)?.focus());
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
  requestAnimationFrame(() => nodeElements.get(pasted.nodes[0]?.id)?.focus());
}

function disarmClear() {
  menu.classList.remove("confirming-clear");
  cancelClearButton.hidden = true;
  clearButton.setAttribute("aria-label", t("clearBoard"));
}

function showExportChoices(event) {
  event.stopPropagation();
  menu.classList.add("choosing-export");
  exportButton.setAttribute("aria-expanded", "true");
  [cancelExportButton, exportJsonButton, exportSvgButton, exportMermaidButton].forEach((button) => {
    button.hidden = false;
  });
  requestAnimationFrame(() => exportJsonButton.focus());
}

function disarmExport(event, restoreFocus = false) {
  event?.stopPropagation();
  menu.classList.remove("choosing-export");
  exportButton.setAttribute("aria-expanded", "false");
  [cancelExportButton, exportJsonButton, exportSvgButton, exportMermaidButton].forEach((button) => {
    button.hidden = true;
  });
  if (restoreFocus) exportButton.focus();
}

function updateThemeControl() {
  const dark = document.documentElement.dataset.theme === "dark";
  themeButton.setAttribute("aria-pressed", String(dark));
  themeButton.setAttribute("aria-label", t("darkMode"));
  themeColor.content = dark ? "#16150f" : "#f2f4f7";
}

function updateConnectionStyleControl() {
  const curved = connectionStyle === "curved";
  connectionStyleButton.dataset.style = connectionStyle;
  connectionStyleButton.setAttribute("aria-pressed", String(curved));
  connectionStyleButton.setAttribute("aria-label", t(curved ? "curvedConnections" : "straightConnections"));
}

function handleNodeTap(id) {
  selectNode(id);
}

function onDoubleClick(event) {
  if (event.target.closest(".app-mark, .board-picker, .search-panel, .menu, .menu-button, .theme-button, .history-tools, .selection-bar, .color-palette, .node-actions, .node-editor, .resize-handle, .link-handle")) return;
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

function createNode(centerX, centerY, fromPen = false, sourceIds = []) {
  checkpoint();
  const node = {
    id: createId(),
    text: "",
    x: centerX - DEFAULT_NODE_WIDTH / 2,
    y: centerY - DEFAULT_NODE_HEIGHT / 2,
    color: "plain",
    width: DEFAULT_NODE_WIDTH,
  };
  board.nodes.push(node);
  if (sourceIds.length) board.edges = toggleConnectionsToTarget(board.edges, sourceIds, node.id);
  updateEmptyState();
  renderNode(node, true);
  if (sourceIds.length) queueEdgeRender();
  updateHistoryControls();
  selectNode(node.id);
  editNode(node.id, true, fromPen);
  softlyRevealNode(node.id);
  scheduleSave();
}

function revealEditingNode() {
  if (revealViewportFrame) return;
  revealViewportFrame = requestAnimationFrame(() => {
    revealViewportFrame = 0;
    const id = document.querySelector(".node.editing")?.dataset.id;
    if (id) softlyRevealNode(id);
  });
}

function softlyRevealNode(id) {
  const element = nodeElements.get(id);
  const node = findNode(id, false);
  if (!element || !node) return;
  const visual = window.visualViewport;
  const visibleViewport = {
    left: visual?.offsetLeft || 0,
    top: visual?.offsetTop || 0,
    width: visual?.width || viewport.clientWidth,
    height: visual?.height || viewport.clientHeight,
  };
  const scale = board.view.scale;
  const left = board.view.x + node.x * scale;
  const top = board.view.y + node.y * scale;
  const delta = minimumRevealDelta({
    left,
    top,
    right: left + element.offsetWidth * scale,
    bottom: top + element.offsetHeight * scale,
  }, visibleViewport, CREATION_SAFE_INSETS);
  if (Math.abs(delta.x) < 0.5 && Math.abs(delta.y) < 0.5) return;
  // ponytail: preserve the user's zoom; if a note cannot fit, center it on that axis instead of auto-zooming.
  viewport.classList.add("revealing-note");
  board.view.x += delta.x;
  board.view.y += delta.y;
  applyView();
  scheduleSave();
  updateHistoryControls();
  clearTimeout(revealMotionTimer);
  revealMotionTimer = setTimeout(finishRevealMotion, 220);
}

function finishRevealMotion() {
  clearTimeout(revealMotionTimer);
  cancelAnimationFrame(revealViewportFrame);
  revealMotionTimer = null;
  revealViewportFrame = 0;
  viewport.classList.remove("revealing-note");
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
  const title = board.title || "Untitled";
  boardTitle.textContent = title;
  boardTitle.setAttribute("aria-label", t("boardTitleEdit", { title }));
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
  applyTranslations(element);
  element.dataset.id = node.id;
  element.dataset.new = String(isNew);
  element.dataset.color = node.color || "plain";
  element.style.setProperty("--node-width", `${node.width || 218}px`);
  element.querySelector(".node-editor").value = node.text;
  syncNodeContent(element, node);
  const editor = element.querySelector(".node-editor");
  const resizeHandle = element.querySelector(".resize-handle");
  const linkHandle = element.querySelector(".link-handle");
  element.querySelector(".node-delete").addEventListener("click", (event) => {
    event.stopPropagation();
    deleteNode(node.id);
  });
  element.querySelector(".color-handle").addEventListener("click", (event) => {
    event.stopPropagation();
    openColorPalette([node.id], event.currentTarget);
  });
  resizeHandle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) checkpoint();
    const step = (event.shiftKey ? 32 : 8) * (event.key === "ArrowLeft" ? -1 : 1);
    node.width = clamp((node.width || 218) + step, 160, 520);
    element.style.setProperty("--node-width", `${node.width}px`);
    queueEdgeRender();
    scheduleSave();
  });
  linkHandle.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.has(node.id)) selectNode(node.id);
    startKeyboardLink(selectionMode ? [...selectedIds] : [node.id]);
  });
  element.addEventListener("keydown", (event) => {
    if (event.target === editor) {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        finishEditing(node.id);
        nodeElements.get(node.id)?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finishEditing(node.id, true);
        nodeElements.get(node.id)?.focus();
      }
      return;
    }
    if (event.target !== element) return;
    if (keyboardLinkSourceIds && event.key === "Enter" && !keyboardLinkSourceIds.includes(node.id)) {
      event.preventDefault();
      event.stopPropagation();
      connectKeyboardLinkTo(node.id);
    } else if (event.key.toLowerCase() === "l") {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedIds.has(node.id)) selectNode(node.id);
      startKeyboardLink(selectionMode ? [...selectedIds] : [node.id]);
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      event.stopPropagation();
      editNode(node.id);
    } else if (event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        selectionMode = true;
        toggleNodeSelection(node.id);
      } else {
        selectNode(node.id);
      }
      announce(t("selectedNotes", { count: selectedIds.size }));
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      moveNodesWithKeyboard(node.id, event);
    }
  });
  editor.addEventListener("input", (event) => {
    const nextText = event.currentTarget.value.slice(0, 20_000);
    if (node.text !== nextText && element.dataset.editCheckpointed !== "true") {
      checkpoint();
      element.dataset.editCheckpointed = "true";
    }
    node.text = nextText;
    resizeEditor(element);
    scheduleSave();
  });
  editor.addEventListener("blur", () => finishEditing(node.id));
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
  const promptLanguage = emptyNotePromptLanguage(node.id);
  const empty = !node.text.trim();
  element.classList.toggle("empty-note", empty);
  const text = element.querySelector(".node-text");
  const editor = element.querySelector(".node-editor");
  text.textContent = empty ? prompt : node.text;
  element.dataset.overviewLabel = (empty ? prompt : node.text).trim().replace(/\s+/g, " ").slice(0, 80);
  if (empty) text.lang = promptLanguage;
  else text.removeAttribute("lang");
  editor.placeholder = prompt;
  updateNodeAccessibility(element, node);
}

function updateNodeAccessibility(element, node) {
  const text = accessibleNoteText(node);
  const connections = board.edges.filter((edge) => edge.from === node.id || edge.to === node.id).length;
  const selected = selectedIds.has(node.id) ? t("noteSelectedSuffix") : "";
  const connected = connections ? t("noteConnectionsSuffix", { count: connections }) : "";
  element.setAttribute("aria-label", `${t("noteName", { text })}${selected}${connected}`);
  element.setAttribute("aria-keyshortcuts", "Enter F2 Space Shift+Space Delete ArrowUp ArrowDown ArrowLeft ArrowRight L");
}

function accessibleNoteText(node) {
  return node.text.trim().replace(/\s+/g, " ").slice(0, 80) || t("emptyNote");
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

function moveNodesWithKeyboard(focusedId, event) {
  if (!selectedIds.has(focusedId)) selectNode(focusedId);
  const step = event.shiftKey ? 10 : 1;
  const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
  const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
  if (!event.repeat) checkpoint();
  selectedIds.forEach((id) => {
    const node = findNode(id, false);
    if (!node) return;
    node.x += dx;
    node.y += dy;
    positionNode(node);
  });
  queueEdgeRender();
  scheduleSave();
}

function startKeyboardLink(sourceIds) {
  keyboardLinkSourceIds = [...new Set(sourceIds)].filter((id) => findNode(id, false));
  if (keyboardLinkSourceIds.length === 0) return;
  viewport.classList.add("keyboard-linking");
  announce(t("connectionMode"));
}

function connectKeyboardLinkTo(targetId) {
  if (!keyboardLinkSourceIds?.length || keyboardLinkSourceIds.includes(targetId)) return;
  checkpoint();
  board.edges = toggleConnectionsToTarget(board.edges, keyboardLinkSourceIds, targetId);
  finishKeyboardLink();
  renderEdges();
  scheduleSave();
  announce(t("connectionUpdated"));
  nodeElements.get(targetId)?.focus();
}

function finishKeyboardLink() {
  keyboardLinkSourceIds = null;
  viewport.classList.remove("keyboard-linking");
  linkPreview.toggleAttribute("hidden", true);
  document.querySelectorAll(".node.link-target").forEach((element) => element.classList.remove("link-target"));
}

function cancelKeyboardLink(shouldAnnounce = true) {
  if (!keyboardLinkSourceIds) return false;
  const sourceId = keyboardLinkSourceIds[0];
  finishKeyboardLink();
  if (shouldAnnounce) announce(t("connectionCancelled"));
  nodeElements.get(sourceId)?.focus();
  return true;
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
  const edge = findEdge(selectedEdgeId, false);
  if (!edge) return;
  checkpoint();
  board.edges = board.edges.filter((edge) => edge.id !== selectedEdgeId);
  selectedEdgeId = null;
  edgeToolbar.hidden = true;
  edgeLabelEditor.hidden = true;
  renderEdges();
  scheduleSave();
  requestAnimationFrame(() => focusNoteOrBoards(edge.from));
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
    const node = findNode(nodeId, false);
    if (node) updateNodeAccessibility(element, node);
  });
  viewport.classList.toggle("multi-selecting", selectionMode);
  updateSelectionBar();
}

function updateSelectionBar() {
  const visible = selectionMode && selectedIds.size > 0;
  selectionBar.hidden = !visible;
  const connectedEdges = board.edges.filter((edge) => selectedIds.has(edge.from) || selectedIds.has(edge.to));
  const directions = new Set(connectedEdges.map((edge) => edge.arrow || "none"));
  const direction = directions.size > 1 ? "mixed" : directions.values().next().value || "none";
  arrowSelectionButton.disabled = connectedEdges.length === 0;
  arrowSelectionButton.setAttribute("aria-label", arrowAction(direction));
  disconnectSelectionButton.disabled = connectedEdges.length === 0;
}

function updateArrowButton(button, direction) {
  button.dataset.direction = direction;
  button.setAttribute("aria-label", arrowAction(direction));
}

function arrowAction(direction) {
  return direction === "forward"
    ? t("reverseArrow")
    : direction === "reverse"
      ? t("removeArrow")
      : direction === "mixed"
        ? t("unifyForwardArrow")
        : t("addForwardArrow");
}

function openColorPalette(ids, anchor, preferBelow = false) {
  colorTargetIds = ids.filter((id) => findNode(id, false));
  if (colorTargetIds.length === 0) return;
  colorAnchor?.setAttribute("aria-expanded", "false");
  colorAnchor = anchor;
  colorAnchor.setAttribute("aria-expanded", "true");
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
  requestAnimationFrame(() => colorPalette.querySelector('[aria-pressed="true"]')?.focus()
    || colorPalette.querySelector(".color-swatch")?.focus());
}

function hideColorPalette(restoreFocus = false) {
  const anchor = colorAnchor;
  anchor?.setAttribute("aria-expanded", "false");
  colorAnchor = null;
  colorTargetIds = [];
  colorPalette.hidden = true;
  colorPalette.classList.remove("below");
  if (restoreFocus) anchor?.focus?.();
}

function applyColor(color) {
  const targets = new Set(colorTargetIds);
  const changed = board.nodes.filter((node) => targets.has(node.id) && node.color !== color);
  if (changed.length === 0) {
    hideColorPalette(true);
    return;
  }
  checkpoint();
  changed.forEach((node) => {
    node.color = color;
    nodeElements.get(node.id).dataset.color = color;
  });
  hideColorPalette(true);
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
  requestAnimationFrame(() => focusNoteOrBoards());
}

function deleteNode(id, record = true) {
  const element = nodeElements.get(id);
  const restoreFocus = element?.contains(document.activeElement);
  const index = board.nodes.findIndex((node) => node.id === id);
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
  if (restoreFocus) {
    const nextId = board.nodes[Math.min(Math.max(index, 0), board.nodes.length - 1)]?.id;
    requestAnimationFrame(() => focusNoteOrBoards(nextId));
  }
}

function focusNoteOrBoards(id) {
  const target = id ? nodeElements.get(id) : nodeElements.values().next().value;
  (target || boardsButton).focus();
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
    group.setAttribute("aria-label", edgeAccessibleName(edge));
    group.setAttribute("aria-keyshortcuts", "Enter Space Delete");

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
      if (!["Enter", " ", "Backspace", "Delete"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      selectEdge(edge.id);
      if (event.key === "Enter") openEdgeLabelEditor();
      if (event.key === "Backspace" || event.key === "Delete") deleteSelectedEdge();
    });
    fragment.append(group);
  });
  edgeLayer.replaceChildren(fragment);
  nodeElements.forEach((element, nodeId) => {
    const node = findNode(nodeId, false);
    if (node) updateNodeAccessibility(element, node);
  });
  updateSelectionBar();
  positionEdgeControls();
}

function edgeAccessibleName(edge) {
  const fromNode = findNode(edge.from, false);
  const toNode = findNode(edge.to, false);
  let from = fromNode ? accessibleNoteText(fromNode) : t("untitledNote");
  let to = toNode ? accessibleNoteText(toNode) : t("untitledNote");
  if (edge.arrow === "reverse") [from, to] = [to, from];
  const connection = edge.arrow
    ? t("edgeDirected", { from, to })
    : t("edgeUndirected", { from, to });
  return edge.label ? `${connection}${t("edgeLabelSuffix", { label: edge.label })}` : connection;
}

function focusEdge(id) {
  [...edgeLayer.querySelectorAll(".edge")].find((element) => element.dataset.id === id)?.focus();
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

function updateLinkPreview(sourceIds, screenX, screenY) {
  const to = screenToWorld({ x: screenX, y: screenY }, board.view);
  const paths = sourceIds.flatMap((id) => {
    const from = nodeCenter(id);
    return from ? [connectionCurve(from, to, connectionStyle).path] : [];
  });
  if (paths.length === 0) return;
  linkPreview.setAttribute("d", paths.join(" "));
  linkPreview.toggleAttribute("hidden", false);
}

function updateLinkTarget(sourceIds, screenX, screenY) {
  document.querySelectorAll(".node.link-target").forEach((element) => element.classList.remove("link-target"));
  const target = document.elementFromPoint(screenX, screenY)?.closest(".node");
  if (target && !sourceIds.includes(target.dataset.id)) target.classList.add("link-target");
}

function isBlankCanvasTarget(element) {
  return element?.id === "gesture-surface";
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
  const curve = connectionCurve(from, to, connectionStyle);
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
  edgeLabelButton.classList.toggle("active", Boolean(edge.label));
}

function applyView() {
  const { x, y, scale } = board.view;
  world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  world.style.setProperty("--overview-min-width", `${56 / scale}px`);
  world.style.setProperty("--overview-min-height", `${18 / scale}px`);
  world.style.setProperty("--overview-border-width", `${1 / scale}px`);
  world.style.setProperty("--overview-radius", `${6 / scale}px`);
  world.style.setProperty("--overview-shadow-y", `${2 / scale}px`);
  world.style.setProperty("--overview-shadow-blur", `${8 / scale}px`);
  world.style.setProperty("--overview-font-size", `${9 / scale}px`);
  world.style.setProperty("--overview-label-padding", `${6 / scale}px`);
  world.style.setProperty("--control-scale", String(1 / scale));
  world.style.setProperty("--direct-control-offset", `${-(22 + 34 / scale)}px`);
  world.style.setProperty("--node-actions-top", `${-(27 + 39 / scale)}px`);
  viewport.style.setProperty("--grid-x", `${x}px`);
  viewport.style.setProperty("--grid-y", `${y}px`);
  viewport.style.setProperty("--grid-size", `${Math.max(16, 28 * scale)}px`);
  viewport.classList.toggle("overview", scale < 0.3);
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
  const activeElement = document.activeElement;
  const canvasShortcutTarget = !activeElement
    || activeElement === document.body
    || activeElement === document.documentElement
    || activeElement.classList?.contains("node")
    || (keyboardLinkSourceIds && activeElement.classList?.contains("link-handle"));
  const overlayOpen = !menu.hidden || !boardPicker.hidden || !searchPanel.hidden || !colorPalette.hidden;
  if (canvasShortcutTarget && !overlayOpen && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    const point = screenToWorld({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, board.view);
    const sourceIds = keyboardLinkSourceIds || [];
    createNode(point.x, point.y, false, sourceIds);
    finishKeyboardLink();
    announce(t(sourceIds.length ? "linkedNoteCreated" : "noteCreated"));
    return;
  }
  if (!activeElement?.matches("textarea, input, button, a, [role=button]") && event.code === "Space") {
    event.preventDefault();
    spacePressed = true;
    viewport.classList.add("pan-ready");
    return;
  }
  if (activeElement?.matches("textarea, input")) return;
  if (event.key === "Escape" && cancelKeyboardLink()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && !searchPanel.hidden) {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (event.key === "Escape" && boardPicker.classList.contains("confirming-delete")) {
    event.preventDefault();
    disarmDeleteBoard();
    deleteBoardButton.focus();
    return;
  }
  if (event.key === "Escape" && !boardPicker.hidden) {
    event.preventDefault();
    setBoardPickerOpen(false);
    boardsButton.focus();
    return;
  }
  if (event.key === "Escape" && !colorPalette.hidden) {
    event.preventDefault();
    hideColorPalette(true);
    return;
  }
  if (event.key === "Escape" && menu.classList.contains("choosing-export")) {
    event.preventDefault();
    disarmExport(null, true);
    return;
  }
  if (event.key === "Escape" && menu.classList.contains("confirming-clear")) {
    event.preventDefault();
    disarmClear();
    clearButton.focus();
    return;
  }
  if (event.key === "Escape" && !menu.hidden) {
    event.preventDefault();
    setMenuOpen(false);
    menuButton.focus();
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
  } else if ((event.key === "Backspace" || event.key === "Delete") && activeElement?.classList.contains("node") && !selectedIds.has(activeElement.dataset.id)) {
    event.preventDefault();
    deleteNode(activeElement.dataset.id);
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
    return { ...loadWorkspace(workspaceStorage), storageReady: true };
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
  boardDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void saveBoardNow(); }, 180);
}

function stagePendingSave() {
  if (!storageReady) return;
  syncOpenInputs();
  if (!boardDirty) return;
  try {
    stagePendingDocument(workspaceStorage, workspace, board);
  } catch {
    markSaveFailure(t("errorSave"));
  }
}

async function saveBoardNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  syncOpenInputs();
  if (!storageReady) {
    markSaveFailure(t("errorStorageUnavailable"));
    return false;
  }
  if (!boardDirty) return true;
  try {
    const savedSuccessfully = await withWorkspaceLock(() => {
      const previousId = workspace.activeId;
      const saved = saveDocument(workspaceStorage, workspace, board);
      const conflicted = workspace.activeId !== previousId;
      if (conflicted) {
        cancelGesture();
        closeSearch();
        board = saved;
        renderAll();
        applyView();
      }
      boardDirty = false;
      clearPendingDocument(workspaceStorage);
      clearSaveFailure();
      renderBoardList();
      if (conflicted) showToast(t("conflictCopy"));
      return true;
    });
    if (savedSuccessfully) driveSync.schedule();
    return savedSuccessfully;
  } catch {
    markSaveFailure(t("errorSave"));
    return false;
  }
}

async function commitCurrentBoard() {
  finishCurrentInput();
  return saveBoardNow();
}

async function replaceCurrentBoard(nextBoard, recoveryReason) {
  if (!beginWorkspaceAction()) return false;
  const previousId = workspace.activeId;
  let previousBoard;
  let saved;
  try {
    if (!await commitCurrentBoard()) return false;
    previousBoard = JSON.stringify(normalizeBoard(board));
    saved = await withWorkspaceLock(() => replaceDocument(workspaceStorage, workspace, nextBoard, recoveryReason));
    clearSaveFailure();
    driveSync.schedule();
  } catch {
    markSaveFailure(t("errorSave"));
    return false;
  } finally {
    endWorkspaceAction();
  }
  if (workspace.activeId !== previousId) {
    replaceBoard(saved);
    updateRecoveryControl();
    showToast(t("conflictCopy"));
    return true;
  }
  cancelGesture();
  closeSearch();
  if (previousBoard !== JSON.stringify(saved)) checkpoint();
  board = saved;
  boardDirty = false;
  selectedIds.clear();
  selectionMode = false;
  selectedEdgeId = null;
  renderAll();
  applyView();
  renderBoardList();
  updateRecoveryControl();
  return true;
}

function syncOpenInputs() {
  const nextTitle = !boardTitleEditor.hidden ? boardTitleEditor.value.trim().slice(0, 120) || "Untitled" : board.title;
  const openEdge = !edgeLabelEditor.hidden ? findEdge(edgeLabelEditor.dataset.edgeId, false) : null;
  const nextEdgeLabel = openEdge ? edgeLabelEditor.value.trim().slice(0, 120) : null;
  let changed = nextTitle !== board.title || (openEdge && nextEdgeLabel !== openEdge.label);
  if (changed) checkpoint();
  board.title = nextTitle;
  if (!edgeLabelEditor.hidden) {
    if (openEdge) openEdge.label = nextEdgeLabel;
  }
  document.querySelectorAll(".node.editing").forEach((element) => {
    const node = findNode(element.dataset.id, false);
    if (!node) return;
    const nextText = element.querySelector(".node-editor").value.slice(0, 20_000);
    if (node.text !== nextText) changed = true;
    node.text = nextText;
  });
  if (changed) boardDirty = true;
  return changed;
}

function snapshotState() {
  return JSON.stringify({
    title: board.title,
    nodes: board.nodes,
    edges: board.edges,
    view: board.view,
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
  const focusedNodeId = document.activeElement?.closest?.(".node")?.dataset.id;
  const focusedEdgeId = document.activeElement?.closest?.(".edge")?.dataset.id;
  target.push(snapshotState());
  const restored = JSON.parse(snapshot);
  board.title = restored.title || "Untitled";
  board.nodes = restored.nodes;
  board.edges = restored.edges;
  board.view = restored.view || board.view;
  const existingIds = new Set(board.nodes.map((node) => node.id));
  selectedIds.clear();
  restored.selectedIds.filter((id) => existingIds.has(id)).forEach((id) => selectedIds.add(id));
  selectionMode = restored.selectionMode && selectedIds.size > 0;
  selectedEdgeId = null;
  renderAll();
  applyView();
  scheduleSave();
  updateHistoryControls();
  if (focusedNodeId || focusedEdgeId) {
    requestAnimationFrame(() => {
      if (focusedNodeId && nodeElements.has(focusedNodeId)) nodeElements.get(focusedNodeId).focus();
      else if (focusedEdgeId && findEdge(focusedEdgeId, false)) focusEdge(focusedEdgeId);
      else focusNoteOrBoards(selectedIds.values().next().value);
    });
  }
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

async function exportBoard() {
  prepareExport();
  try {
    const content = JSON.stringify(normalizeBoard(board), null, 2);
    await shareOrDownloadBlob(
      new Blob([content], { type: "application/json" }),
      `${exportFileName()}.json`,
      board.title || "Scattered",
    );
  } catch {
    showToast(t("errorJsonExport"));
  } finally {
    menuButton.focus();
  }
}

async function exportMermaid() {
  prepareExport();
  try {
    await shareOrDownloadBlob(
      new Blob([boardToMermaidMarkdown(board)], { type: "text/markdown;charset=utf-8" }),
      `${exportFileName()}.md`,
      board.title || "Scattered",
    );
  } catch {
    showToast(t("errorMermaidExport"));
  } finally {
    menuButton.focus();
  }
}

async function exportSvg(event) {
  event.stopPropagation();
  prepareExport();
  try {
    const filename = `${exportFileName()}.svg`;
    await shareOrDownloadBlob(
      new Blob([createBoardSvg(board, connectionStyle)], { type: "image/svg+xml" }),
      filename,
      board.title || "Scattered",
    );
  } catch {
    showToast(t("errorSvgExport"));
  } finally {
    menuButton.focus();
  }
}

async function shareOrDownloadBlob(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  const shareData = { files: [file], title };
  let canShare = false;
  try { canShare = Boolean(navigator.share && navigator.canShare?.(shareData)); } catch {}
  if (canShare) {
    try {
      await navigator.share(shareData);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  downloadBlob(file, filename);
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
    if (file.size > MAX_WORKSPACE_IMPORT_BYTES) throw new Error("import.workspaceTooLarge");
    const encoded = await file.text();
    const importedWorkspace = parseImportedWorkspace(encoded);
    if (importedWorkspace) await mergeImportedWorkspace(importedWorkspace);
    else await replaceCurrentBoard(parseImportedBoard(encoded), "import");
  } catch (error) {
    showToast(error instanceof Error && hasMessage(error.message) ? t(error.message) : t("errorImport"));
  } finally {
    setMenuOpen(false);
    menuButton.focus();
  }
}

async function mergeImportedWorkspace(imported) {
  if (!beginWorkspaceAction()) return false;
  try {
    if (!await commitCurrentBoard()) return false;
    const importedBoard = await withWorkspaceLock(() => addImportedWorkspace(workspaceStorage, workspace, imported));
    replaceBoard(importedBoard);
    driveSync.schedule();
    clearSaveFailure();
    announce(t("workspaceImported", { count: imported.boards.length }));
    menuButton.focus();
    return true;
  } finally {
    endWorkspaceAction();
  }
}

async function clearBoard() {
  if (!menu.classList.contains("confirming-clear")) {
    menu.classList.add("confirming-clear");
    cancelClearButton.hidden = false;
    clearButton.setAttribute("aria-label", t("confirmClearBoard"));
    return;
  }
  const cleared = { ...blankBoard(), title: board.title || "Untitled" };
  if (await replaceCurrentBoard(cleared, "clear")) {
    setMenuOpen(false);
    menuButton.focus();
  }
}

function markSaveFailure(message) {
  saveFailureMessage = message;
  showToast(message, true);
}

function clearSaveFailure() {
  saveFailureMessage = "";
  if (toast?.dataset.persistent === "true") {
    toast.hidden = true;
    delete toast.dataset.persistent;
  }
}

function showToast(message, persistent = false, duration = 1_800) {
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toast.dataset.persistent = String(persistent);
  announce(message);
  if (!persistent) {
    toastTimer = setTimeout(() => {
      if (saveFailureMessage) {
        toast.textContent = saveFailureMessage;
        toast.dataset.persistent = "true";
      } else {
        toast.hidden = true;
      }
    }, duration);
  }
}

function announce(message) {
  if (!announcer || !message) return;
  cancelAnimationFrame(announcementFrame);
  announcer.textContent = "";
  announcementFrame = requestAnimationFrame(() => {
    announcer.textContent = message;
    announcementFrame = 0;
  });
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
