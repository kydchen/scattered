import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { blankBoard } from "./model.js";

// Isolated contexts, synthetic notes, and no external requests. Run once per engine:
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs BROWSER=webkit node test-reliability-browser.mjs
const engines = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.BROWSER || "chromium";
const cacheName = (await readFile(new URL("./sw.js", import.meta.url), "utf8")).match(/^const CACHE = "([^"]+)";/)?.[1];
assert.ok(cacheName, "The offline test must use the current service worker cache");
let stallNetwork = false;
const stalledRequests = new Set();
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg|png|webmanifest)$/.test(name)) return response.writeHead(404).end();
  if (stallNetwork && name !== "sw.js") {
    await new Promise(resolve => {
      const release = () => { stalledRequests.delete(release); resolve(); };
      stalledRequests.add(release);
      response.once("close", release);
    });
    if (response.destroyed) return;
  }
  try {
    let content = name === "sync-config.js"
      ? 'export const DRIVE_SYNC_API = "https://broker.invalid";'
      : await readFile(new URL(name, import.meta.url));
    // WebKit's service-worker-controlled requests can bypass Playwright routes.
    // Keep telemetry out of this synthetic fixture instead of masking its errors.
    if (name === "index.html") content = content.toString().replace(/<!-- Cloudflare Web Analytics -->[\s\S]*?<!-- End Cloudflare Web Analytics -->/, "");
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
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", locale: "en-US", ...options });
  await context.route("https://**/*", route => route.abort());
  context.on("page", page => page.on("pageerror", error => errors.push({ scenario: name, message: String(error), stack: error.stack })));
  try { await run(context); console.log(`PASS ${engine}: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${engine}: ${name}\n${error.stack}`); }
  finally { await context.close(); }
}
async function seed(context, nodes = [note("a", 100, 200)], edges = []) {
  const page = await context.newPage();
  await page.goto(`${origin}/about.html`);
  await page.evaluate(board => localStorage.setItem("scattered-board-v1", JSON.stringify(board)), { ...blankBoard(), title: "Test", nodes, edges });
  await page.goto(origin);
  await page.locator('.node[data-id="a"]').waitFor();
  return page;
}
const scroll = page => page.locator("#viewport").evaluate(v => [v.scrollLeft, v.scrollTop]);
async function settleReveal(page) {
  // A long caret journey now takes time proportional to distance rather than
  // racing through the entire note in a fixed 300ms.
  await page.waitForTimeout(50);
  await page.waitForFunction(() => !document.querySelector("#viewport").matches(".following-caret, .revealing-note"), null, { timeout: 25000 });
}
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
async function setRecoveryQuota(page) {
  await page.evaluate(async () => {
    const w = await import("./workspace.js?v=87");
    const { board } = w.loadWorkspace(localStorage);
    for (let i = 1; i <= 3; i++) w.captureRecovery(localStorage, `old-${i}`, {
      ...board, nodes: [{ ...board.nodes[0], text: String(i).repeat(4000) }],
    }, "delete", () => i);
    window.quotaUsage = () => Object.keys(localStorage).reduce((n, key) => n + key.length + localStorage.getItem(key).length, 0);
    window.quotaLimit = window.quotaUsage() + 20;
    const nativeSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage) {
        const old = this.getItem(key);
        const size = window.quotaUsage() - (old === null ? 0 : key.length + old.length) + key.length + String(value).length;
        if (size > window.quotaLimit) throw new DOMException("Full", "QuotaExceededError");
      }
      return nativeSet.call(this, key, value);
    };
  });
}
async function exportJson(page) {
  await page.locator("#boards-button").click();
  await page.locator("#export-button").click();
  await page.locator("#export-json-button").click();
}
try {
  for (const cardCount of [1, 2000]) {
    await check(`autosave: continuous typing reaches storage while the same editor remains open (${cardCount} cards)`, async context => {
      const nodes = [note("a", 100, 200), ...Array.from({ length: cardCount - 1 }, (_, i) => note(`extra-${i}`, 500 + (i % 40) * 280, 200 + Math.floor(i / 40) * 140, `Card ${i}: ordinary canvas content.`))];
      const page = await seed(context, nodes);
      await page.locator('.node[data-id="a"]').dblclick();
      await settleReveal(page);
      await page.evaluate(() => {
        window.typingStep = 0;
        const editor = document.querySelector(".node.editing textarea");
        window.typingEditor = editor;
        window.typingTimer = setInterval(() => {
          editor.value = `Continuous input ${++window.typingStep}`;
          editor.setSelectionRange(editor.value.length, editor.value.length);
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          if (window.typingStep === 30) clearInterval(window.typingTimer);
        }, 120);
      });
      await page.waitForTimeout(1600);
      assert.match((await stored(page))[0].nodes[0].text, /^Continuous input /, "No blur or pause is needed to persist typing");
      assert.ok(await page.evaluate(() => document.activeElement === window.typingEditor && window.typingEditor.closest(".node").classList.contains("editing")));
      await page.waitForFunction(() => window.typingStep === 30);
      await page.waitForTimeout(300);
      assert.equal((await stored(page))[0].nodes[0].text, "Continuous input 30");
      assert.equal((await stored(page))[0].nodes.length, cardCount);
      assert.deepEqual(await page.evaluate(() => [window.typingEditor.selectionStart, window.typingEditor.selectionEnd]), [19, 19]);
      await page.locator(".node.editing textarea").press("Control+Enter");
      await page.locator("#undo-button").click();
      await page.waitForTimeout(300);
      assert.equal((await stored(page))[0].nodes[0].text, "a", "Periodic saves must not split one editing session into extra undo steps");
      await page.locator("#redo-button").click();
      await page.waitForTimeout(300);
      await page.reload();
      await page.locator('.node[data-id="a"]').waitFor();
      assert.equal(await page.locator('.node[data-id="a"] .node-text').textContent(), "Continuous input 30");
    });
  }

  await check("autosave: native lock contention coalesces lifecycle flushes and saves the latest input", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    await page.waitForTimeout(300);
    await page.evaluate(async () => {
      const request = navigator.locks.request.bind(navigator.locks);
      await new Promise(ready => {
        void request("scattered-workspace-v2", async () => {
          ready();
          await new Promise(resolve => { window.releaseSaveLock = resolve; });
        });
      });
      window.saveLockRequests = 0;
      window.saveLockStacks = [];
      navigator.locks.request = (...args) => {
        const stack = new Error().stack;
        // Cross-tab refresh also uses this lock. Count only the save callers;
        // a read-only refresh request is not an extra writer.
        if (args[0] === "scattered-workspace-v2" && stack.includes("saveBoardNow")) {
          window.saveLockRequests++;
          window.saveLockStacks.push(stack);
        }
        return request(...args);
      };
    });
    for (let i = 0; i < 5; i++) {
      await page.locator(".node.editing textarea").fill(`Waiting ${i}`);
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.waitForTimeout(240);
    }
    assert.equal(await page.evaluate(() => window.saveLockRequests), 1, JSON.stringify(await page.evaluate(() => window.saveLockStacks)));
    assert.equal((await stored(page))[0].nodes[0].text, "a");
    await page.evaluate(() => window.releaseSaveLock());
    await page.waitForFunction(() => {
      const w = JSON.parse(localStorage.getItem("scattered-workspace-v2"));
      return JSON.parse(localStorage.getItem(`scattered-document-v2:${w.activeId}`)).nodes[0].text === "Waiting 4";
    });
    assert.equal((await stored(page)).length, 1);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith("scattered-pending-document"))), false);
    // Switching canvases awaits the same flush; no old deadline may write into the new canvas.
    await page.locator(".node.editing textarea").fill("Before switching");
    await page.locator("#boards-button").click();
    await page.locator("#new-board-button").click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("scattered-workspace-v2")).boards.length === 2);
    await page.waitForTimeout(1200);
    const boards = await stored(page);
    assert.equal(boards.find(b => b.title === "Test").nodes[0].text, "Before switching");
    assert.equal(boards.find(b => b.title !== "Test").nodes.length, 0);
  });

  // Synthetic composition events verify our handlers, not an OS candidate UI.
  // Real Chinese IME acceptance on iPhone/iPad/macOS is still required.
  for (const kind of ["card", "title", "edge", "search"]) {
    await check(`IME: ${kind} ignores composing shortcuts but keeps ordinary commands`, async context => {
      const page = await seed(context, [note("a", 100, 200, "match one"), note("b", 500, 350, "match two")], [{ id: "ab", from: "a", to: "b", label: "Old label" }]);
      let input;
      if (kind === "card") {
        await page.mouse.dblclick(900, 600);
        input = page.locator(".node.editing textarea");
      } else if (kind === "title") {
        await page.locator("#board-title").dblclick();
        input = page.locator("#board-title-editor");
      } else if (kind === "edge") {
        await page.locator('.edge[data-id="ab"]').press("Enter");
        input = page.locator("#edge-label-editor");
      } else {
        await page.keyboard.press("Control+f");
        input = page.locator("#search-input");
        await input.fill("match");
      }
      await input.waitFor({ state: "visible" });
      await input.focus();
      const count = await page.locator(".node").count();
      const beforeSearch = await page.locator("#search-count").textContent();
      const blocked = await input.evaluate(element => {
        const results = [];
        const send = flags => {
          for (const key of ["Enter", "Escape", "f"]) {
            const event = new KeyboardEvent("keydown", { key, ctrlKey: key !== "Escape", bubbles: true, cancelable: true, ...flags });
            element.dispatchEvent(event);
            results.push(event.defaultPrevented);
          }
          const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...flags });
          element.dispatchEvent(enter);
          results.push(enter.defaultPrevented);
        };
        send({ isComposing: true });
        send({ keyCode: 229 });
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        send({});
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        // Some engines finish composition before the confirming keydown.
        send({ keyCode: 229 });
        return results;
      });
      assert.ok(blocked.every(value => value === false), "IME keys must retain their native default action");
      assert.equal(await input.isVisible(), true);
      assert.equal(await page.locator(".node").count(), count);
      assert.equal(await input.evaluate(element => document.activeElement === element), true);
      assert.equal(await page.locator("#search-count").textContent(), beforeSearch);
      if (kind !== "search") assert.equal(await page.locator("#search-panel").isVisible(), false);
      if (kind === "card") {
        await input.press("Escape");
        assert.equal(await page.locator(".node").count(), count - 1, "An explicit non-IME Escape still cancels an empty draft");
        await page.mouse.dblclick(900, 600);
        await page.locator(".node.editing textarea").fill("中文正文");
        await page.locator(".node.editing textarea").press("Control+Enter");
      } else if (kind === "search") {
        await input.press("Enter");
        assert.notEqual(await page.locator("#search-count").textContent(), beforeSearch);
        await input.press("Escape");
      } else {
        await input.fill(kind === "title" ? "中文标题" : "中文连线");
        await input.press("Enter");
      }
      assert.equal(await page.locator(kind === "card" ? ".node.editing textarea" : kind === "title" ? "#board-title-editor" : kind === "edge" ? "#edge-label-editor" : "#search-input").isVisible(), false);
      await page.waitForTimeout(300);
      const saved = (await stored(page))[0];
      if (kind === "title") assert.equal(saved.title, "中文标题");
      if (kind === "edge") assert.equal(saved.edges[0].label, "中文连线");
      if (kind === "card") assert.ok(saved.nodes.some(n => n.text === "中文正文"));
    });
  }

  await check("storage quota: lifecycle retry waits for the native lock and saves without losing history unnecessarily", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    await page.evaluate(async () => {
      const w = await import("./workspace.js?v=87");
      const { board } = w.loadWorkspace(localStorage);
      for (let i = 1; i <= 3; i++) w.captureRecovery(localStorage, `old-${i}`, {
        ...board, nodes: [{ ...board.nodes[0], text: String(i).repeat(4000) }],
      }, "delete", () => i);
      const usage = () => Object.keys(localStorage).reduce((n, k) => n + k.length + localStorage.getItem(k).length, 0);
      window.quotaLimit = usage() + 20;
      const nativeSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage) {
          const old = this.getItem(key);
          const nextUsage = usage() - (old === null ? 0 : key.length + old.length) + key.length + String(value).length;
          if (nextUsage > window.quotaLimit) throw new DOMException("Full", "QuotaExceededError");
        }
        return nativeSet.call(this, key, value);
      };
      await new Promise(resolve => {
        void navigator.locks.request("scattered-workspace-v2", async () => {
          resolve();
          await new Promise(release => { window.releaseTestLock = release; });
        });
      });
    });
    await page.locator(".node.editing textarea").fill("Lifecycle latest edit");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.locator('#toast[data-persistent="true"]').waitFor();
    assert.match(await page.locator("#toast").textContent(), /Storage is full/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("scattered-recovery-v2")).length), 3, "No unlocked eviction while a different writer holds the lock");
    assert.equal((await stored(page))[0].nodes[0].text, "a");
    await page.evaluate(() => window.releaseTestLock());
    await page.waitForFunction(() => {
      const ws = JSON.parse(localStorage.getItem("scattered-workspace-v2"));
      return JSON.parse(localStorage.getItem(`scattered-document-v2:${ws.activeId}`)).nodes[0].text === "Lifecycle latest edit";
    });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("scattered-recovery-v2")).map(e => e.boardId)), ["old-3", "old-2"]);
    assert.match(await page.locator("#toast").textContent(), /Some older recovery copies/);
    assert.equal(await page.locator("#toast").getAttribute("data-dismissible"), "true");
    await page.reload();
    await page.locator('.node[data-id="a"]').waitFor();
    assert.equal((await stored(page))[0].nodes[0].text, "Lifecycle latest edit");
    assert.match(await page.locator("#toast").textContent(), /Some older recovery copies/, "Reload does not silently acknowledge the notice");
    await edit(page, "A later successful save");
    assert.match(await page.locator("#toast").textContent(), /Some older recovery copies/);
    await page.locator("#toast").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#toast").isVisible(), false);
    await edit(page, "A save after acknowledgement");
    assert.equal(await page.locator("#toast").isVisible(), false);
    await page.reload();
    await page.locator('.node[data-id="a"]').waitFor();
    assert.equal(await page.locator("#toast").isVisible(), false);
  });

  await check("storage quota: unrecoverable write keeps the note visible and exportable with a persistent warning", async context => {
    const page = await seed(context);
    await page.evaluate(() => {
      const nativeSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key.startsWith("scattered-")) throw new DOMException("Full", "QuotaExceededError");
        return nativeSet.call(this, key, value);
      };
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
    });
    await edit(page, "Unsaved but exportable");
    await page.locator('#toast[data-persistent="true"]').waitFor();
    assert.match(await page.locator("#toast").textContent(), /Storage is full/);
    assert.equal((await stored(page))[0].nodes[0].text, "a");
    assert.match(await page.locator('.node[data-id="a"]').textContent(), /Unsaved but exportable/);
    await page.waitForTimeout(2000);
    assert.equal(await page.locator("#toast").isVisible(), true);
    await page.locator("#boards-button").click();
    await page.locator("#export-button").click();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-json-button").click();
    const download = await downloadPromise;
    const exported = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.equal(exported.nodes[0].text, "Unsaved but exportable", "Export must include the in-memory edit, not only the last saved file");
    assert.equal(await page.locator("#toast").getAttribute("data-persistent"), "true");
  });

  await check("storage quota: persistence rejection never blocks startup, editing or subsequent saves", async context => {
    await context.addInitScript(() => {
      window.persistenceCalls = 0;
      if (!navigator.storage) return; // The initial about:blank is not a secure origin.
      Object.defineProperty(navigator.storage, "persisted", { configurable: true, value: async () => false });
      Object.defineProperty(navigator.storage, "persist", { configurable: true, value: async () => { window.persistenceCalls++; throw new Error("Denied"); } });
    });
    const page = await seed(context);
    assert.equal(await page.evaluate(() => window.persistenceCalls), 1);
    await edit(page, "Saved even without persistence");
    await edit(page, "Second saved edit");
    assert.equal((await stored(page))[0].nodes[0].text, "Second saved edit");
    assert.equal(await page.evaluate(() => window.persistenceCalls), 1);
    assert.equal(await page.locator("#toast").isVisible(), false);
  });

  await check("storage quota: a failed extra journal does not block a document replacement that still fits", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    await page.evaluate(() => {
      const nativeSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key.startsWith("scattered-pending-document")) throw new DOMException("Full", "QuotaExceededError");
        return nativeSet.call(this, key, value);
      };
    });
    await page.evaluate(async () => {
      const w = await import("./workspace.js?v=87");
      const { board } = w.loadWorkspace(localStorage);
      for (let i = 1; i <= 3; i++) w.captureRecovery(localStorage, `old-${i}`, board, "delete", () => i);
    });
    await page.locator(".node.editing textarea").fill("Committed even when the journal cannot fit");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.waitForFunction(() => {
      const ws = JSON.parse(localStorage.getItem("scattered-workspace-v2"));
      return JSON.parse(localStorage.getItem(`scattered-document-v2:${ws.activeId}`)).nodes[0].text === "Committed even when the journal cannot fit";
    });
    assert.equal(await page.locator("#toast").isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("scattered-recovery-v2")).length), 3, "A disposable failed journal must not evict any history");
    await page.reload();
    await page.locator('.node[data-id="a"]').waitFor();
    assert.equal((await stored(page))[0].nodes[0].text, "Committed even when the journal cannot fit");
  });

  await check("storage quota: notices dismiss on click or JSON export, not cancellation, failure or an older export", async context => {
    const page = await seed(context);
    await setRecoveryQuota(page);
    await edit(page, "First saved edit ".repeat(20));
    const toast = page.locator("#toast");
    assert.equal(await toast.getAttribute("data-dismissible"), "true");
    await toast.click();
    assert.equal(await toast.isVisible(), false);
    await page.evaluate(() => { window.quotaLimit = window.quotaUsage(); });
    await edit(page, "Next saved edit ".repeat(80));
    assert.equal(await toast.isVisible(), true, "Only a new actual eviction reopens the notice");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: async () => { throw new DOMException("Cancelled", "AbortError"); } });
    });
    await exportJson(page);
    assert.equal(await toast.getAttribute("data-dismissible"), "true");
    // A failed file handoff must not acknowledge the earlier eviction either.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
      window.originalCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = () => { throw new Error("Synthetic export failure"); };
    });
    await exportJson(page);
    await page.waitForTimeout(2000);
    assert.equal(await toast.getAttribute("data-dismissible"), "true");
    await page.evaluate(() => {
      URL.createObjectURL = window.originalCreateObjectURL;
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: () => new Promise(resolve => { window.finishSyntheticShare = resolve; }) });
    });
    await exportJson(page);
    await page.waitForFunction(() => Boolean(window.finishSyntheticShare));
    await page.evaluate(() => { window.quotaLimit = window.quotaUsage(); });
    await edit(page, "Newest saved edit ".repeat(150));
    await page.evaluate(() => window.finishSyntheticShare());
    await page.waitForTimeout(50);
    assert.equal(await toast.getAttribute("data-dismissible"), "true", "Completing an older export must not clear a newer eviction");
    await page.evaluate(() => Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false }));
    const downloaded = page.waitForEvent("download");
    await exportJson(page);
    assert.equal((await downloaded).suggestedFilename().endsWith(".json"), true);
    assert.equal(await toast.isVisible(), false);
  });

  await check("storage quota: eviction acknowledgement never dismisses a failed save", async context => {
    const page = await seed(context);
    await setRecoveryQuota(page);
    await edit(page, "First saved edit ".repeat(20));
    // Exceed this fixture's storage quota, not the existing 20,000-character note limit.
    await edit(page, "Unsaved ".repeat(2000));
    const toast = page.locator("#toast");
    assert.match(await toast.textContent(), /Changes may not be saved/);
    assert.equal(await toast.getAttribute("data-dismissible"), "false");
    await toast.dispatchEvent("click");
    assert.equal(await toast.isVisible(), true);
    await page.evaluate(() => Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false }));
    const downloaded = page.waitForEvent("download");
    await exportJson(page);
    const exported = JSON.parse(await readFile(await (await downloaded).path(), "utf8"));
    assert.equal(exported.nodes[0].text, "Unsaved ".repeat(2000));
    assert.match(await toast.textContent(), /Changes may not be saved/);
    await page.evaluate(() => { window.quotaLimit = Infinity; });
    await page.locator('.node[data-id="a"]').press("Enter");
    await page.locator('.node[data-id="a"] textarea').fill("Storage available again");
    await page.locator('.node[data-id="a"] textarea').press("Control+Enter");
    await page.waitForFunction(() => document.querySelector("#toast").hidden);
    assert.equal(await toast.isVisible(), false, "The export acknowledged eviction only; a successful save cleared the failure later");
  });

  for (const locale of ["en-US", "zh-CN"]) await check(`storage quota: failed delete and clear report the action accurately (${locale})`, async context => {
    const page = await seed(context);
    await page.waitForTimeout(350);
    const before = await stored(page);
    await page.evaluate(() => {
      const nativeSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key.startsWith("scattered-")) throw new DOMException("Full", "QuotaExceededError");
        return nativeSet.call(this, key, value);
      };
    });
    await page.locator("#boards-button").click();
    await page.locator("#delete-board-button").click();
    await page.locator("#delete-board-button").click();
    await page.waitForFunction(text => document.querySelector("#toast").textContent.includes(text), locale === "en-US" ? "canvas was not deleted" : "未删除画布");
    assert.match(await page.locator("#toast").textContent(), locale === "en-US" ? /canvas was not deleted/ : /未删除画布/);
    assert.deepEqual(await stored(page), before);
    await page.locator("#boards-button").click();
    await page.locator("#menu-button").click();
    await page.locator("#clear-button").click();
    await page.locator("#clear-button").click();
    await page.waitForFunction(text => document.querySelector("#toast").textContent.includes(text), locale === "en-US" ? "canvas was not cleared" : "未清空画布");
    assert.match(await page.locator("#toast").textContent(), locale === "en-US" ? /canvas was not cleared/ : /未清空画布/);
    assert.deepEqual(await stored(page), before);
  }, { locale });

  for (const [userAgent, calls] of [["Mozilla/5.0 Gecko/20100101 Firefox/140.0", 0], ["Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 FxiOS/140.0 Mobile/15E148 Safari/605.1.15", 1]]) {
    await check(`storage quota: persistence respects the ${calls ? "FxiOS" : "Firefox"} user agent across reload`, async context => {
      await context.addInitScript(() => {
        window.persistenceCalls = 0;
        if (!navigator.storage) return;
        Object.defineProperty(navigator.storage, "persisted", { configurable: true, value: async () => false });
        Object.defineProperty(navigator.storage, "persist", { configurable: true, value: async () => { window.persistenceCalls++; return false; } });
      });
      const page = await seed(context);
      assert.equal(await page.evaluate(() => window.persistenceCalls), calls);
      await page.reload();
      await page.locator('.node[data-id="a"]').waitFor();
      assert.equal(await page.evaluate(() => window.persistenceCalls), calls);
    }, { userAgent });
  }

  await check("storage quota: a real browser capacity limit is recovered without deleting unrelated storage", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    const filled = await page.evaluate(async () => {
      const w = await import("./workspace.js?v=87");
      const { board } = w.loadWorkspace(localStorage);
      for (let i = 1; i <= 3; i++) w.captureRecovery(localStorage, `old-${i}`, {
        ...board, nodes: [{ ...board.nodes[0], text: String(i).repeat(4000) }],
      }, "delete", () => i);
      let reached = false, count = 0;
      const chunk = "x".repeat(64 * 1024);
      for (; count < 128; count++) {
        try { localStorage.setItem(`quota-padding-${count}`, chunk); }
        catch (error) { if (error.name !== "QuotaExceededError") throw error; reached = true; break; }
      }
      if (!reached) throw new Error("No capacity error within the bounded synthetic fixture");
      let low = 0, high = chunk.length;
      while (high - low > 1) {
        const size = Math.floor((low + high) / 2);
        try { localStorage.setItem("quota-tail", "x".repeat(size)); low = size; }
        catch (error) { if (error.name !== "QuotaExceededError") throw error; high = size; }
      }
      return { count, tail: low };
    });
    await page.locator(".node.editing textarea").fill("Saved at the real capacity limit");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.waitForFunction(() => {
      const ws = JSON.parse(localStorage.getItem("scattered-workspace-v2"));
      return JSON.parse(localStorage.getItem(`scattered-document-v2:${ws.activeId}`)).nodes[0].text === "Saved at the real capacity limit";
    });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("scattered-recovery-v2")).map(e => e.boardId)), ["old-3", "old-2"]);
    assert.deepEqual(await page.evaluate(() => ({ count: Object.keys(localStorage).filter(k => k.startsWith("quota-padding-")).length, tail: localStorage.getItem("quota-tail").length })), filled);
    await page.reload();
    await page.locator('.node[data-id="a"]').waitFor();
    assert.equal((await stored(page))[0].nodes[0].text, "Saved at the real capacity limit");
  });

  await check("caret following saves typed text during motion and stops on editor exit or page hide", async context => {
    const text = Array.from({ length: 150 }, (_, i) => `Line ${i} 中文`).join("\n");
    const page = await seed(context, [note("a", 100, 200, text)]);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.locator('.node[data-id="a"]').dblclick({ position: { x: 24, y: 24 } });
    await page.waitForTimeout(350);
    const editor = page.locator(".node.editing textarea");
    await editor.evaluate(e => {
      e.value = "新" + e.value;
      e.setSelectionRange(1, 1);
      e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "新" }));
    });
    await page.waitForTimeout(650);
    assert.equal(await page.locator("#viewport").evaluate(v => v.classList.contains("following-caret")), true);
    assert.equal((await stored(page))[0].nodes[0].text, "新" + text, "Animation must not keep postponing the typing save");
    await editor.press("Control+Enter");
    const stopped = await page.locator("#world").getAttribute("style");
    await page.waitForTimeout(350);
    assert.equal(await page.locator("#world").getAttribute("style"), stopped, "Finishing editing stops at the displayed view");
    // Re-enter via the existing node API and trigger a new distant target.
    await page.locator('.node[data-id="a"]').press("Enter");
    await page.waitForTimeout(350);
    await editor.evaluate(e => e.setSelectionRange(0, 0));
    await page.waitForTimeout(80);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    const hidden = await page.locator("#world").getAttribute("style");
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#world").getAttribute("style"), hidden);
    assert.equal(await page.locator("#viewport").evaluate(v => v.classList.contains("following-caret")), false);
  });

  await check("caret follows respect reduced motion", async context => {
    const page = await seed(context, [note("a", 100, 200, "中文 long note\n".repeat(150))]);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.locator('.node[data-id="a"]').dblclick({ position: { x: 24, y: 24 } });
    await page.waitForTimeout(350);
    const editor = page.locator(".node.editing textarea");
    await editor.evaluate(e => e.setSelectionRange(0, 0));
    await page.waitForTimeout(100);
    assert.ok((await editor.boundingBox()).y >= 0, "Reduced motion reveals the caret without a prolonged journey");
    assert.equal(await page.locator("#viewport").evaluate(v => v.classList.contains("following-caret")), false);
  }, { reducedMotion: "reduce" });

  await check("large native caret jumps are speed-limited and retarget without a snap", async context => {
    const text = Array.from({ length: 150 }, (_, i) => `Line ${i} 中文`).join("\n");
    const page = await seed(context, [note("a", 100, 200, text)]);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.locator('.node[data-id="a"]').dblclick({ position: { x: 24, y: 24 } });
    await page.waitForTimeout(350);
    const result = await page.locator(".node.editing textarea").evaluate(async e => {
      const world = document.querySelector("#world");
      const read = () => ({ t: performance.now(), y: new DOMMatrix(getComputedStyle(world).transform).m42 });
      const samples = [read()];
      e.setSelectionRange(0, 0);
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 60));
        samples.push(read());
        // Replace the destination mid-flight, as native keyboard trackpad
        // updates do. This must not build a queue of stale destinations.
        if (i === 2) e.setSelectionRange(100, 100);
      }
      const beforeReverse = read();
      e.setSelectionRange(e.value.length, e.value.length);
      await new Promise(r => setTimeout(r, 100));
      const reversed = read();
      // A new touch inside the editor cancels following at the displayed view,
      // without jumping to the previously requested distant destination.
      e.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 91 }));
      const cancelled = read();
      await new Promise(r => setTimeout(r, 100));
      return { samples, beforeReverse, reversed, cancelled, settled: read(), start: e.selectionStart, end: e.selectionEnd, length: e.value.length };
    });
    const first = result.samples[0], last = result.samples.at(-1);
    const speed = (last.y - first.y) / (last.t - first.t);
    assert.ok(speed > 0.04 && speed <= 0.27, `Large jumps must stay at or below 240px/s (with sampling tolerance): ${JSON.stringify(result)}`);
    for (let i = 1; i < result.samples.length; i++) {
      const a = result.samples[i - 1], b = result.samples[i];
      assert.ok(b.y >= a.y - 1 && b.y - a.y <= (b.t - a.t) * 0.27 + 3, "Retargeting must not jump or reverse while the caret is still above");
    }
    assert.ok(result.reversed.y <= result.beforeReverse.y + 5, "Returning the caret to the bottom must stop following the old upward target");
    assert.ok(Math.abs(result.cancelled.y - result.reversed.y) < 2, "A fresh touch must not snap to the target");
    assert.ok(Math.abs(result.settled.y - result.cancelled.y) < 2, "Cancelled following must stay stopped");
    assert.deepEqual([result.start, result.end], [result.length, result.length]);
    assert.deepEqual(await scroll(page), [0, 0]);
  });

  await check("startup distinguishes loading from an empty canvas until local notes are painted", async context => {
    for (const theme of ["light", "dark"]) {
      const page = await context.newPage();
      await page.goto(`${origin}/about.html`);
      await page.evaluate(({ board, theme }) => {
        localStorage.setItem("scattered-board-v1", JSON.stringify(board));
        localStorage.setItem("scattered-theme", theme);
      }, { board: { ...blankBoard(), nodes: [note("a", 100, 200)] }, theme });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route("**/app.js?*", async route => { await gate; await route.continue(); });
      try {
        await page.goto(origin, { waitUntil: "commit" });
        await page.locator("#viewport").waitFor({ state: "attached" });
        assert.equal(await page.locator("#viewport").isVisible(), false, "The unpopulated canvas must not look like deleted notes");
        assert.equal(await page.locator("#chrome-layer .app-mark").isVisible(), false);
        assert.equal(await page.locator("#app-loading").isVisible(), true);
        assert.equal(await page.locator("#startup-retry").isVisible(), false);
        assert.equal(await page.locator("#node-layer .node").count(), 0, "Module loading is still paused");
      } finally { release(); }
      await page.locator('.node[data-id="a"]').waitFor();
      assert.equal(await page.locator("#app-loading").isVisible(), false);
      assert.equal(await page.locator("#viewport").getAttribute("aria-busy"), "false");
      assert.equal(await page.locator("#viewport").getAttribute("inert"), null);
      assert.equal(await page.locator("#chrome-layer").getAttribute("inert"), null);
      assert.equal(await page.locator("#empty-state").isVisible(), false);
      // Capture the shell's appearance only after the intentionally blocked
      // document is complete (Playwright screenshots wait for fonts.ready).
      await page.evaluate(() => document.documentElement.classList.add("app-loading"));
      await page.screenshot({ path: `/tmp/scattered-startup-${theme}.png` });
      await page.evaluate(() => document.documentElement.classList.remove("app-loading"));
      await page.close();
    }
  });

  await check("a failed app module offers retry without displaying an empty workspace or clearing notes", async context => {
    const page = await context.newPage();
    await page.goto(`${origin}/about.html`);
    const backup = JSON.stringify({ ...blankBoard(), nodes: [note("a", 100, 200, "Keep this note")] });
    await page.evaluate(backup => localStorage.setItem("scattered-board-v1", backup), backup);
    let fail = true;
    await page.route("**/app.js?*", route => fail ? route.abort() : route.continue());
    await page.goto(origin, { waitUntil: "commit" });
    await page.locator("#startup-retry").waitFor({ timeout: 3000 });
    assert.equal(await page.locator("#viewport").isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("scattered-board-v1")), backup);
    fail = false;
    await page.locator("#startup-retry").click();
    await page.locator('.node[data-id="a"]').waitFor();
    assert.equal(await page.locator('.node[data-id="a"] .node-text').textContent(), "Keep this note");
    assert.equal(await page.locator("#app-loading").isVisible(), false);
  });

  await check("short caret follows remain gradual without slowing entry into editing", async context => {
    const text = Array.from({ length: 150 }, (_, i) => `Line ${i} 中文`).join("\n");
    const page = await seed(context, [note("a", 100, 200, text)]);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.locator('.node[data-id="a"]').dblclick({ position: { x: 24, y: 24 } });
    assert.equal(await page.locator("#world").evaluate(w => getComputedStyle(w).transitionDuration), "0.18s", "Entry retains its original animation");
    await page.waitForTimeout(350);
    const sample = await page.locator(".node.editing textarea").evaluate(async editor => {
      const world = document.querySelector("#world");
      const startY = new DOMMatrix(getComputedStyle(world).transform).m42;
      const caret = editor.value.split("\n").slice(0, 134).join("\n").length + 1;
      editor.setSelectionRange(caret, caret);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const following = document.querySelector("#viewport").classList.contains("following-caret");
      await new Promise(resolve => setTimeout(resolve, 75));
      const currentY = new DOMMatrix(getComputedStyle(world).transform).m42;
      for (let i = 0; i < 8; i++) {
        editor.dispatchEvent(new Event("selectionchange"));
        await new Promise(resolve => setTimeout(resolve, 45));
      }
      await new Promise(resolve => setTimeout(resolve, 90));
      const targetY = new DOMMatrix(getComputedStyle(world).transform).m42;
      const stillFollowing = document.querySelector("#viewport").classList.contains("following-caret");
      return { following, stillFollowing, distance: targetY - startY, fraction: (currentY - startY) / (targetY - startY), caret, actualCaret: editor.selectionStart };
    });
    assert.equal(sample.following, true);
    assert.equal(sample.stillFollowing, false, "Repeated notifications of the same caret must not restart or prolong following");
    assert.ok(sample.distance > 0 && sample.distance < 72, JSON.stringify(sample));
    assert.ok(sample.fraction > 0 && sample.fraction < 0.7, JSON.stringify(sample));
    assert.equal(sample.actualCaret, sample.caret);
    await page.waitForTimeout(400);
    assert.deepEqual(await scroll(page), [0, 0]);
  });

  await check("caret movement within a wrapped word does not jump the camera by a line", async context => {
    const text = "Some long paragraphs with automatic wrapping and comfortable cursor movement. 中文文字混合 automatic words ".repeat(30);
    const page = await seed(context, [note("a", 50, 150, text)]);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.locator('.node[data-id="a"]').dblclick({ position: { x: 24, y: 24 } });
    await page.waitForTimeout(350);
    const editor = page.locator(".node.editing textarea");
    const word = text.indexOf("Some", 1);
    // The second "Some" wraps as a whole. Truncating its suffix during caret
    // measurement incorrectly places its first three letters on the prior line.
    await editor.evaluate((e, caret) => e.setSelectionRange(caret, caret), word + 3);
    await settleReveal(page);
    const before = await page.locator("#world").evaluate(w => new DOMMatrix(w.style.transform).m42);
    await editor.evaluate((e, caret) => e.setSelectionRange(caret, caret), word + 1);
    await page.waitForTimeout(350);
    const after = await page.locator("#world").evaluate(w => new DOMMatrix(w.style.transform).m42);
    assert.ok(Math.abs(after - before) < 0.5, `Same wrapped line must not move the camera: ${before} -> ${after}`);
    assert.equal(await editor.inputValue(), text);
    assert.equal(await editor.evaluate(e => e.selectionStart), word + 1);
    assert.deepEqual(await scroll(page), [0, 0]);
  });

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
      await settleReveal(page);
      assert.deepEqual(await scroll(page), [0, 0]);
      let rect = await editor.boundingBox();
      assert.ok(rect.y + rect.height < size.height && rect.y + rect.height > 40, `End caret is in view: ${JSON.stringify(rect)}`);
      await editor.press("Meta+ArrowUp");
      assert.equal(await editor.evaluate(e => e.selectionStart), 0, "Home shortcut moves the actual caret");
      await settleReveal(page);
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

  await check("native caret changes reveal long-note text without keyboard or select events", async context => {
    const page = await seed(context);
    await page.setViewportSize({ width: 390, height: 500 });
    await edit(page, Array.from({ length: 150 }, (_, i) => `Line ${i} 中文`).join("\n"), false);
    const editor = page.locator(".node.editing textarea");
    await settleReveal(page);
    assert.ok((await editor.boundingBox()).y < -100, "Fixture starts with the beginning off screen");
    await editor.evaluate(e => {
      // Native collapsed-caret movement can emit selectionchange alone. Do not
      // let the extra select event from the script API mask the missing handler.
      e.addEventListener("select", event => event.stopImmediatePropagation(), true);
      e.setSelectionRange(0, 0);
    });
    await settleReveal(page);
    const rect = await editor.boundingBox();
    assert.ok(rect.y >= 0 && rect.y < 460, `Changed caret is visible: ${JSON.stringify(rect)}`);
    assert.equal(await editor.evaluate(e => e.selectionStart), 0, "Camera movement does not rewrite the caret");
    // Follow multiple incremental movements as well, including backward selection.
    for (const line of [15, 30, 45, 30, 15, 0]) {
      const caret = await editor.evaluate((e, line) => {
        const start = e.value.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
        e.setSelectionRange(start, start + 4, "backward");
        return start;
      }, line);
      await settleReveal(page);
      const position = await editor.evaluate((e, line) => ({
        y: e.getBoundingClientRect().y + line * parseFloat(getComputedStyle(e).lineHeight),
        start: e.selectionStart, end: e.selectionEnd, direction: e.selectionDirection,
      }), line);
      assert.ok(position.y >= 40 && position.y < 460, JSON.stringify(position));
      assert.deepEqual([position.start, position.end, position.direction], [caret, caret + 4, "backward"]);
    }
    // Older WebKit can notify on document instead of on the textarea.
    await editor.evaluate(e => {
      e.addEventListener("selectionchange", event => event.stopImmediatePropagation(), true);
      e.setSelectionRange(e.value.length, e.value.length);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await settleReveal(page);
    const endRect = await editor.boundingBox();
    assert.ok(endRect.y + endRect.height > 40 && endRect.y + endRect.height < 500);
    assert.deepEqual(await scroll(page), [0, 0]);
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
  await check("a stalled network falls back to cached resources while the browser still reports online", async context => {
    const page = await seed(context);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    assert.equal(await page.evaluate(() => navigator.onLine), true);
    stallNetwork = true;
    try {
      // A network failure rejects fast in automation; a hanging request does not.
      // The cached document AND its module graph must load without that rejection.
      await page.reload({ waitUntil: "domcontentloaded", timeout: 8000 });
      await page.locator('.node[data-id="a"]').waitFor({ timeout: 1000 });
      assert.ok(stalledRequests.size > 0, "Real network requests are still pending");
      await edit(page, "Saved while network hangs");
      assert.equal((await stored(page))[0].nodes[0].text, "Saved while network hangs");
    } finally {
      stallNetwork = false;
      for (const release of [...stalledRequests]) release();
    }
    await page.reload();
    await page.locator('.node[data-id="a"]').waitFor();
    assert.equal(await page.locator('.node[data-id="a"] .node-text').textContent(), "Saved while network hangs");
  }, { serviceWorkers: "allow" });
  // This automation environment fails offline navigation inside WebKit itself,
  // identically on the unmodified v85 baseline. Do not count it as a passed test.
  if (engine === "webkit") console.log("SKIP webkit: offline reload needs device acceptance; the same internal navigation error occurs on v85");
  else await check("the new offline cache loads all updated modules and keeps local saving available", async context => {
    const page = await seed(context);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.waitForFunction(async name => (await caches.keys()).includes(name), cacheName);
    await context.setOffline(true);
    await page.reload();
    await page.locator('.node[data-id="a"]').waitFor();
    await edit(page, "Offline edit");
    assert.equal((await stored(page))[0].nodes[0].text, "Offline edit");
  }, { serviceWorkers: "allow" });
  assert.deepEqual(errors, [], "No unhandled browser errors");
  assert.deepEqual(failures, [], "All reliability scenarios must pass");
} finally { await browser.close(); server.close(); }
