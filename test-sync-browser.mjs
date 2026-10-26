import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { blankBoard } from "./model.js";
import { indexSyncWorkspace } from "./sync-model.js";

// Real app/controller/storage in isolated browser profiles; only Drive responses and scheduling are controlled.
const engines = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.BROWSER || "chromium";
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[a-z0-9-]+\.(html|js|css|svg|png|webmanifest)$/.test(name)) return response.writeHead(404).end();
  try {
    let body = await readFile(new URL(name, import.meta.url));
    if (name === "sync-config.js") body = 'export const DRIVE_SYNC_API = "https://broker.invalid";';
    if (name === "index.html") body = body.toString().replace(/<!-- Cloudflare Web Analytics -->[\s\S]*?<!-- End Cloudflare Web Analytics -->/, "");
    if (name === "app.js") body += `
      driveSync.stop();
      driveSync.schedule = () => {};
      const showTestToast = showToast;
      window.syncNotices = [];
      showToast = (...args) => {
        if (args[0] === t("driveConflict")) window.syncNotices.push(workspace.activeId);
        return showTestToast(...args);
      };
      window.syncTest = {
        sync: async () => { try { return await driveSync.syncNow(); } finally { driveSync.stop(); } },
        flush: saveBoardNow,
        snapshot: () => createSyncWorkspace(workspaceStorage, workspace),
        ready: () => !boardDirty && !workspaceActionPending,
        addOther: async () => {
          const previous = workspace.activeId;
          await withWorkspaceLock(s => {
            const other = createDocument(s, workspace);
            saveDocument(s, workspace, { ...other, title: "乙", nodes: [{ id: "note", text: "乙正文", x: 180, y: 220, width: 218, color: "plain" }] });
            switchDocument(s, workspace, previous);
          }, workspaceStorage);
          renderBoardList();
        },
      };`;
    response.writeHead(200, { "Content-Type": { js: "text/javascript", html: "text/html", css: "text/css", svg: "image/svg+xml" }[name.split(".").pop()] || "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://localhost:${server.address().port}`;
const browser = await engines[engine].launch({ headless: true, ...(engine === "chromium" ? { channel: "chrome" } : {}) });
const failures = [], pageErrors = [];
const snapshot = page => page.evaluate(() => syncTest.snapshot());
const sync = async (page, expected = true) => {
  const value = await page.evaluate(async () => { await syncTest.flush(); return syncTest.sync(); });
  assert.equal(value, expected, await page.locator("#toast").textContent());
};
const notices = page => page.evaluate(() => syncNotices.length);
const hash = async (state, id) => (await indexSyncWorkspace(state)).find(item => item.id === id).hash;
const current = state => state.boards.find(item => item.id === state.activeId);

async function write(page, text, finish = true) {
  if (!await page.locator(".node.editing").count()) await page.locator('.node[data-id="note"]').dblclick();
  const editor = page.locator(".node.editing .node-editor");
  await editor.fill(text);
  await page.evaluate(() => syncTest.flush());
  if (finish) { await editor.press("Control+Enter"); await page.evaluate(() => syncTest.flush()); }
}

async function rename(page, title) {
  await page.locator("#board-title").dblclick();
  await page.locator("#board-title-editor").fill(title);
  await page.locator("#board-title-editor").press("Enter");
  await page.evaluate(() => syncTest.flush());
}

async function selectCanvas(page, title) {
  await page.locator("#boards-button").click();
  await page.locator(".board-list-option").filter({ hasText: new RegExp(`^${title}$`) }).click();
  await page.waitForFunction(title => document.querySelector("#board-title").textContent === title, title);
}
const selectOther = page => selectCanvas(page, "乙");

async function fixture(locale = "en-US") {
  const contexts = [], files = new Map(), versions = new Map();
  const lab = { serial: 0, failUpload: false, holdListing: null, contexts };
  const makePage = async (id, seeded) => {
    const context = await browser.newContext({ locale, viewport: { width: 1024, height: 768 }, serviceWorkers: "block" });
    contexts.push(context);
    await context.route("https://**/*", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const json = value => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
      if (path === "/token") return json({ accessToken: "synthetic-only", expiresIn: 3600 });
      if (path === "/drive/v3/about") return json({ user: { permissionId: "synthetic-account" } });
      if (path === "/drive/v3/files") {
        if (id === "home" && lab.holdListing) { const hold = lab.holdListing; lab.holdListing = null; hold.reached(); await hold.gate; }
        return json({ files: [...files].map(([fileId, state]) => ({ id: fileId, version: versions.get(fileId), appProperties: { deviceId: state.deviceId } })) });
      }
      if (path.startsWith("/drive/v3/files/")) return json(files.get(path.split("/").at(-1)));
      if (path.startsWith("/upload/drive/v3/files")) {
        const fileId = path.split("/")[5] || `file-${++lab.serial}`;
        return route.fulfill({ status: 200, headers: { Location: `https://upload.invalid/session/${fileId}`, "Access-Control-Expose-Headers": "Location" }, body: "" });
      }
      if (path.startsWith("/session/")) {
        if (id === "home" && lab.failUpload) { lab.failUpload = false; return route.fulfill({ status: 503, body: "simulated upload failure" }); }
        const fileId = path.split("/").at(-1);
        files.set(fileId, JSON.parse(request.postData()));
        versions.set(fileId, String(Number(versions.get(fileId) || 0) + 1));
        return json({ id: fileId });
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(String(error)));
    await page.goto(`${origin}/about.html`);
    await page.evaluate(({ id, seeded, board }) => {
      localStorage.setItem("scattered-drive-session-v1", "v1.c2VhbGVk");
      localStorage.setItem("scattered-drive-device-v1", id);
      if (seeded) localStorage.setItem("scattered-board-v1", JSON.stringify(board));
    }, { id, seeded, board: { ...blankBoard(), title: "甲", nodes: [{ id: "note", text: "原稿", x: 180, y: 220, width: 218, color: "plain" }] } });
    await page.goto(origin);
    await page.waitForFunction(() => window.syncTest?.ready());
    return page;
  };
  lab.office = await makePage("office", true);
  await lab.office.evaluate(() => syncTest.addOther());
  await sync(lab.office);
  lab.home = await makePage("home", false);
  await sync(lab.home); await sync(lab.office);
  return lab;
}

async function check(name, run, locale) {
  if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
  const lab = await fixture(locale);
  try { await run(lab); console.log(`PASS ${engine}: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${engine}: ${name}\n${error.stack}`); }
  finally { for (const context of lab.contexts) await context.close(); }
}

try {
  for (const scenario of ["single", "six", "office-rename", "home-rename", "delete-original", "switch-during-sync", "upload-failure", "save-failure"]) {
    await check(`follow: ${scenario}`, async lab => {
      const { home, office } = lab;
      if (scenario === "home-rename") {
        await write(home, "改名之前的输入", false);
        await rename(home, "甲新");
      }
      const base = await snapshot(home), originalId = base.activeId;
      const drafts = Array.from({ length: scenario === "six" ? 6 : 1 }, (_, n) => `家里第 ${n + 1} 稿 结束123`);
      const minimum = (await Promise.all(drafts.map(text => {
        const draft = structuredClone(base); current(draft).board.nodes[0].text = text; return hash(draft, originalId);
      }))).sort()[0];
      if (scenario === "office-rename") await rename(office, "办公室改名");
      const officeState = await snapshot(office);
      let officeText;
      for (let n = 0; n < 10000; n++) {
        current(officeState).board.nodes[0].text = `办公室正文 ${n}`;
        if (await hash(officeState, originalId) < minimum) { officeText = current(officeState).board.nodes[0].text; break; }
      }
      assert.ok(officeText);
      await write(office, officeText);
      if (scenario === "delete-original") {
        await office.locator("#boards-button").click();
        await office.locator("#delete-board-button").click();
        await office.locator("#delete-board-button").click();
        await office.waitForFunction(() => syncTest.ready() && document.querySelector("#board-title").textContent === "乙");
      }
      await sync(office);
      let copyId;
      for (const text of drafts) {
        await write(home, text, false);
        await sync(home, false);
        assert.equal(await home.locator(".node.editing").count(), 1, "The controller must not replace an active editor");
        assert.equal(await notices(home), 0);
        await sync(office);
        const copies = (await snapshot(office)).boards.filter(item => item.id.startsWith("sync-"));
        assert.equal(copies.length, 1);
        copyId ||= copies[0].id;
        assert.equal(copies[0].id, copyId);
        assert.equal(copies[0].board.nodes[0].text, text);
      }
      await home.locator(".node-editor").press("Control+Enter");
      await home.evaluate(() => syncTest.flush());
      if (scenario === "switch-during-sync") {
        let reached, release;
        const arrived = new Promise(resolve => { reached = resolve; });
        lab.holdListing = { reached, gate: new Promise(resolve => { release = resolve; }) };
        const applying = sync(home);
        await arrived;
        try { await selectOther(home); } finally { release(); }
        await applying;
      } else {
        if (scenario === "upload-failure") lab.failUpload = true;
        if (scenario === "save-failure") {
          await home.evaluate(() => {
            window.failCopyWrite = true;
            const native = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) {
              if (this === localStorage && window.failCopyWrite && key.includes("scattered-document-v2:sync-")) throw new DOMException("Full", "QuotaExceededError");
              return native.call(this, key, value);
            };
          });
          await sync(home, false);
          assert.equal(await notices(home), 0, "A failed local save cannot claim the copy was saved");
          assert.equal((await snapshot(home)).activeId, originalId);
          assert.equal(await home.locator('.node[data-id="note"] .node-text').textContent(), drafts.at(-1));
          await home.evaluate(() => { window.failCopyWrite = false; });
        }
        await sync(home, scenario !== "upload-failure");
      }
      const result = await snapshot(home), active = current(result);
      assert.equal(result.boards.find(item => item.id === copyId).board.nodes[0].text, drafts.at(-1));
      if (scenario === "delete-original") assert.ok(!result.boards.some(item => item.id === originalId));
      else assert.equal(result.boards.find(item => item.id === originalId).board.nodes[0].text, officeText);
      assert.equal(active.id, scenario === "switch-during-sync" ? result.boards.find(item => item.board.title === "乙").id : copyId);
      assert.equal(await home.locator("#board-title").textContent(), active.board.title);
      if (scenario === "home-rename") assert.equal(active.board.title, "甲新");
      assert.equal(await home.locator(".node-text").first().textContent(), active.board.nodes[0].text);
      assert.equal(await notices(home), 1);
      assert.equal(await home.locator("#toast").isVisible(), true);
      assert.match(await home.locator("#toast").textContent(), /冲突副本已保留.*Conflict copy saved/);
      if (scenario === "upload-failure") assert.equal(await home.locator("#drive-sync-button").getAttribute("data-status"), "error");
      for (let n = 0; n < 2; n++) { await sync(home); await sync(office); }
      assert.equal((await snapshot(home)).boards.length, scenario === "delete-original" ? 2 : 3);
      assert.equal(await notices(home), 1, "Retries do not repeat the notification");
      await selectOther(home);
      await home.reload(); await home.waitForFunction(() => window.syncTest?.ready());
      await sync(home);
      assert.equal(await home.locator("#board-title").textContent(), "乙", "Reload must not jump back to an already received copy");
      assert.equal(await notices(home), 0);
    }, scenario === "six" ? "zh-CN" : "en-US");
  }

  for (const bothConflict of [false, true]) await check(`follow: same text, ${bothConflict ? "both canvases" : "only beta"} conflict`, async ({ home, office }) => {
    await write(home, "同模板正文");
    if (!bothConflict) { await sync(home); await sync(office); }
    await selectOther(home); await write(home, "同模板正文");
    const local = await snapshot(home), localIndex = await indexSyncWorkspace(local);
    const alphaId = local.boards.find(item => item.board.title === "甲").id;
    for (const title of ["甲", "乙"]) {
      const id = local.boards.find(item => item.board.title === title).id;
      await selectCanvas(office, title);
      const candidate = await snapshot(office);
      let text;
      for (let n = 0; n < 10000; n++) {
        current(candidate).board.nodes[0].text = `${title}远端 ${n}`;
        if (await hash(candidate, id) < localIndex.find(item => item.id === id).hash) { text = current(candidate).board.nodes[0].text; break; }
      }
      assert.ok(text);
      await write(office, text);
    }
    await sync(office);
    await selectCanvas(home, "甲"); await sync(home);
    const result = await snapshot(home);
    const copies = result.boards.filter(item => item.id.startsWith("sync-"));
    assert.equal(copies.length, bothConflict ? 2 : 1);
    assert.ok(copies.every(item => item.board.nodes[0].text === "同模板正文"));
    assert.equal(current(result).board.title, bothConflict ? "甲 · 2" : "甲");
    assert.equal(result.activeId === alphaId, !bothConflict);
    assert.equal(await home.locator("#board-title").textContent(), current(result).board.title);
    assert.equal(await notices(home), 1, "Several copies from one apply are announced together");
  });

  await check("follow: only remote changes never move the local selection or notify", async ({ home, office }) => {
    const id = (await snapshot(home)).activeId;
    await write(office, "仅办公室改动"); await sync(office); await sync(home);
    assert.equal((await snapshot(home)).activeId, id);
    assert.equal(await home.locator(".node-text").first().textContent(), "仅办公室改动");
    assert.equal(await notices(home), 0);
  });

  await check("follow: a local winner stays and the peer follows its own losing version", async ({ home, office }) => {
    const base = await snapshot(home), id = base.activeId;
    const candidate = structuredClone(base); current(candidate).board.nodes[0].text = "家里的版本";
    const targetHash = await hash(candidate, id);
    let text;
    for (let n = 0; n < 10000; n++) {
      current(base).board.nodes[0].text = `办公室落败版本 ${n}`;
      if (await hash(base, id) > targetHash) { text = current(base).board.nodes[0].text; break; }
    }
    assert.ok(text);
    await write(home, "家里的版本"); await sync(home);
    await write(office, text); await sync(office); await sync(home);
    assert.equal((await snapshot(home)).activeId, id);
    assert.equal(await home.locator(".node-text").first().textContent(), "家里的版本");
    assert.notEqual((await snapshot(office)).activeId, id);
    assert.equal(await office.locator(".node-text").first().textContent(), text);
    assert.equal(await notices(office), 1);
  });
  assert.deepEqual(pageErrors, [], "No unhandled errors in the real pages");
  assert.deepEqual(failures, [], "All sync browser scenarios must pass");
} finally { await browser.close(); server.close(); }
