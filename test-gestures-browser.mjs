import assert from "node:assert/strict";
import { blankBoard } from "./model.js";

// Called by the existing isolated browser runner. Real touch events go through
// Chromium's input pipeline; all external network requests remain blocked.
export async function checkCanvasGestures(context) {
  const page = await context.newPage();
  const input = await context.newCDPSession(page);
  const fixture = (phone = false) => ({ ...blankBoard(), title: "Gestures", view: { x: 0, y: 0, scale: 1 }, nodes: [
    { id: "a", text: "A", x: phone ? 45 : 100, y: 220, width: phone ? 120 : 180, color: "blue" },
    { id: "b", text: "B", x: phone ? 220 : 480, y: 220, width: phone ? 120 : 180, color: "mint" },
    { id: "c", text: "C", x: phone ? 45 : 100, y: 430, width: phone ? 120 : 180, color: "yellow" },
  ], edges: [] });
  const reset = async (board = fixture()) => {
    await page.goto("http://localhost:4173/about.html");
    await page.evaluate(board => {
      localStorage.clear();
      localStorage.setItem("scattered-board-v1", JSON.stringify(board));
    }, board);
    await page.goto("http://localhost:4173/");
    await page.locator('.node[data-id="a"]').waitFor();
  };
  const touch = async (type, points = []) => {
    await input.send("Input.dispatchTouchEvent", {
      type, touchPoints: points.map(([x, y, id = 0]) => ({ x, y, id })),
    });
    // Native touch moves are coalesced until a frame, unlike synthetic events.
    if (type === "touchMove") await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const selected = () => page.locator(".node.selected").evaluateAll(nodes => nodes.map(node => node.dataset.id).sort());
  const position = id => page.locator(`.node[data-id="${id}"]`).evaluate(node => ({
    x: node.style.getPropertyValue("--node-x"), y: node.style.getPropertyValue("--node-y"),
  }));
  const center = async id => {
    const box = await page.locator(`.node[data-id="${id}"]`).boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  const savedBoard = () => page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem("scattered-workspace-v2"));
    const stored = JSON.parse(localStorage.getItem(`scattered-document-v2:${workspace.activeId}`));
    return stored.board || stored;
  });

  await page.setViewportSize({ width: 390, height: 780 });
  const cue = page.locator("#touch-selection-cue");
  // The ready cue must remain outside the finger without selecting nearby notes.
  for (const theme of ["light", "dark"]) {
    await reset(fixture(true));
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await touch("touchStart", [[190, 190]]);
    await cue.waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    const box = await cue.boundingBox();
    await page.screenshot({ path: `/tmp/scattered-touch-ready-${theme}.png` });
    // The painted bounds include the 2px stroke around the 88px corner geometry.
    assert.ok(Math.abs(box.width - 90) < 1 && Math.abs(box.height - 90) < 1, JSON.stringify(box));
    assert.ok(Math.abs(box.x + box.width / 2 - 190) < 1 && Math.abs(box.y + box.height / 2 - 190) < 1);
    assert.deepEqual(await selected(), [], "The larger ready cue is feedback, not a selection area");
    assert.equal(await page.locator("#lasso-path").isVisible(), false);
    await touch("touchMove", [[330, 300]]);
    assert.equal(await page.locator("#lasso-path").getAttribute("d"), "M 190 190 L 330 190 L 330 300 L 190 300 Z", "Actual selection still starts at the finger's original position");
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#touch-selection-cue")).opacity === "0");
    await touch("touchEnd");
    assert.equal(await cue.isVisible(), false);
    assert.deepEqual(await selected(), ["b"]);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await reset(fixture(true));
  await touch("touchStart", [[190, 190]]);
  await cue.waitFor({ state: "visible" });
  assert.equal(await cue.locator("path").evaluate(element => getComputedStyle(element).animationName), "none");
  await touch("touchCancel");
  assert.equal(await cue.isVisible(), false, "Cancellation removes the ready cue");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await reset(fixture(true));
  // Holding blank space exposes selection + select-all even before a card is selected.
  await touch("touchStart", [[25, 190]]);
  await cue.waitFor({ state: "visible" });
  assert.equal(await page.locator("#select-all").isVisible(), true);
  assert.equal(await page.locator("#delete-selection").isDisabled(), true);
  await touch("touchMove", [[352, 300]]);
  await touch("touchEnd");
  assert.deepEqual(await selected(), ["a", "b"]);
  const before = { a: await position("a"), b: await position("b") };
  const a = await center("a");
  await touch("touchStart", [a]);
  await touch("touchMove", [[a[0], a[1] + 80]]);
  await touch("touchEnd");
  assert.equal(parseFloat((await position("a")).y) - parseFloat(before.a.y), 80);
  assert.equal(parseFloat((await position("b")).y) - parseFloat(before.b.y), 80, "Dragging one selected note moves the whole selection");
  const c = await center("c");
  await touch("touchStart", [c]); await touch("touchEnd");
  assert.deepEqual(await selected(), ["a", "b", "c"], "Tap adds a note without collapsing the group");
  await touch("touchStart", [c]); await touch("touchEnd");
  assert.deepEqual(await selected(), ["a", "b"], "Tap an included note to remove it");
  await page.locator("#select-all").click();
  assert.deepEqual(await selected(), ["a", "b", "c"]);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 780 });
    for (const button of await page.locator("#selection-bar button, #theme-button").all()) {
      assert.equal(await button.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.width >= 44
          && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element;
      }), true, `Selection controls stay tappable at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 390, height: 780 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `/tmp/scattered-touch-selection-${theme}.png` });
  }
  await page.locator("#delete-selection").click();
  assert.equal(await page.locator(".node").count(), 0);
  await page.locator("#undo-button").click();
  assert.equal(await page.locator(".node").count(), 3, "Batch deletion is one undo step");
  await touch("touchStart", [[190, 580]]); await touch("touchEnd");
  assert.equal(await page.locator("#selection-bar").isVisible(), false, "Tap blank space to leave selection");

  await reset(fixture(true));
  await touch("touchStart", [[25, 190]]);
  await cue.waitFor({ state: "visible" });
  await touch("touchEnd");
  assert.equal(await cue.isVisible(), false, "Releasing without dragging removes the ready cue");
  await page.locator("#select-all").click();
  assert.deepEqual(await selected(), ["a", "b", "c"], "Hold and release blank space can select all without drawing a box");

  await reset(fixture(true));
  const world = () => page.locator("#world").evaluate(element => element.style.transform);
  const viewBefore = await world();
  await touch("touchStart", [[180, 500]]);
  await touch("touchMove", [[180, 550]]);
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#selection-bar").isVisible(), false, "Ordinary panning cancels long-press selection");
  assert.equal(await cue.isVisible(), false);
  assert.notEqual(await world(), viewBefore);
  await touch("touchEnd");

  await reset(fixture(true));
  await touch("touchStart", [[180, 500, 0]]);
  await touch("touchStart", [[180, 500, 0], [250, 550, 1]]);
  await touch("touchMove", [[130, 470, 0], [300, 580, 1]]);
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#selection-bar").isVisible(), false, "A second finger cancels the pending hold");
  assert.equal(await cue.isVisible(), false);
  await touch("touchEnd");

  await reset(fixture(true));
  await touch("touchStart", [[190, 190, 0]]);
  await cue.waitFor({ state: "visible" });
  await touch("touchStart", [[190, 190, 0], [300, 550, 1]]);
  assert.equal(await cue.isVisible(), false, "Pinching also removes an already visible cue");
  await touch("touchEnd");

  await reset(fixture(true));
  await touch("touchStart", [[25, 190]]);
  await cue.waitFor({ state: "visible" });
  const anchored = await world();
  await touch("touchMove", [[380, 600]]);
  await page.waitForFunction(before => document.querySelector("#world").style.transform !== before, anchored);
  assert.equal(await page.locator("#lasso-path").isVisible(), true, "Selection extends while edge panning");
  await touch("touchCancel");
  assert.equal(await page.locator("#lasso-path").isVisible(), false);

  await page.setViewportSize({ width: 1280, height: 800 });
  for (const pointerType of ["mouse", "touch", "pen"]) {
    await reset();
    const start = await center("a"), end = await center("b");
    const origin = await position("a");
    const dispatch = async (type, point) => {
      if (pointerType === "mouse") {
        if (type === "down") { await page.mouse.move(...point); await page.mouse.down(); }
        else if (type === "move") await page.mouse.move(...point);
        else if (type === "up") await page.mouse.up();
        else { await page.dispatchEvent("#viewport", "pointercancel", { pointerId: 1, pointerType: "mouse", bubbles: true }); await page.mouse.up(); }
      } else if (pointerType === "touch") await touch({ down: "touchStart", move: "touchMove", up: "touchEnd", cancel: "touchCancel" }[type], ["up", "cancel"].includes(type) ? [] : [point]);
      else await page.evaluate(({ type, point }) => {
        const target = type === "down" ? document.elementFromPoint(...point) : document.querySelector("#viewport");
        target.dispatchEvent(new PointerEvent(`pointer${type}`, { pointerId: 77, pointerType: "pen", isPrimary: true,
          bubbles: true, clientX: point[0], clientY: point[1], buttons: type === "up" ? 0 : 1 }));
      }, { type, point });
    };
    await dispatch("down", start); await dispatch("move", end);
    assert.equal(await page.locator('.node[data-id="a"]').evaluate(element => getComputedStyle(element).opacity), "0.45");
    assert.equal(await page.locator('.node[data-id="b"]').evaluate(element => element.classList.contains("link-target")), true);
    if (pointerType === "mouse") await page.screenshot({ path: "/tmp/scattered-drop-link-preview.png" });
    await dispatch("up", end);
    assert.deepEqual(await position("a"), origin, `${pointerType}: drop connects and returns the dragged card`);
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 1);
    await page.waitForTimeout(240);
    const connected = await savedBoard();
    assert.equal(connected.edges[0].from, "a");
    assert.equal(connected.edges[0].to, "b");
    assert.equal(connected.edges[0].arrow, false);
    await dispatch("down", start); await dispatch("move", end); await dispatch("up", end);
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 0);
    assert.deepEqual(await position("a"), origin, "Dropping an already connected note disconnects and returns it");
    await page.locator("#undo-button").click();
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 1);
    await dispatch("down", start); await dispatch("move", end);
    const empty = [start[0] + 250, start[1] + 160];
    await dispatch("move", empty);
    assert.equal(await page.locator(".drop-source, .link-target").count(), 0, `${pointerType}: passing over a target is still a normal move if released elsewhere`);
    await dispatch("up", empty);
    assert.notDeepEqual(await position("a"), origin);
    await page.locator("#undo-button").click();
    assert.deepEqual(await position("a"), origin);
    await dispatch("down", start); await dispatch("move", end); await dispatch("cancel", end);
    assert.deepEqual(await position("a"), origin, "Interrupted drags cannot leave overlapping notes behind");
    assert.equal(await page.locator(".drop-source, .link-target").count(), 0);

    const groupBoard = fixture();
    groupBoard.nodes[2].x = 480;
    await reset(groupBoard);
    const selectGroup = async () => {
      await page.mouse.move(75, 190); await page.mouse.down(); await page.mouse.move(700, 300); await page.mouse.up();
      assert.deepEqual(await selected(), ["a", "b"]);
    };
    await selectGroup();
    const groupOrigin = { a: await position("a"), b: await position("b") };
    // The held card A stays clear: only the other selected card B overlaps C.
    const drop = [start[0], start[1] + 210];
    await dispatch("down", start); await dispatch("move", drop);
    assert.equal(await page.locator(".drop-source").count(), 2, `${pointerType}: any member overlapping makes the whole group translucent`);
    assert.equal(await page.locator('.node[data-id="c"].link-target').count(), 1);
    await dispatch("up", drop);
    assert.deepEqual({ a: await position("a"), b: await position("b") }, groupOrigin);
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 2);
    await page.waitForTimeout(240);
    assert.deepEqual((await savedBoard()).edges.map(({ from, to }) => [from, to]).sort(), [["a", "c"], ["b", "c"]]);
    await dispatch("down", start); await dispatch("move", drop); await dispatch("up", drop);
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 0);
    assert.deepEqual({ a: await position("a"), b: await position("b") }, groupOrigin, "Dropping a fully connected group disconnects it and returns all notes");
    await page.locator("#undo-button").click();
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 2);

    const existing = { id: "existing", from: "c", to: "a", arrow: "forward", label: "Keep this" };
    groupBoard.edges = [existing];
    await reset(groupBoard); await selectGroup();
    await dispatch("down", start); await dispatch("move", drop); await dispatch("up", drop);
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 2);
    await page.waitForTimeout(240);
    const partial = (await savedBoard()).edges;
    assert.deepEqual(partial.find(edge => edge.id === "existing"), existing, "A group drop preserves existing direction, arrow and label");
    assert.equal(partial.find(edge => edge.id !== "existing").from, "b");
    await dispatch("down", start); await dispatch("move", drop); await dispatch("up", drop);
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 0);
    await page.locator("#undo-button").click();
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 2);
    await page.waitForTimeout(240);
    assert.deepEqual((await savedBoard()).edges, partial, "Undo disconnection restores original IDs, directions and labels");
    await page.locator("#undo-button").click();
    await page.waitForFunction(() => document.querySelectorAll(".edge").length === 1);
    assert.equal(await page.locator(".edge").count(), 1, "The entire group connection is one undo step");
    await selectGroup();
    await dispatch("down", start); await dispatch("move", drop); await dispatch("cancel", drop);
    assert.deepEqual({ a: await position("a"), b: await position("b") }, groupOrigin);
    assert.equal(await page.locator(".drop-source, .link-target").count(), 0);
    assert.equal(await page.locator(".edge").count(), 1, "An interrupted group drop creates no connections");
  }

  // Existing desktop marquee and keyboard select-all still use the same selection.
  await reset();
  await page.mouse.move(75, 190); await page.mouse.down(); await page.mouse.move(700, 300); await page.mouse.up();
  assert.equal(await cue.isVisible(), false, "Mouse selection does not show the touch cue");
  assert.deepEqual(await selected(), ["a", "b"]);
  await page.keyboard.press("Control+a");
  assert.deepEqual(await selected(), ["a", "b", "c"]);
  await page.keyboard.press("Escape");
  assert.deepEqual(await selected(), []);
  await reset();
  await page.evaluate(() => {
    const target = document.querySelector("#gesture-surface");
    const send = (type, x, y) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 77, pointerType: "pen", isPrimary: true, bubbles: true, clientX: x, clientY: y,
      buttons: type === "pointerup" ? 0 : 1,
    }));
    send("pointerdown", 75, 190);
    for (const [x, y] of [[700, 190], [700, 300], [75, 300], [75, 190]]) send("pointermove", x, y);
    send("pointerup", 75, 190);
  });
  assert.deepEqual(await selected(), ["a", "b"], "Pen lasso still selects directly without a hold");
  assert.equal(await cue.isVisible(), false, "Pen selection does not show the touch cue");
  await context.close();
  console.log("gesture checks passed: native touch marquee, selection edits, group move, select-all, bulk delete/undo, pan/pinch, edge pan, mouse/touch/pen drop-link and cancellation");
}
