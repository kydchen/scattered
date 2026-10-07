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
  await context.addInitScript(() => {
    // Explicit test helpers use real DOM Selection; no textarea-like properties
    // are installed on the production editor. Native typing is tested below too.
    window.noteText = e => e.innerText.replace(/\n$/, "");
    window.setNoteText = (e, text) => {
      e.textContent = text;
      if (text.endsWith("\n")) e.append(document.createElement("br"));
    };
    window.setNoteSelection = (e, start, end = start, direction = "forward") => {
      const point = offset => {
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.nodeType === Node.TEXT_NODE) {
            const base = noteOffset(e, node, 0);
            if (offset >= base && offset <= base + node.length) return [node, offset - base];
          } else if (node.nodeName === "BR") {
            const index = [...node.parentNode.childNodes].indexOf(node);
            if (offset === noteOffset(e, node.parentNode, index)) return [node.parentNode, index];
          }
        }
        return [e, e.childNodes.length];
      };
      const anchor = point(direction === "backward" ? end : start);
      const focus = point(direction === "backward" ? start : end);
      getSelection().setBaseAndExtent(...anchor, ...focus);
    };
    window.noteOffset = (e, node, offset) => {
      const probe = e.cloneNode(true);
      probe.className = ""; probe.removeAttribute("contenteditable"); probe.hidden = false;
      probe.style.cssText = "position:fixed;left:-100000px;white-space:pre-wrap;opacity:0;pointer-events:none";
      probe.setAttribute("aria-hidden", "true");
      const path = [];
      for (let n = node; n !== e; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
      let point = probe; for (const index of path) point = point.childNodes[index];
      const r = document.createRange(); r.setStart(point, offset); r.collapse(true);
      r.insertNode(document.createTextNode("\ue000")); document.body.append(probe);
      const length = probe.innerText.indexOf("\ue000"); probe.remove();
      return Math.min(length, noteText(e).length);
    };
    window.noteSelection = e => {
      const s = getSelection();
      const anchor = noteOffset(e, s.anchorNode, s.anchorOffset), focus = noteOffset(e, s.focusNode, s.focusOffset);
      return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), direction: focus < anchor ? "backward" : "forward" };
    };
  });
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
  await page.locator('.node[data-id="a"] .node-editor').fill(text);
  if (finish) await page.locator('.node[data-id="a"] .node-editor').press("Control+Enter");
  await page.waitForTimeout(300);
}
async function setRecoveryQuota(page) {
  await page.evaluate(async () => {
    const w = await import("./workspace.js?v=89");
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
  await check("pending delta: real lifecycle stages only changed cards and recovers after closing the writer", async context => {
    const nodes = [note("a", 100, 200), ...Array.from({ length: 100 }, (_, i) => note(`b${i}`, 800 + i * 300, 900, "Unchanged ".repeat(100)))];
    const page = await seed(context, nodes, [{ id: "e", from: "a", to: "b0", arrow: false, label: "Context" }]);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    await page.evaluate(() => {
      const native = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key.startsWith("scattered-document")) throw new DOMException("Full", "QuotaExceededError");
        return native.call(this, key, value);
      };
      const editor = document.querySelector(".node.editing .node-editor");
      setNoteText(editor, "最后未保存的文字\nLast words");
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      window.dispatchEvent(new Event("pagehide"));
    });
    const pending = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith("scattered-pending-delta-v1:"));
      return JSON.parse(localStorage.getItem(key));
    });
    assert.equal(pending.delta.nodes.put.length, 1);
    assert.equal(pending.delta.contextNodes.length, 1);
    assert.equal((await stored(page))[0].nodes[0].text, "a", "The primary write really failed");
    await page.close();
    const reopened = await context.newPage(); await reopened.goto(origin);
    await reopened.locator('.node[data-id="a"]').waitFor();
    const documents = await stored(reopened);
    assert.equal(documents.length, 1);
    assert.equal(documents[0].nodes[0].text, "最后未保存的文字\nLast words");
    assert.equal(documents[0].nodes.length, 101);
    assert.equal(documents[0].edges[0].label, "Context");
    assert.equal(await reopened.evaluate(() => Object.keys(localStorage).some(k => k.startsWith("scattered-pending"))), false);
  });

  await check("pending delta: simultaneous startup waits for the native lock and replays a conflict only once", async context => {
    const holder = await seed(context);
    await holder.evaluate(async () => {
      const w = await import("./workspace.js?v=89");
      const { workspace, board } = w.loadWorkspace(localStorage);
      const pending = structuredClone(board); pending.nodes[0].text = "Pending edit";
      w.stagePendingDocument(localStorage, workspace, pending, Date.now, { baseBoard: board });
      w.saveDocument(localStorage, workspace, { ...board, title: "Peer saved title" });
      await new Promise(resolve => {
        void navigator.locks.request("scattered-workspace-v2", async () => {
          resolve(); await new Promise(release => { window.releaseStartupLock = release; });
        });
      });
    });
    const a = await context.newPage(), b = await context.newPage();
    await Promise.all([a.goto(origin, { waitUntil: "commit" }), b.goto(origin, { waitUntil: "commit" })]);
    await a.waitForTimeout(250);
    assert.equal(await a.locator(".node").count(), 0);
    assert.equal((await stored(holder)).length, 1);
    await holder.evaluate(() => window.releaseStartupLock());
    await Promise.all([a.locator('.node[data-id="a"]').waitFor(), b.locator('.node[data-id="a"]').waitFor()]);
    const docs = await stored(a);
    assert.equal(docs.length, 2);
    assert.ok(docs.some(d => d.nodes[0].text === "Pending edit"));
    assert.ok(docs.some(d => d.title === "Peer saved title" && d.nodes[0].text === "a"));
  });

  await check("pending delta: an ordinary save acknowledges a journal even when clearing it is denied", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    await page.evaluate(() => {
      const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key.startsWith("scattered-pending") && value === "null") throw new DOMException("Denied", "SecurityError");
        return set.call(this, key, value);
      };
      Storage.prototype.removeItem = function(key) {
        if (this === localStorage && key.startsWith("scattered-pending")) throw new DOMException("Denied", "SecurityError");
        return remove.call(this, key);
      };
      const editor = document.querySelector(".node.editing .node-editor");
      setNoteText(editor, "First staged words"); editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      window.dispatchEvent(new Event("pagehide"));
    });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("scattered-workspace-v2")).appliedPending?.length === 1);
    await page.locator(".node.editing .node-editor").fill("Later saved words");
    await page.locator(".node.editing .node-editor").press("Control+Enter");
    await page.waitForTimeout(300);
    assert.equal((await stored(page))[0].nodes[0].text, "Later saved words");
    await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
    const docs = await stored(page);
    assert.equal(docs.length, 1); assert.equal(docs[0].nodes[0].text, "Later saved words");
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith("scattered-pending"))), false);
  });

  for (const locale of ["en-US", "zh-CN"]) {
    await check(`pending delta: exporting corrupt data preserves a quarantine copy and clears the warning (${locale})`, async context => {
      const page = await seed(context);
      await page.evaluate(() => {
        localStorage.setItem("scattered-pending-delta-v1:broken", '{"private":"unrecoverable test text"}');
        localStorage.setItem("test-google-token", "never export this token");
      });
      await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
      const warning = page.locator('#toast[data-persistent="true"]');
      assert.match(await warning.textContent(), locale === "zh-CN" ? /原始数据在本机单独保留/ : /set them aside locally/);
      assert.equal(await warning.getAttribute("role"), "button");
      await edit(page, "New safely saved words");
      assert.equal(await warning.isVisible(), true, "Saving must not conceal the unrecovered edits");
      await page.evaluate(() => {
        Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false });
        const native = URL.createObjectURL;
        URL.createObjectURL = function(blob) { window.pendingExport = blob.text(); return native.call(this, blob); };
      });
      await warning.focus(); await warning.press("Enter");
      const exported = await page.evaluate(async () => JSON.parse(await window.pendingExport));
      assert.equal(exported.format, "scattered-pending-recovery");
      assert.ok(exported.pending.some(p => p.encoded.includes("unrecoverable test text")));
      assert.ok(!JSON.stringify(exported).includes("never export this token"));
      await page.waitForFunction(() => localStorage.getItem("scattered-pending-delta-v1:broken") === null);
      assert.equal(await warning.isVisible(), false);
      assert.ok(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith("scattered-quarantined-pending") && localStorage.getItem(k) === '{"private":"unrecoverable test text"}')));
      await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
      assert.equal(await warning.isVisible(), false);
      assert.equal((await stored(page))[0].nodes[0].text, "New safely saved words");
    }, { locale });
  }

  await check("pending delta: a newer format is retained across reload, then recovers when readable", async context => {
    const page = await seed(context);
    await page.evaluate(async () => {
      const w = await import("./workspace.js?v=89"), { workspace, board } = w.loadWorkspace(localStorage);
      w.stagePendingDocument(localStorage, workspace, { ...board, title: "Newer edits" }, Date.now, { baseBoard: board });
      const key = Object.keys(localStorage).find(k => k.startsWith("scattered-pending"));
      const p = JSON.parse(localStorage.getItem(key)); (p.board || p.delta).version += 1;
      localStorage.setItem(key, JSON.stringify(p));
    });
    await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
    const warning = page.locator("#toast");
    assert.match(await warning.textContent(), /newer app/);
    await Promise.all([page.waitForEvent("load"), warning.click()]);
    await page.locator('.node[data-id="a"]').waitFor();
    assert.match(await warning.textContent(), /newer app/);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith("scattered-quarantined"))), false);
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(k => k.startsWith("scattered-pending"));
      const p = JSON.parse(localStorage.getItem(key)); (p.board || p.delta).version -= 1;
      localStorage.setItem(key, JSON.stringify(p));
    });
    await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
    assert.equal(await warning.isVisible(), false);
    assert.equal((await stored(page))[0].title, "Newer edits");
  });

  await check("pending delta: cancelled export or failed quarantine keeps the raw journal and warning", async context => {
    const page = await seed(context);
    await page.evaluate(() => localStorage.setItem("scattered-pending-delta-v1:broken", "broken bytes"));
    await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: async () => { throw new DOMException("Cancelled", "AbortError"); } });
    });
    await page.locator("#toast").click(); await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => localStorage.getItem("scattered-pending-delta-v1:broken")), "broken bytes");
    assert.match(await page.locator("#toast").textContent(), /set them aside locally/);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "share", { configurable: true, value: async () => {} });
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key.startsWith("scattered-quarantined")) throw new DOMException("Full", "QuotaExceededError");
        return set.call(this, key, value);
      };
    });
    await page.locator("#toast").click();
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("safekeeping failed"));
    assert.equal(await page.evaluate(() => localStorage.getItem("scattered-pending-delta-v1:broken")), "broken bytes");
    assert.equal(await page.locator("#toast").getAttribute("role"), "button");
  });

  await check("pending delta: export cannot remove pending bytes changed while the share dialog was open", async context => {
    const page = await seed(context);
    await page.evaluate(() => localStorage.setItem("scattered-pending-delta-v1:broken", "old broken bytes"));
    await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: () => new Promise(resolve => { window.finishRecoveryExport = resolve; }) });
    });
    await page.locator("#toast").click();
    await page.waitForFunction(() => window.finishRecoveryExport);
    await page.evaluate(() => {
      localStorage.setItem("scattered-pending-delta-v1:broken", "new pending bytes");
      window.finishRecoveryExport();
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => localStorage.getItem("scattered-pending-delta-v1:broken")), "new pending bytes");
    assert.equal(await page.locator("#toast").isVisible(), true);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith("scattered-quarantined"))), false);
  });

  for (const locale of ["en-US", "zh-CN"]) {
    await check(`pending delta: current save failure takes priority, then recovery warning returns (${locale})`, async context => {
      const page = await seed(context);
      await page.evaluate(() => localStorage.setItem("scattered-pending-delta-v1:broken", "broken bytes"));
      await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
      await page.evaluate(() => {
        const set = Storage.prototype.setItem;
        window.blockDocumentSave = true;
        Storage.prototype.setItem = function(key, value) {
          if (this === localStorage && window.blockDocumentSave && key.startsWith("scattered-document")) throw new DOMException("Full", "QuotaExceededError");
          return set.call(this, key, value);
        };
      });
      await edit(page, "Must not hide my save failure");
      const warning = page.locator("#toast");
      assert.match(await warning.textContent(), locale === "zh-CN" ? /存储已满/ : /Storage is full/);
      assert.equal(await warning.getAttribute("role"), null);
      assert.equal(await warning.getAttribute("data-dismissible"), "false");
      await page.evaluate(() => { window.blockDocumentSave = false; });
      await edit(page, "Successfully saved now");
      assert.match(await warning.textContent(), locale === "zh-CN" ? /原始数据在本机单独保留/ : /set them aside locally/);
      assert.equal(await warning.getAttribute("role"), "button");
    }, { locale });
  }

  await check("plaintext editor: existing whitespace, blank lines and markup round-trip without changes", async context => {
    const page = await seed(context);
    for (const text of ["", "\n", "\n\n", "a\n", "a\n\n", "  spaces  \n\t中文🙂 e\u0301\n", '<img src=x onerror="alert(1)">\n<script>bad()</script>']) {
      await page.evaluate(async text => {
        const w = await import("./workspace.js?v=89");
        const { workspace, board } = w.loadWorkspace(localStorage);
        board.nodes[0].text = text;
        w.saveDocument(localStorage, workspace, board);
      }, text);
      await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
      await page.locator('.node[data-id="a"]').dblclick();
      const editor = page.locator(".node.editing .node-editor");
      assert.equal(await editor.getAttribute("contenteditable"), "plaintext-only");
      assert.equal(await editor.getAttribute("aria-multiline"), "true");
      assert.equal(await editor.evaluate(e => noteText(e)), text);
      assert.equal(await editor.locator("img, script").count(), 0, "Stored markup must remain literal text");
      assert.equal(await editor.evaluate(e => noteSelection(e).end), text.length);
      await editor.press("Control+Enter");
      await page.waitForTimeout(250);
      assert.equal((await stored(page))[0].nodes[0].text, text, "Merely editing must not add/remove authored whitespace");
      await page.locator('.node[data-id="a"]').dblclick();
      await editor.fill(text);
      await editor.press("Control+Enter"); await page.waitForTimeout(250);
      assert.equal((await stored(page))[0].nodes[0].text, text, "Native multiline insertion preserves the same whitespace");
    }
  });

  await check("plaintext editor: native Enter, blank lines, Shift+Enter and deletion persist exactly", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    const editor = page.locator(".node.editing .node-editor");
    for (const [key, expected] of [["Enter", "a\n"], ["Enter", "a\n\n"], ["b", "a\n\nb"], ["Shift+Enter", "a\n\nb\n"], ["Backspace", "a\n\nb"], ["Backspace", "a\n\n"]]) {
      await editor.press(key);
      await page.waitForTimeout(250);
      assert.equal((await stored(page))[0].nodes[0].text, expected, key);
      assert.deepEqual(await scroll(page), [0, 0]);
    }
    await editor.press("Control+Enter");
    await page.reload(); await page.locator('.node[data-id="a"]').waitFor();
    assert.equal((await stored(page))[0].nodes[0].text, "a\n\n");
  });

  await check("plaintext editor: native text undo and shortcuts stay inside the editor", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    const editor = page.locator(".node.editing .node-editor");
    await editor.press("Space"); await page.keyboard.type("native typing");
    assert.equal(await editor.evaluate(e => noteText(e)), "a native typing");
    assert.equal(await page.locator("#viewport.pan-ready").count(), 0);
    await editor.press("Meta+z");
    assert.equal(await editor.evaluate(e => noteText(e)), "a", "Native undo must not delete/re-render the card");
    assert.equal(await editor.evaluate(e => e === document.activeElement), true);
    await editor.press("Meta+Shift+z");
    assert.equal(await editor.evaluate(e => noteText(e)), "a native typing");
    await editor.press("Control+Enter");
    await page.locator("#undo-button").click(); await page.waitForTimeout(250);
    assert.equal((await stored(page))[0].nodes[0].text, "a", "App undo still treats the edit session as one change");
  });

  await check("plaintext editor: native undo cannot edit a different closed card", async context => {
    const page = await seed(context, [note("a", 100, 200), note("b", 500, 300)]);
    await page.locator('.node[data-id="a"]').dblclick();
    await page.keyboard.type(" alpha"); await page.keyboard.press("Control+Enter");
    await page.locator('.node[data-id="b"]').dblclick();
    await page.keyboard.type(" beta");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Meta+z");
      assert.equal(await page.locator('.node[data-id="a"] .node-editor').textContent(), "a alpha");
      assert.equal(await page.locator('.node[data-id="a"] .node-text').textContent(), "a alpha");
      assert.equal(await page.locator('.node[data-id="b"] .node-editor').evaluate(e => document.activeElement === e), true);
    }
    assert.equal(await page.locator('.node[data-id="b"] .node-editor').innerText(), "b");
    await page.keyboard.press("Control+Enter"); await page.waitForTimeout(250);
    assert.deepEqual((await stored(page))[0].nodes.map(n => n.text), ["a alpha", "b"]);
  });

  await check("plaintext editor: browser rich insertion is plain text and clipboard handlers do not create cards", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    const editor = page.locator(".node.editing .node-editor");
    const result = await editor.evaluate(e => {
      setNoteSelection(e, 0, 1);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "中文\nSecond line");
      clipboardData.setData("text/html", "<b>中文</b><div>Second line</div>");
      const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
      e.dispatchEvent(paste);
      // Synthetic paste cannot run a native default action. Exercise the native
      // plaintext insertion engine separately, without touching the OS clipboard.
      document.execCommand("insertHTML", false, '<b>中文</b><div>Second line</div>');
      const copy = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      e.dispatchEvent(copy);
      return { pasteBlocked: paste.defaultPrevented, copyBlocked: copy.defaultPrevented, html: e.innerHTML, text: noteText(e) };
    });
    assert.equal(result.pasteBlocked, false); assert.equal(result.copyBlocked, false);
    assert.equal(await page.locator(".node").count(), 1);
    assert.equal(await editor.locator("b, div, span, img").count(), 0, result.html);
    assert.equal(result.text, "中文\nSecond line");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.waitForTimeout(250);
    assert.equal((await stored(page))[0].nodes[0].text, "中文\nSecond line");
  });

  await check("plaintext editor: card typography and dimensions stay consistent in both themes and sizes", async context => {
    const page = await seed(context, [note("a", 50, 200, "中文卡片\nEnglish notes\n第三行")]);
    for (const width of [744, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const before = await page.locator('.node[data-id="a"] .node-text').evaluate(e => {
          const s = getComputedStyle(e);
          return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, e.getBoundingClientRect().height];
        });
        await page.locator('.node[data-id="a"]').dblclick(); await settleReveal(page);
        const editor = page.locator(".node.editing .node-editor");
        const after = await editor.evaluate(e => {
          const s = getComputedStyle(e);
          return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, e.getBoundingClientRect().height];
        });
        assert.deepEqual(after, before, `${theme}, ${width}px: entering editing must not restyle the text`);
        await page.screenshot({ path: `/tmp/scattered-editor-${engine}-${theme}-${width}.png` });
        await editor.press("Control+Enter");
      }
    }
  });

  await check("plaintext editor: new trailing lines follow their visible caret without a phantom row", async context => {
    const text = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n");
    const page = await seed(context, [note("a", 50, 200, text)]);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.locator('.node[data-id="a"]').dblclick({ position: { x: 24, y: 24 } });
    await settleReveal(page);
    const editor = page.locator(".node.editing .node-editor");
    for (let i = 1; i <= 3; i++) {
      await editor.press("Enter"); await settleReveal(page);
      assert.equal((await stored(page))[0].nodes[0].text, text + "\n".repeat(i));
      const box = await editor.boundingBox();
      assert.ok(box.y + box.height > 418 && box.y + box.height < 432, JSON.stringify({ i, box }));
    }
  });

  for (const cardCount of [1, 2000]) {
    await check(`autosave: continuous typing reaches storage while the same editor remains open (${cardCount} cards)`, async context => {
      const nodes = [note("a", 100, 200), ...Array.from({ length: cardCount - 1 }, (_, i) => note(`extra-${i}`, 500 + (i % 40) * 280, 200 + Math.floor(i / 40) * 140, `Card ${i}: ordinary canvas content.`))];
      const page = await seed(context, nodes);
      await page.locator('.node[data-id="a"]').dblclick();
      await settleReveal(page);
      await page.evaluate(() => {
        window.typingStep = 0;
        const editor = document.querySelector(".node.editing .node-editor");
        window.typingEditor = editor;
        window.typingTimer = setInterval(() => {
          setNoteText(editor, `Continuous input ${++window.typingStep}`);
          setNoteSelection(editor, noteText(editor).length, noteText(editor).length);
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
      assert.deepEqual(await page.evaluate(() => [noteSelection(window.typingEditor).start, noteSelection(window.typingEditor).end]), [19, 19]);
      await page.locator(".node.editing .node-editor").press("Control+Enter");
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
      await page.locator(".node.editing .node-editor").fill(`Waiting ${i}`);
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
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith("scattered-pending"))), false);
    // Switching canvases awaits the same flush; no old deadline may write into the new canvas.
    await page.locator(".node.editing .node-editor").fill("Before switching");
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
  await check("IME sizing: same-line composition keeps the active editor height stable and still saves", async context => {
    const page = await seed(context, [note("a", 100, 200, "ABC")]);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    const result = await page.locator(".node.editing .node-editor").evaluate(async editor => {
      const beforeHeight = editor.style.height;
      const writes = [];
      const observer = new MutationObserver(records => writes.push(...records.map(r => r.oldValue)));
      observer.observe(editor, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
      window.compositionEditor = editor;
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      for (const text of ["w", "wo", "wod", "wode"]) {
        setNoteText(editor, text);
        setNoteSelection(editor, text.length, text.length);
        const dom = new MutationObserver(() => {});
        dom.observe(editor, { childList: true, characterData: true, subtree: true });
        editor.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
        await new Promise(resolve => setTimeout(resolve, 80));
        if (dom.takeRecords().length) throw new Error("Input handlers must not normalize the live composition DOM");
        dom.disconnect();
      }
      observer.disconnect();
      return { beforeHeight, height: editor.style.height, writes, focused: document.activeElement === editor, selection: [noteSelection(editor).start, noteSelection(editor).end] };
    });
    assert.deepEqual(result.writes, [], "Same-line preedit must not collapse or rewrite the active editor height");
    assert.equal(result.height, result.beforeHeight);
    assert.equal(result.focused, true);
    assert.deepEqual(result.selection, [4, 4]);
    await page.waitForTimeout(1100);
    assert.equal((await stored(page))[0].nodes[0].text, "wode", "Composition must retain the existing autosave path");
    await page.evaluate(() => {
      const editor = window.compositionEditor;
      setNoteText(editor, "我的");
      editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "我的" }));
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    assert.equal(await page.evaluate(() => document.activeElement === window.compositionEditor), true);
    await page.locator(".node.editing .node-editor").press("Control+Enter");
    await page.waitForTimeout(300);
    assert.equal((await stored(page))[0].nodes[0].text, "我的");
    assert.equal(await page.locator("[contenteditable].node-editor").count(), 1, "Only the real editing host may remain in the DOM");
  });

  await check("IME sizing: wrapped composition grows and shrinks like ordinary input without collapsing the editor", async context => {
    const page = await seed(context);
    await page.locator('.node[data-id="a"]').dblclick();
    await settleReveal(page);
    const results = await page.locator(".node.editing .node-editor").evaluate(editor => {
      const results = [];
      for (const width of [160, 218, 520]) {
        editor.closest(".node").style.width = `${width}px`;
        for (const text of ["中文输入换行测试".repeat(24), "第一行\n第二行\n", "averylongunbrokenword".repeat(8), "短", ""]) {
          const observer = new MutationObserver(() => {});
          observer.observe(editor, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
          editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          setNoteText(editor, text);
          setNoteSelection(editor, text.length, text.length);
          // The lifecycle alone must work even when an engine omits isComposing.
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }));
          const composingHeight = editor.offsetHeight;
          const clipped = editor.scrollHeight > editor.clientHeight + 1;
          const styles = [...observer.takeRecords().map(r => r.oldValue), editor.getAttribute("style")];
          observer.disconnect();
          const selection = [noteSelection(editor).start, noteSelection(editor).end];
          editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
          results.push({ width, length: text.length, composingHeight, ordinaryHeight: editor.offsetHeight, clipped, styles, selection, focused: document.activeElement === editor });
        }
      }
      return results;
    });
    for (const result of results) {
      const label = `${result.width}px wide, ${result.length} characters`;
      // scrollHeight is integer-rounded; Chromium can round the offscreen and
      // transformed on-canvas controls one pixel apart. Neither may clip text.
      assert.ok(Math.abs(result.composingHeight - result.ordinaryHeight) <= 1, label);
      assert.equal(result.clipped, false, label);
      assert.ok(result.styles.every(style => !/(?:^|;)\s*height:\s*0(?:px)?\s*(?:;|$)/.test(style || "")), label);
      assert.deepEqual(result.selection, [result.length, result.length], label);
      assert.equal(result.focused, true, label);
    }
    assert.equal(await page.locator("[contenteditable].node-editor").count(), 1);
    // Cancelling preedit back to the original value, then blurring, still commits
    // that value. Ordinary English typing after a new edit keeps working too.
    await page.locator(".node.editing .node-editor").evaluate(editor => {
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setNoteText(editor, "a");
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
      editor.blur();
    });
    await page.waitForTimeout(300);
    assert.equal((await stored(page))[0].nodes[0].text, "a");
    await edit(page, "English after composition");
    assert.equal((await stored(page))[0].nodes[0].text, "English after composition");
  });

  for (const kind of ["card", "title", "edge", "search"]) {
    await check(`IME: ${kind} ignores composing shortcuts but keeps ordinary commands`, async context => {
      const page = await seed(context, [note("a", 100, 200, "match one"), note("b", 500, 350, "match two")], [{ id: "ab", from: "a", to: "b", label: "Old label" }]);
      let input;
      if (kind === "card") {
        await page.mouse.dblclick(900, 600);
        input = page.locator(".node.editing .node-editor");
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
        await page.locator(".node.editing .node-editor").fill("中文正文");
        await page.locator(".node.editing .node-editor").press("Control+Enter");
      } else if (kind === "search") {
        await input.press("Enter");
        assert.notEqual(await page.locator("#search-count").textContent(), beforeSearch);
        await input.press("Escape");
      } else {
        await input.fill(kind === "title" ? "中文标题" : "中文连线");
        await input.press("Enter");
      }
      assert.equal(await page.locator(kind === "card" ? ".node.editing .node-editor" : kind === "title" ? "#board-title-editor" : kind === "edge" ? "#edge-label-editor" : "#search-input").isVisible(), false);
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
      const w = await import("./workspace.js?v=89");
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
    await page.locator(".node.editing .node-editor").fill("Lifecycle latest edit");
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
        if (this === localStorage && key.startsWith("scattered-pending")) throw new DOMException("Full", "QuotaExceededError");
        return nativeSet.call(this, key, value);
      };
    });
    await page.evaluate(async () => {
      const w = await import("./workspace.js?v=89");
      const { board } = w.loadWorkspace(localStorage);
      for (let i = 1; i <= 3; i++) w.captureRecovery(localStorage, `old-${i}`, board, "delete", () => i);
    });
    await page.locator(".node.editing .node-editor").fill("Committed even when the journal cannot fit");
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
    await page.locator('.node[data-id="a"] .node-editor').fill("Storage available again");
    await page.locator('.node[data-id="a"] .node-editor').press("Control+Enter");
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
      const w = await import("./workspace.js?v=89");
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
    await page.locator(".node.editing .node-editor").fill("Saved at the real capacity limit");
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
    const editor = page.locator(".node.editing .node-editor");
    await editor.evaluate(e => {
      setNoteText(e, "新" + noteText(e));
      setNoteSelection(e, 1, 1);
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
    await editor.evaluate(e => setNoteSelection(e, 0, 0));
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
    const editor = page.locator(".node.editing .node-editor");
    await editor.evaluate(e => setNoteSelection(e, 0, 0));
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
    const result = await page.locator(".node.editing .node-editor").evaluate(async e => {
      const world = document.querySelector("#world");
      const read = () => ({ t: performance.now(), y: new DOMMatrix(getComputedStyle(world).transform).m42 });
      const samples = [read()];
      setNoteSelection(e, 0, 0);
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 60));
        samples.push(read());
        // Replace the destination mid-flight, as native keyboard trackpad
        // updates do. This must not build a queue of stale destinations.
        if (i === 2) setNoteSelection(e, 100, 100);
      }
      const beforeReverse = read();
      setNoteSelection(e, noteText(e).length, noteText(e).length);
      await new Promise(r => setTimeout(r, 100));
      const reversed = read();
      // A new touch inside the editor cancels following at the displayed view,
      // without jumping to the previously requested distant destination.
      e.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 91 }));
      const cancelled = read();
      await new Promise(r => setTimeout(r, 100));
      return { samples, beforeReverse, reversed, cancelled, settled: read(), start: noteSelection(e).start, end: noteSelection(e).end, length: noteText(e).length };
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
    const sample = await page.locator(".node.editing .node-editor").evaluate(async editor => {
      const world = document.querySelector("#world");
      const startY = new DOMMatrix(getComputedStyle(world).transform).m42;
      const caret = noteText(editor).split("\n").slice(0, 134).join("\n").length + 1;
      setNoteSelection(editor, caret, caret);
      // Document selectionchange is queued separately from rendering. Wait for
      // its bounded delivery instead of assuming textarea's two-frame timing.
      for (let i = 0; i < 15 && !document.querySelector("#viewport").classList.contains("following-caret"); i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
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
      return { following, stillFollowing, distance: targetY - startY, fraction: (currentY - startY) / (targetY - startY), caret, actualCaret: noteSelection(editor).start };
    });
    assert.equal(sample.following, true, JSON.stringify(sample));
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
    const editor = page.locator(".node.editing .node-editor");
    const word = text.indexOf("Some", 1);
    // The second "Some" wraps as a whole. Truncating its suffix during caret
    // measurement incorrectly places its first three letters on the prior line.
    await editor.evaluate((e, caret) => setNoteSelection(e, caret, caret), word + 3);
    await settleReveal(page);
    const before = await page.locator("#world").evaluate(w => new DOMMatrix(w.style.transform).m42);
    await editor.evaluate((e, caret) => setNoteSelection(e, caret, caret), word + 1);
    await page.waitForTimeout(350);
    const after = await page.locator("#world").evaluate(w => new DOMMatrix(w.style.transform).m42);
    assert.ok(Math.abs(after - before) < 0.5, `Same wrapped line must not move the camera: ${before} -> ${after}`);
    assert.equal(await editor.evaluate(e => noteText(e)), text);
    assert.equal(await editor.evaluate(e => noteSelection(e).start), word + 1);
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
      const editor = page.locator(".node.editing .node-editor");
      await editor.press("Meta+ArrowDown");
      await editor.press("End");
      await settleReveal(page);
      assert.deepEqual(await scroll(page), [0, 0]);
      let rect = await editor.boundingBox();
      const endState = await editor.evaluate(e => ({ selection: noteSelection(e), length: noteText(e).length, scroll: [e.scrollLeft, e.scrollTop], world: document.querySelector("#world").getAttribute("style"), documentScroll: [scrollX, scrollY], lineHeight: getComputedStyle(e).lineHeight }));
      assert.ok(rect.y + rect.height < size.height && rect.y + rect.height > 40, `End caret is in view: ${JSON.stringify({ rect, endState })}`);
      await editor.press("Meta+ArrowUp");
      assert.equal(await editor.evaluate(e => noteSelection(e).start), 0, "Home shortcut moves the actual caret");
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
    const editor = page.locator(".node.editing .node-editor");
    await settleReveal(page);
    assert.ok((await editor.boundingBox()).y < -100, "Fixture starts with the beginning off screen");
    await editor.evaluate(e => {
      // Native collapsed-caret movement can emit selectionchange alone. Do not
      // let the extra select event from the script API mask the missing handler.
      e.addEventListener("select", event => event.stopImmediatePropagation(), true);
      setNoteSelection(e, 0, 0);
    });
    await settleReveal(page);
    const rect = await editor.boundingBox();
    assert.ok(rect.y >= 0 && rect.y < 460, `Changed caret is visible: ${JSON.stringify(rect)}`);
    assert.equal(await editor.evaluate(e => noteSelection(e).start), 0, "Camera movement does not rewrite the caret");
    // Follow multiple incremental movements as well, including backward selection.
    for (const line of [15, 30, 45, 30, 15, 0]) {
      const caret = await editor.evaluate((e, line) => {
        const start = noteText(e).split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
        setNoteSelection(e, start, start + 4, "backward");
        return start;
      }, line);
      await settleReveal(page);
      const position = await editor.evaluate((e, line) => ({
        y: e.getBoundingClientRect().y + line * parseFloat(getComputedStyle(e).lineHeight),
        start: noteSelection(e).start, end: noteSelection(e).end, direction: noteSelection(e).direction,
      }), line);
      assert.ok(position.y >= 40 && position.y < 460, JSON.stringify(position));
      assert.deepEqual([position.start, position.end, position.direction], [caret, caret + 4, "backward"]);
    }
    // Older WebKit can notify on document instead of on the editing host.
    await editor.evaluate(e => {
      e.addEventListener("selectionchange", event => event.stopImmediatePropagation(), true);
      setNoteSelection(e, noteText(e).length, noteText(e).length);
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
    assert.equal(await b.locator(".node.editing .node-editor").evaluate(e => noteText(e)), "a", "Do not replace an open editor");
    await b.locator(".node.editing .node-editor").fill("Local edit");
    await b.locator(".node.editing .node-editor").press("Control+Enter");
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
