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
    result.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    return result;
  }
  const authorContext = await context();
  const author = await authorContext.newPage();
  await author.goto("http://localhost:4173");
  await author.waitForFunction(() => document.querySelector("#share-dialog"));
  const sample = { ...blankBoard(), title: "Seminar presentation", nodes: [
    { id: "one", text: "First idea", x: 80, y: 80, width: 218, color: "plain" },
    { id: "two", text: '第二个想法 <img src=x onerror="alert(1)">', x: 500, y: 220, width: 300, color: "mint" },
  ], edges: [{ id: "edge", from: "one", to: "two", arrow: "forward", label: "Connection" }] };
  await author.locator("#import-input").setInputFiles({ name: "test.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)) });
  await author.waitForFunction(() => document.querySelector("#board-title").textContent === "Seminar presentation");
  const openSharing = async () => {
    if (!await author.locator("#menu").isVisible()) await author.locator("#menu-button").click();
    if (await author.locator("#export-button").isVisible()) await author.locator("#export-button").click();
    await author.locator("#export-share-button").click();
    await author.locator("#share-dialog").waitFor({ state: "visible" });
  };
  await openSharing();
  assert.equal(requests.length, 0, "Opening share options must not upload");
  await author.locator("#share-enable").click();
  await author.waitForFunction(() => document.querySelector("#share-url").value.includes("present.html#"));
  const url = await author.locator("#share-url").inputValue();
  const viewerContext = await context();
  const viewer = await viewerContext.newPage();
  await viewer.goto(url);
  await viewer.waitForFunction(() => document.querySelector("#presentation-title").textContent === "Seminar presentation");
  const localBefore = await viewer.evaluate(() => JSON.stringify(localStorage));
  assert.equal(localBefore, "{}", "Viewer must not initialize a local workspace");
  assert.equal(await viewer.locator("textarea, [contenteditable], #menu-button, #drive-sync-button, img").count(), 0);
  assert.equal(await viewer.locator(".note-text").count(), 2);
  await viewer.mouse.move(700, 500);
  await viewer.mouse.down();
  await viewer.mouse.move(800, 560, { steps: 5 });
  await viewer.mouse.up();
  await viewer.mouse.wheel(0, -120);
  const framing = await viewer.locator("#presentation svg").getAttribute("viewBox");
  await viewer.locator("#presentation").press("n");
  await viewer.locator("#presentation").press("Delete");
  await author.locator("#share-close").click();
  await author.locator("#menu-button").click();
  await author.locator('.node[data-id="one"]').dblclick();
  await author.locator(".node.editing .node-editor").fill("Updated while presenting");
  await author.locator(".node.editing .node-editor").press("Meta+Enter");
  await viewer.waitForFunction(() => document.querySelector("#presentation").textContent.replace(/\s+/g, " ").includes("Updated while presenting"), null, { timeout: 15_000 });
  assert.equal(await viewer.locator("#presentation svg").getAttribute("viewBox"), framing, "Updates should preserve viewer framing");
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
  assert.equal(await viewer.locator(".note-text").count(), 2);
  online = true;
  const mobileContext = await context({ viewport: { width: 402, height: 680 }, isMobile: true, hasTouch: true, locale: "zh-CN" });
  const mobile = await mobileContext.newPage();
  await mobile.goto(url);
  await mobile.waitForFunction(() => document.querySelectorAll(".note-text").length === 2);
  await mobile.screenshot({ path: "/tmp/scattered-sharing-mobile.png" });
  assert.ok(await mobile.locator(".presentation-tools").evaluate((element) => element.getBoundingClientRect().right <= innerWidth));
  await author.locator("#share-stop").click();
  await viewer.waitForFunction(() => document.querySelectorAll(".note-text").length === 0, null, { timeout: 15_000 });
  assert.equal(await viewer.evaluate(() => JSON.stringify(localStorage)), localBefore);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("browser sharing checks passed: opt-in, live edits, stable URL, framing, XSS, no workspace writes, offline display, mobile layout, revocation");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  env.db.close();
}
