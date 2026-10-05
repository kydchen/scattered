import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { blankBoard } from "./model.js";

// Isolated contexts, synthetic notes, and no external requests. Run once per engine:
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs BROWSER=webkit node test-reliability-browser.mjs
const engines = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.BROWSER || "chromium";
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg|png|webmanifest)$/.test(name)) return response.writeHead(404).end();
  try {
    const content = name === "sync-config.js"
      ? 'export const DRIVE_SYNC_API = "https://broker.invalid";'
      : await readFile(new URL(name, import.meta.url));
    response.writeHead(200, { "Content-Type": { js: "text/javascript", html: "text/html", css: "text/css", svg: "image/svg+xml", png: "image/png" }[name.split(".").pop()] || "application/json" });
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://localhost:${server.address().port}`;
const browser = await engines[engine].launch({ headless: true, ...(engine === "chromium" ? { channel: "chrome" } : {}) });
const errors = [], failures = [];
const note = (id, x, y, text = id) => ({ id, x, y, text, width: 218, color: "plain" });
async function check(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", locale: "en-US", ...options });
  await context.route("https://**/*", route => route.abort());
  context.on("page", page => page.on("pageerror", error => errors.push(error.stack)));
  try { await run(context); console.log(`PASS ${engine}: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${engine}: ${name}\n${error.stack}`); }
  finally { await context.close(); }
}
async function seed(context, nodes = [note("a", 100, 200)]) {
  const page = await context.newPage();
  await page.goto(`${origin}/about.html`);
  await page.evaluate(board => localStorage.setItem("scattered-board-v1", JSON.stringify(board)), { ...blankBoard(), title: "Test", nodes });
  await page.goto(origin);
  await page.locator('.node[data-id="a"]').waitFor();
  return page;
}
const scroll = page => page.locator("#viewport").evaluate(v => [v.scrollLeft, v.scrollTop]);
const stored = page => page.evaluate(() => {
  const ws = JSON.parse(localStorage.getItem("scattered-workspace-v2"));
  return ws.boards.map(item => JSON.parse(localStorage.getItem(`scattered-document-v2:${item.id}`)));
});
async function edit(page, text, finish = true) {
  await page.locator('.node[data-id="a"]').dblclick();
  await page.locator('.node[data-id="a"] textarea').fill(text);
  if (finish) await page.locator('.node[data-id="a"] textarea').press("Control+Enter");
  await page.waitForTimeout(300);
}
try {
  await check("deletion and keyboard focus cannot desynchronize canvas coordinates", async context => {
    const page = await seed(context, [note("a", 100, 200), note("far", 2600, 1800), note("c", 500, 300)]);
    await page.locator('.node[data-id="a"]').click();
    await page.locator('.node[data-id="a"] .node-delete').click({ force: true });
    await page.waitForTimeout(300);
    assert.deepEqual(await scroll(page), [0, 0]);
    assert.equal(await page.evaluate(() => document.activeElement.closest(".node")?.dataset.id), "c");
    await page.mouse.dblclick(400, 600);
    await page.waitForTimeout(300);
    const center = await page.locator(".node.editing").evaluate(n => { const r = n.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    assert.ok(Math.abs(center[0] - 400) < 3 && Math.abs(center[1] - 600) < 3, JSON.stringify(center));
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelector('.node[data-id="far"]').focus());
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    assert.deepEqual(await scroll(page), [0, 0]);
    const focused = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    assert.equal(focused, true, "Keyboard-focused card controls are visible");
  });

  await check("long editing notes keep the caret visible without scrolling the canvas", async context => {
    const page = await seed(context);
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 500 }]) {
      await page.setViewportSize(size);
      await edit(page, Array.from({ length: 150 }, (_, i) => `Line ${i} 中文`).join("\n"), false);
      const editor = page.locator(".node.editing textarea");
      await editor.press("Meta+ArrowDown");
      await editor.press("End");
      await page.waitForTimeout(350);
      assert.deepEqual(await scroll(page), [0, 0]);
      let rect = await editor.boundingBox();
      assert.ok(rect.y + rect.height < size.height && rect.y + rect.height > 40, `End caret is in view: ${JSON.stringify(rect)}`);
      await editor.press("Meta+ArrowUp");
      assert.equal(await editor.evaluate(e => e.selectionStart), 0, "Home shortcut moves the actual caret");
      await page.waitForTimeout(350);
      rect = await editor.boundingBox();
      assert.ok(rect.y >= 0 && rect.y < size.height - 40, `Start caret is in view: ${JSON.stringify(rect)}`);
      await editor.press("Control+Enter");
      await page.waitForTimeout(200);
    }
  });

  await check("idle tabs refresh content; view changes do not create copies", async context => {
    const a = await seed(context), b = await context.newPage();
    await b.goto(origin); await b.locator(".node").waitFor();
    await edit(a, "Peer edit");
    await b.waitForFunction(() => document.querySelector(".node .node-text").textContent === "Peer edit");
    await b.mouse.move(800, 500); await b.mouse.wheel(0, 120);
    await b.waitForTimeout(400);
    assert.equal((await stored(b)).length, 1);
    // Ignore missed storage events by forcing a fresh check on focus.
    await b.evaluate(() => window.dispatchEvent(new Event("focus")));
    await b.waitForTimeout(200);
    assert.equal((await stored(b)).length, 1);
  });

  await check("active editors defer refresh and true concurrent edits retain both versions", async context => {
    const a = await seed(context), b = await context.newPage();
    await b.goto(origin); await b.locator(".node").waitFor();
    await b.locator('.node[data-id="a"]').dblclick();
    await edit(a, "Peer edit");
    await b.waitForTimeout(600);
    assert.equal(await b.locator(".node.editing textarea").inputValue(), "a", "Do not replace an open editor");
    await b.locator(".node.editing textarea").fill("Local edit");
    await b.locator(".node.editing textarea").press("Control+Enter");
    await b.waitForTimeout(500);
    const docs = await stored(b);
    assert.equal(docs.length, 2);
    assert.deepEqual(docs.map(d => d.nodes[0].text).sort(), ["Local edit", "Peer edit"]);
  });

  await check("a stale view-only save adopts peer content even when refresh events are missed", async context => {
    const a = await seed(context), b = await context.newPage();
    await b.addInitScript(() => {
      for (const name of ["storage", "focus"]) {
        window.addEventListener(name, event => event.stopImmediatePropagation(), true);
      }
    });
    await b.goto(origin); await b.locator(".node").waitFor();
    await b.waitForTimeout(300);
    await edit(a, "Peer edit");
    assert.equal(await b.locator(".node .node-text").textContent(), "a", "The fixture must still be stale");
    await b.mouse.move(800, 500); await b.mouse.wheel(0, 120);
    await b.waitForFunction(() => document.querySelector(".node .node-text").textContent === "Peer edit");
    const docs = await stored(b);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].nodes[0].text, "Peer edit");
  });

  await check("expired authorization preserves account workspace across reload", async context => {
    await context.route("https://broker.invalid/token", route => route.fulfill({ status: 401, body: "{}" }));
    const page = await seed(context);
    await edit(page, "Private local notes");
    await page.evaluate(() => {
      localStorage.setItem("scattered-local-workspace-account-v1", `gdrive-${"a".repeat(64)}`);
      localStorage.setItem("scattered-drive-session-v1", "v1.c2VhbGVk");
    });
    await page.reload();
    await page.waitForFunction(() => localStorage.getItem("scattered-drive-session-v1") === null);
    await page.reload();
    await page.locator(".node").waitFor();
    assert.equal(await page.locator(".node .node-text").textContent(), "Private local notes");
    assert.match(await page.locator("#drive-sync-button").getAttribute("aria-label"), /Reconnect/);
    assert.equal(await page.locator("#drive-sync-button").getAttribute("data-status"), "error");
    assert.notEqual(await page.evaluate(() => localStorage.getItem("scattered-active-workspace-scope-v1")), "guest");
  });

  await check("large single-canvas JSON imports as a new canvas without overwriting", async context => {
    const page = await seed(context);
    const nodes = Array.from({ length: 501 }, (_, i) => note(`n${i}`, i % 30 * 240, Math.floor(i / 30) * 100));
    const board = { ...blankBoard(), title: "Large backup", nodes };
    await page.locator("#import-input").setInputFiles({ name: "large.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(board, null, 2)) });
    await page.waitForFunction(() => document.querySelector("#board-title").textContent === "Large backup");
    assert.equal(await page.locator(".node").count(), 501);
    const docs = await stored(page);
    assert.equal(docs.length, 2);
    assert.equal(docs.find(d => d.title === "Test").nodes[0].text, "a");
  });
  // This automation environment fails offline navigation inside WebKit itself,
  // identically on the unmodified v85 baseline. Do not count it as a passed test.
  if (engine === "webkit") console.log("SKIP webkit: offline reload needs device acceptance; the same internal navigation error occurs on v85");
  else await check("the new offline cache loads all updated modules and keeps local saving available", async context => {
    const page = await seed(context);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.waitForFunction(async () => (await caches.keys()).includes("scattered-v86"));
    await context.setOffline(true);
    await page.reload();
    await page.locator('.node[data-id="a"]').waitFor();
    await edit(page, "Offline edit");
    assert.equal((await stored(page))[0].nodes[0].text, "Offline edit");
  }, { serviceWorkers: "allow" });
  assert.deepEqual(errors, [], "No unhandled browser errors");
  assert.deepEqual(failures, [], "All reliability scenarios must pass");
} finally { await browser.close(); server.close(); }
