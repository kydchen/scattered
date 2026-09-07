import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { testEnvironment } from "./test-sharing.mjs";
import { handleShares } from "./worker/src/shares.js";
import { blankBoard } from "./model.js";

// Optional browser regression: PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node --experimental-sqlite test-sharing-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const env = testEnvironment();
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg|png|webmanifest)$/.test(name)) { response.writeHead(404).end(); return; }
  try {
    const content = await readFile(new URL(name, import.meta.url));
    const ext = name.split(".").pop();
    response.writeHead(200, { "Content-Type": { js: "text/javascript", html: "text/html", css: "text/css", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json" }[ext] });
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(4173, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  let online = true;
  const requests = [];
  const errors = [];
  async function context(options = {}) {
    const result = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", ...options });
    await result.route("https://**/*", (route) => route.abort());
    await result.route("https://sync.scatterednote.space/shares/**", async (route) => {
      if (!online) return route.abort();
      const request = route.request();
      requests.push({ method: request.method(), body: request.postData(), url: request.url() });
      const response = await handleShares(new Request(request.url(), { method: request.method(), headers: await request.allHeaders(), ...(request.postData() ? { body: request.postData() } : {}) }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    result.on("page", (page) => page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.stack}`)));
    return result;
  }
  const authorContext = await context();
  const author = await authorContext.newPage();
  await author.goto("http://localhost:4173");
  await author.waitForFunction(() => document.querySelector("#share-dialog"));
  const sample = { ...blankBoard(), title: "Seminar presentation", nodes: [
    { id: "one", text: "First idea", x: 80, y: 80, width: 218, color: "plain" },
    { id: "two", text: '第二个想法 <img src=x onerror="alert(1)">', x: 500, y: 220, width: 300, color: "mint" },
    { id: "three", text: "中文换行\nEnglish line", x: 80, y: 400, width: 240, color: "yellow" },
    { id: "four", text: "Blue", x: 900, y: 150, width: 180, color: "blue" },
    { id: "five", text: "Rose", x: 850, y: 500, width: 218, color: "rose" },
  ], edges: [
    { id: "edge", from: "one", to: "two", arrow: "forward", label: "Connection" },
    { id: "reverse", from: "two", to: "three", arrow: "reverse", label: "反向" },
    { id: "plain", from: "four", to: "five", arrow: false, label: "" },
  ] };
  await author.locator("#import-input").setInputFiles({ name: "test.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)) });
  await author.waitForFunction(() => document.querySelector("#board-title").textContent === "Seminar presentation");
  await author.locator("#boards-button").click();
  assert.equal(await author.locator("#board-primary-tools #restore-button").count(), 1);
  assert.equal(await author.locator(".board-picker-footer").count(), 0);
  assert.equal(await author.locator("#board-picker [title]").count(), 0, "Toolbar controls have no native hover text");
  for (const theme of ["light", "dark"]) {
    await author.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    const title = author.locator(".board-list-row.active .board-list-option");
    await title.hover();
    assert.equal(await title.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "A hovered title must not add a second highlight");
    assert.equal(await title.getAttribute("title"), null, "Do not cover canvas names with redundant tooltips");
    assert.equal(await author.locator("#delete-board-button").evaluate((element) => getComputedStyle(element).color), await author.locator("#duplicate-board-button").evaluate((element) => getComputedStyle(element).color), "Row icons have the same resting color");
    await author.locator("#duplicate-board-button").hover();
    assert.notEqual(await author.locator("#duplicate-board-button").evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "Action buttons retain their hover feedback");
    await author.locator("#board-picker").screenshot({ path: `/tmp/scattered-picker-refined-${theme}.png` });
  }
  const openSharing = async () => {
    if (!await author.locator("#board-picker").isVisible()) await author.locator("#boards-button").click();
    if (await author.locator("#export-button").isVisible()) await author.locator("#export-button").click();
    await author.locator("#export-share-button").click();
    await author.locator("#share-dialog").waitFor({ state: "visible" });
  };
  await openSharing();
  assert.equal(requests.length, 0, "Opening share options must not upload");
  assert.match(await author.locator("#share-consent").textContent(), /view, not edit/);
  assert.match(await author.locator("#share-consent").textContent(), /只读/);
  assert.equal(await author.locator('#share-consent [lang="zh-Hans"]').textContent(), "持链接者可只读查看。");
  assert.equal(await author.locator('#share-consent [lang="en"]').textContent(), "Anyone with the link can view, not edit.");
  assert.equal(await author.locator("#share-dialog [title]").count(), 0);
  assert.equal(await author.locator(".share-details").getAttribute("open"), null);
  assert.equal(await author.locator(".share-notice").first().isVisible(), false);
  for (const id of ["share-enable", "share-copy", "share-stop", "share-close"]) {
    assert.equal((await author.locator(`#${id}`).textContent()).trim(), "", "Actions use icons, not visible labels");
    assert.ok(await author.locator(`#${id}`).getAttribute("aria-label"));
  }
  await author.locator(".share-details summary").click();
  assert.equal(await author.locator(".share-notice").first().isVisible(), true);
  assert.equal(await author.locator(".share-notice").last().isVisible(), true);
  for (const notice of await author.locator(".share-notice").all()) {
    assert.equal(await notice.locator('[lang="zh-Hans"]').isVisible(), true);
    assert.equal(await notice.locator('[lang="en"]').isVisible(), true);
  }
  await author.locator("#share-dialog").screenshot({ path: "/tmp/scattered-share-bilingual-details.png" });
  await author.locator(".share-details summary").click();
  assert.equal(requests.length, 0, "Reading details must not publish a canvas");
  for (const theme of ["light", "dark"]) {
    await author.setViewportSize({ width: 360, height: 680 });
    await author.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    const box = await author.locator("#share-dialog").boundingBox();
    assert.ok(box.height < 320 && box.x >= 0 && box.x + box.width <= 360, "Compact dialog fits a phone");
    assert.equal(await author.locator("#share-enable").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === element;
    }), true, "The disclosure must not cover the action");
    await author.screenshot({ path: `/tmp/scattered-share-compact-${theme}.png` });
  }
  const beforeSharing = await author.locator("#share-dialog").boundingBox();
  await author.locator("#share-dialog").screenshot({ path: "/tmp/scattered-share-stable-before.png" });
  await author.locator("#share-enable").click();
  await author.waitForFunction(() => document.querySelector("#share-url").value.includes("present.html#"));
  const url = await author.locator("#share-url").inputValue();
  await author.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async (value) => { window.testCopiedShare = value; } },
  }));
  await author.locator("#share-copy").click();
  assert.equal(await author.evaluate(() => window.testCopiedShare), url);
  assert.equal(await author.locator("#share-copy").getAttribute("data-copied"), "true");
  assert.equal(await author.locator("#share-url").isVisible(), false, "Long URLs stay collapsed");
  assert.equal(await author.locator("#share-consent").isVisible(), true, "Read-only notice stays visible after sharing and copying");
  assert.deepEqual(await author.locator("#share-dialog").boundingBox(), beforeSharing, "Sharing and copying must not resize or shift the dialog");
  await author.locator("#share-dialog").screenshot({ path: "/tmp/scattered-share-stable-after.png" });
  await author.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await author.locator("#share-preview").getAttribute("href"), url);
  await author.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Clipboard blocked"); }; });
  await author.locator("#share-copy").click();
  assert.equal(await author.locator("#share-url").isVisible(), true, "Clipboard failure exposes a selectable URL");
  assert.equal(await author.locator("#share-url").evaluate((field) => field.selectionEnd - field.selectionStart), url.length);
  await author.locator(".share-details summary").click();
  await author.evaluate(() => { navigator.clipboard.writeText = async () => {}; });
  await author.locator("#share-copy").click();
  await author.screenshot({ path: "/tmp/scattered-share-compact-active.png" });
  const viewerContext = await context();
  // Before sharing existed, this cacheable module emitted fills but no color metadata.
  const legacyRenderer = (await readFile(new URL("./svg-export.js", import.meta.url), "utf8"))
    .replace(' data-color="${xml(node.color || "plain")}"', "");
  await viewerContext.route("**/svg-export.js", (route) => route.fulfill({ contentType: "text/javascript", body: legacyRenderer }));
  const viewer = await viewerContext.newPage();
  await viewer.goto(url);
  await viewer.waitForFunction(() => document.querySelector("#presentation-title").textContent === "Seminar presentation");
  assert.equal(await viewer.locator("[title]").count(), 0, "Viewer controls and heading do not display hover text");
  const localBefore = await viewer.evaluate(() => JSON.stringify(localStorage));
  assert.equal(localBefore, "{}", "Viewer must not initialize a local workspace");
  assert.equal(await viewer.locator("textarea, [contenteditable], #menu-button, #drive-sync-button, img").count(), 0);
  assert.equal(await viewer.locator(".note-text").count(), sample.nodes.length);
  assert.equal(await viewer.locator("#presentation rect[data-color]").count(), sample.nodes.length, "An old unversioned renderer cache must not erase shared note colors");
  const published = JSON.parse(requests.findLast((request) => request.method === "PUT").body);
  assert.deepEqual(published.board.nodes, sample.nodes, "Publishing preserves every note field, including color and position");
  assert.deepEqual(published.board.edges, sample.edges, "Publishing preserves labels and arrow direction");
  assert.deepEqual(await viewer.locator("#presentation rect[data-color]").evaluateAll((elements) => elements.map((element) => ({
    color: element.dataset.color, x: +element.getAttribute("x"), y: +element.getAttribute("y"), width: +element.getAttribute("width"),
  }))), sample.nodes.map(({ color, x, y, width }) => ({ color, x, y, width })));
  assert.deepEqual(await viewer.locator("#presentation .edge").evaluateAll((elements) => elements.map((element) => ({
    start: element.getAttribute("marker-start"), end: element.getAttribute("marker-end"),
  }))), [{ start: null, end: "url(#arrowhead)" }, { start: "url(#arrowhead)", end: null }, { start: null, end: null }]);
  assert.deepEqual(await viewer.locator("#presentation .note-text").nth(2).locator("tspan").allTextContents(), ["中文换行", "English line"]);
  assert.equal(await viewer.locator(".app-mark .app-logo circle").count(), 6);
  assert.equal(await viewer.locator("#presentation-status").getAttribute("class"), "sr-only", "Healthy update status stays out of the presentation");
  for (const id of ["presentation-fit", "presentation-theme", "presentation-fullscreen"]) {
    const button = viewer.locator(`#${id}`);
    assert.equal((await button.textContent()).trim(), "", "Viewer controls must use icons, not visible text");
    assert.match(await button.getAttribute("aria-label"), /[\u4e00-\u9fff].* \/ [A-Z]/);
    const box = await button.boundingBox();
    assert.equal(box.width, 44);
    assert.equal(box.height, 44);
  }
  for (const appearance of ["light", "dark"]) {
    await viewer.emulateMedia({ colorScheme: appearance });
    if (await viewer.evaluate(() => document.documentElement.dataset.theme) !== appearance) await viewer.locator("#presentation-theme").click();
    assert.equal(await viewer.locator("#presentation-theme").getAttribute("aria-pressed"), String(appearance === "dark"));
    assert.equal(await viewer.locator(appearance === "dark" ? ".theme-sun" : ".theme-moon").isVisible(), true);
    await author.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, appearance);
    const expectedColors = await author.locator(".node").evaluateAll((elements) => elements.map((element) => ({
      color: element.dataset.color, fill: getComputedStyle(element).backgroundColor,
    })));
    assert.deepEqual(await viewer.locator("#presentation rect[data-color]").evaluateAll((elements) => elements.map((element) => ({
      color: element.dataset.color, fill: getComputedStyle(element).fill,
    }))), expectedColors, `${appearance}: every shared note keeps the author's fill color`);
    await viewer.screenshot({ path: `/tmp/scattered-viewer-chrome-${appearance}.png` });
  }
  await viewer.locator("#presentation-fullscreen").click();
  await viewer.waitForFunction(() => document.querySelector("#presentation-fullscreen").getAttribute("aria-pressed") === "true");
  await viewer.locator("#presentation-fullscreen").click();
  await viewer.waitForFunction(() => document.querySelector("#presentation-fullscreen").getAttribute("aria-pressed") === "false");
  await viewer.mouse.move(700, 500);
  await viewer.mouse.down();
  await viewer.mouse.move(800, 560, { steps: 5 });
  await viewer.mouse.up();
  await viewer.mouse.wheel(0, -120);
  const framing = await viewer.locator("#presentation svg").getAttribute("viewBox");
  await viewer.locator("#presentation").press("n");
  await viewer.locator("#presentation").press("Delete");
  await author.locator("#share-close").click();
  if (await author.locator("#board-picker").isVisible()) await author.locator("#boards-button").click();
  await author.locator('.node[data-id="one"]').dblclick();
  await author.locator(".node.editing .node-editor").fill("Updated while presenting");
  await author.locator(".node.editing .node-editor").press("Meta+Enter");
  await viewer.waitForFunction(() => document.querySelector("#presentation").textContent.replace(/\s+/g, " ").includes("Updated while presenting"), null, { timeout: 15_000 });
  assert.equal(await viewer.locator("#presentation svg").getAttribute("viewBox"), framing, "Updates should preserve viewer framing");
  await author.locator('.node[data-id="one"]').hover();
  await author.locator('.node[data-id="one"] .color-handle').press("Enter");
  await author.locator('#color-palette [data-color="yellow"]').click();
  await viewer.waitForFunction(() => document.querySelector("#presentation rect[data-color]")?.dataset.color === "yellow", null, { timeout: 15_000 });
  assert.equal(await viewer.locator("#presentation svg").getAttribute("viewBox"), framing, "A live color update preserves framing");
  await author.locator("#menu-button").click();
  await author.locator("#connection-style-button").click();
  await viewer.waitForFunction(() => [...document.querySelectorAll("#presentation .edge")].every((edge) => edge.getAttribute("d").includes(" C ")), null, { timeout: 15_000 });
  assert.equal(await viewer.locator("#presentation svg").getAttribute("viewBox"), framing, "A live curve update preserves framing");
  assert.equal(await viewer.evaluate(() => JSON.stringify(localStorage)), localBefore);
  await viewer.screenshot({ path: "/tmp/scattered-sharing-viewer.png" });
  // A reload uses the same author capability, not a new link.
  await author.reload();
  await author.waitForFunction(() => document.querySelector("#share-dialog"));
  await openSharing();
  assert.equal(await author.locator("#share-url").inputValue(), url);
  await author.screenshot({ path: "/tmp/scattered-sharing-dialog.png" });
  online = false;
  await viewer.waitForFunction(() => /interrupted|中断/.test(document.querySelector("#presentation-status").textContent), null, { timeout: 15_000 });
  assert.equal(await viewer.locator("#presentation-status:not(.sr-only)").isVisible(), true, "Connection failures must remain visible");
  assert.match(await viewer.locator("#presentation-status").textContent(), /中断.*interrupted/);
  assert.equal(await viewer.locator(".note-text").count(), sample.nodes.length);
  online = true;
  const mobileContext = await context({ viewport: { width: 402, height: 680 }, isMobile: true, hasTouch: true, locale: "zh-CN" });
  const mobile = await mobileContext.newPage();
  await mobile.goto(url);
  await mobile.waitForFunction((count) => document.querySelectorAll(".note-text").length === count, sample.nodes.length);
  await mobile.screenshot({ path: "/tmp/scattered-sharing-mobile.png" });
  for (const button of await mobile.locator(".presentation-tools button:visible").all()) {
    assert.ok(await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && rect.width === 44 && rect.height === 44;
    }), "Mobile icon controls stay inside the viewport with full touch targets");
  }
  assert.equal(await mobile.locator("#presentation-status").getAttribute("class"), "sr-only");
  await viewer.waitForFunction(() => document.querySelector("#presentation-status").classList.contains("sr-only"), null, { timeout: 15_000 });
  await author.locator("#share-stop").click();
  await viewer.waitForFunction(() => document.querySelectorAll(".note-text").length === 0, null, { timeout: 15_000 });
  assert.equal(await viewer.locator("#presentation-status:not(.sr-only)").isVisible(), true, "Revocation must explain the empty canvas");
  assert.equal(await viewer.evaluate(() => JSON.stringify(localStorage)), localBefore);
  // Exercise workspace controls in an isolated signed-in fixture, never a real Google account.
  const uiContext = await context({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true, locale: "zh-CN" });
  await uiContext.addInitScript(() => {
    if (location.origin === "http://localhost:4173") localStorage.setItem("scattered-drive-session-v1", "v1.dGVzdA");
  });
  let driveFails = false;
  const cors = { "Access-Control-Allow-Origin": "http://localhost:4173", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS", "Access-Control-Expose-Headers": "Location" };
  await uiContext.route("https://sync.scatterednote.space/token", (route) => route.fulfill({ headers: cors, json: { accessToken: "test-only", expiresIn: 3600 } }));
  await uiContext.route("https://www.googleapis.com/**", async (route) => {
    const href = route.request().url();
    if (href.includes("/about?")) return route.fulfill({ headers: cors, json: { user: { permissionId: "ui-test", displayName: "Alex", emailAddress: "alex@example.test", photoLink: "https://lh3.googleusercontent.com/test-avatar.svg" } } });
    if (driveFails) return route.fulfill({ status: 503, headers: cors, body: "unavailable" });
    if (href.includes("/upload/")) return route.fulfill({ status: 200, headers: { ...cors, Location: "https://www.googleapis.com/test-upload" }, body: "" });
    if (href.endsWith("/test-upload")) return route.fulfill({ headers: cors, json: { id: "ui-cloud-file", version: "1" } });
    return route.fulfill({ headers: cors, json: { files: [] } });
  });
  await uiContext.route("https://lh3.googleusercontent.com/test-avatar.svg", (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#5679a8"/><circle cx="32" cy="24" r="10" fill="#dfeaf5"/><path d="M12 58a20 20 0 0 1 40 0" fill="#dfeaf5"/></svg>' }));
  const ui = await uiContext.newPage();
  await ui.goto("http://localhost:4173");
  try { await ui.waitForFunction(() => document.querySelector('#drive-sync-button[data-status="synced"].has-avatar')); }
  catch (error) {
    console.log(await ui.locator("#drive-sync-button").evaluate((button) => ({ status: button.dataset.status, account: button.dataset.account, photo: button.querySelector("img").getAttribute("src"), width: button.querySelector("img").naturalWidth })), errors);
    throw error;
  }
  const readWorkspace = () => ui.evaluate(async () => {
    const { createWorkspaceSlots, loadWorkspace, createSyncWorkspace } = await import("./workspace.js");
    const storage = createWorkspaceSlots(localStorage).storage;
    return createSyncWorkspace(storage, loadWorkspace(storage).workspace);
  });
  const baseline = await readWorkspace();
  const upload = async (title) => {
    await ui.locator("#import-input").setInputFiles({ name: "canvas.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...sample, title })) });
    await ui.waitForFunction((title) => document.querySelector("#board-title").textContent.startsWith(title), title);
  };
  await upload("小组讨论");
  const first = await readWorkspace();
  assert.equal(first.boards.length, baseline.boards.length + 1);
  assert.deepEqual(first.boards.find((item) => item.id === baseline.activeId).board, baseline.boards.find((item) => item.id === baseline.activeId).board, "Import preserves the previously active canvas");
  await upload("小组讨论");
  await ui.waitForFunction(() => document.querySelector("#board-title").textContent !== "小组讨论");
  const second = await readWorkspace();
  assert.notEqual(second.activeId, first.activeId);
  assert.equal(second.boards.length, first.boards.length + 1);
  assert.notEqual(second.boards[0].board.title, first.boards[0].board.title, "Duplicate import titles receive a suffix");
  await ui.locator("#boards-button").click();
  assert.equal(await ui.locator('.board-list-row.active #duplicate-board-button').count(), 1);
  assert.equal(await ui.locator('.board-list-row:not(.active) .board-row-actions').count(), 0);
  await ui.locator("#delete-board-button").click();
  assert.equal(await ui.locator('.board-list-row.active .board-list-title').isVisible(), true, "Deletion keeps its target visible");
  assert.equal(await ui.locator("#cancel-delete-board-button").isVisible(), true);
  await ui.locator("#delete-board-button").click();
  await ui.waitForFunction(() => !document.querySelector("#board-picker").hasAttribute("aria-busy") || document.querySelector("#board-picker").getAttribute("aria-busy") === "false");
  const beforeRestore = await readWorkspace();
  await ui.locator("#boards-button").click();
  await ui.locator("#restore-button").click();
  await ui.locator("#recovery-dialog").waitFor({ state: "visible" });
  await ui.waitForFunction(() => [...document.querySelectorAll(".recovery-item img")].every((img) => img.complete && img.naturalWidth > 0));
  assert.equal(await ui.locator(".recovery-item").count(), 1);
  assert.equal(await ui.locator("#recovery-dialog [title]").count(), 0);
  assert.match(await ui.locator(".recovery-item time").textContent(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const recoveryId = await ui.evaluate(() => JSON.parse(localStorage.getItem("scattered-recovery-v2"))[0].id);
  for (const theme of ["light", "dark"]) {
    await ui.locator("#recovery-close").click();
    await ui.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await ui.locator("#boards-button").click();
    await ui.locator("#restore-button").click();
    await ui.locator(".recovery-item img").evaluate((image) => image.decode());
    await ui.screenshot({ path: `/tmp/scattered-recovery-${theme}.png` });
  }
  await ui.locator(".recovery-item button").click();
  await ui.locator("#recovery-dialog").waitFor({ state: "hidden" });
  const afterRestore = await readWorkspace();
  assert.equal(afterRestore.boards.length, beforeRestore.boards.length + 1);
  assert.notEqual(afterRestore.activeId, second.activeId, "Restoration creates a new ID, not a resurrected sharing identity");
  for (const item of beforeRestore.boards) assert.deepEqual(afterRestore.boards.find((next) => next.id === item.id).board, item.board);
  assert.equal(await ui.evaluate((id) => JSON.parse(localStorage.getItem("scattered-recovery-v2")).some((entry) => entry.id === id), recoveryId), false);
  await ui.locator("#boards-button").click();
  await ui.locator("#duplicate-board-button").click();
  assert.equal((await readWorkspace()).boards.length, afterRestore.boards.length + 1);
  for (const width of [320, 390, 768, 1280]) {
    await ui.setViewportSize({ width, height: 800 });
    if (!await ui.locator("#board-picker").isVisible()) await ui.locator("#boards-button").click();
    for (const selector of ["#new-board-button", "#import-button", "#export-button", "#drive-sync-button", "#duplicate-board-button", "#delete-board-button", "#restore-button"]) {
      assert.ok(await ui.locator(selector).evaluate((element) => {
        const r = element.getBoundingClientRect();
        return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth;
      }), `${width}: ${selector} has a full touch target`);
    }
    const header = await ui.locator("#board-primary-tools").boundingBox();
    const list = await ui.locator("#board-list").boundingBox();
    if (width === 390) await ui.screenshot({ path: "/tmp/scattered-picker-mobile.png" });
    await ui.locator("#export-button").click();
    assert.equal(await ui.locator("#board-primary-tools").isVisible(), false);
    assert.equal((await ui.locator("#export-choices").boundingBox()).y, header.y);
    assert.equal((await ui.locator("#board-list").boundingBox()).y, list.y, "Export choices replace the first row without moving the list");
    assert.equal(await ui.locator(".export-choice:visible").count(), 5);
    for (const button of await ui.locator(".export-choice:visible").all()) {
      const rect = await button.boundingBox();
      assert.ok(rect.width === 44 && rect.height === 44 && rect.x >= 0 && rect.x + rect.width <= width);
    }
    if (width === 390) await ui.locator("#board-picker").screenshot({ path: "/tmp/scattered-export-single-row.png" });
    await ui.locator("#cancel-export-button").click();
    assert.equal(await ui.locator("#board-primary-tools").isVisible(), true);
  }
  await ui.setViewportSize({ width: 390, height: 760 });
  await ui.locator("#drive-sync-button").click();
  assert.equal(await ui.locator("#drive-account-email").textContent(), "alex@example.test");
  assert.equal(await ui.locator("#board-picker [title]").count(), 0, "Loaded account details do not recreate hover text");
  await ui.waitForFunction(() => document.querySelector('#drive-sync-button[data-status="synced"]'));
  await ui.screenshot({ path: "/tmp/scattered-account-mobile.png" });
  await uiContext.setOffline(true);
  await ui.waitForFunction(() => document.querySelector('#drive-sync-button[data-status="offline"]'));
  assert.equal(await ui.locator(".drive-offline-mark").isVisible(), true);
  await uiContext.setOffline(false);
  driveFails = true;
  await ui.locator("#drive-sync-button").click();
  await ui.waitForFunction(() => document.querySelector('#drive-sync-button[data-status="error"]'));
  assert.equal(await ui.locator(".drive-badge").isVisible(), true);
  assert.equal(await ui.locator(".drive-alert-mark").evaluate((path) => getComputedStyle(path).display), "block", "The vertical warning stroke is painted despite its zero-width SVG bounds");
  await ui.screenshot({ path: "/tmp/scattered-account-error.png" });
  await ui.locator("#disconnect-drive-button").click();
  await ui.waitForFunction(() => document.querySelector('#drive-sync-button[data-status="disconnected"]'));
  assert.equal(await ui.locator(".drive-avatar").getAttribute("src"), null);
  await ui.locator("#boards-button").click();
  await ui.locator("#restore-button").click();
  assert.equal(await ui.locator(".recovery-empty").count(), 1, "Signed-out recovery stays in its own workspace");
  await ui.locator("#recovery-close").click();
  await ui.locator("#boards-button").click();
  await ui.locator("#export-button").click();
  await ui.locator("#export-share-button").click();
  assert.match(await ui.locator("#share-consent").textContent(), /只读/);
  assert.match(await ui.locator("#share-consent").textContent(), /Anyone/);
  await ui.locator("#toast").waitFor({ state: "hidden" });
  await ui.screenshot({ path: "/tmp/scattered-share-mobile-zh.png" });
  await uiContext.close();
  env.SHARE_CREATES.limit = async () => ({ success: false });
  await author.locator("#share-enable").click();
  await author.waitForFunction(() => document.querySelector("#share-status:not(.sr-only)")?.textContent.includes("Too many"));
  assert.match(await author.locator("#share-status").textContent(), /分享请求/);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("browser sharing checks passed: shared viewer chrome, bilingual icons, themes, fullscreen, quiet healthy state, visible failures, compact dialog, opt-in, live edits, stable URL, framing, XSS, no workspace writes, offline recovery, mobile layout, revocation");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  env.db.close();
}
