import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// Verifies the diagnostic controls and isolation, not native IME latency.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BROWSER=webkit node test-ime-probe-browser.mjs
const html = await readFile(new URL("./diagnostics/ime-input.html", import.meta.url), "utf8");
const p2Html = await readFile(new URL("./diagnostics/ime-input-p2.html", import.meta.url), "utf8");
const documents = new Map([["/diagnostics/ime-input.html", html], ["/diagnostics/ime-input-p2.html", p2Html]]);
for (const document of documents.values()) assert.doesNotMatch(document, /<script\b|<form\b|<iframe\b|\bon\w+\s*=/i);
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  response.writeHead(documents.has(request.url) ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
  response.end(documents.get(request.url) || "");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const engines = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.BROWSER || "chromium";
let browser;
try {
  browser = await engines[engine].launch({ headless: true, ...(engine === "chromium" ? { channel: "chrome" } : {}) });
  for (const width of [744, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 997 }, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const errors = [], external = [];
      page.on("pageerror", error => errors.push(String(error)));
      await page.route("**/*", route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      await page.goto(`${origin}/diagnostics/ime-input.html`);
      await page.evaluate(() => localStorage.setItem("scattered-probe-sentinel", "unchanged"));
      assert.equal(await page.locator("script, form, iframe").count(), 0);
      assert.equal(await page.locator("input, textarea").count(), 4);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const controls = await page.locator("input, textarea").evaluateAll(fields => fields.map(field => ({
        tag: field.tagName,
        spellcheck: field.spellcheck,
        label: field.labels[0]?.textContent.trim(),
        metrics: ["width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"].map(name => getComputedStyle(field)[name]),
        transform: getComputedStyle(field.closest(".world")).transform,
        rectWidth: field.getBoundingClientRect().width,
      })));
      assert.deepEqual(controls.map(c => c.tag), ["INPUT", "TEXTAREA", "TEXTAREA", "TEXTAREA"]);
      assert.deepEqual(controls.map(c => c.spellcheck), [false, false, true, true]);
      assert.ok(controls.every(c => c.label && JSON.stringify(c.metrics) === JSON.stringify(controls[0].metrics)));
      assert.ok(controls.slice(0, 3).every(c => c.transform === "none"));
      assert.notEqual(controls[3].transform, "none");
      assert.ok(Math.abs(controls[3].rectWidth / controls[2].rectWidth - 0.9) < 0.001);
      for (const id of ["a", "b", "c", "d"]) {
        const field = page.locator(`#input-${id}`);
        await field.scrollIntoViewIfNeeded();
        await field.click();
        await field.pressSequentially("wodeshuruyoudianyanchi");
        assert.equal(await field.inputValue(), "wodeshuruyoudianyanchi");
        assert.equal(await field.evaluate(element => document.activeElement === element), true);
      }
      assert.deepEqual(await page.evaluate(() => Object.entries(localStorage)), [["scattered-probe-sentinel", "unchanged"]]);
      assert.deepEqual(await page.evaluate(() => Object.entries(sessionStorage)), []);
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine} ${width}px: four matched controls, spelling/transform variants, typing, labels, no overflow, no app storage writes or external requests`);

      await page.goto(`${origin}/diagnostics/ime-input-p2.html`);
      assert.equal(await page.title(), "Scattered · IME comparison P2");
      assert.equal(await page.locator("script, form, iframe").count(), 0);
      assert.equal(await page.getByRole("textbox").count(), 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const baseline = await page.locator("#input-a").evaluate(field => ["width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"].map(name => getComputedStyle(field)[name]));
      assert.deepEqual(baseline, controls[0].metrics);
      assert.equal(await page.locator("#input-e").evaluate(field => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).some(rule => rule.selectorText && field.matches(rule.selectorText))), false);
      for (const id of ["e", "f"]) {
        assert.equal(await page.locator(`#input-${id}`).evaluate(field => {
          for (let element = field; element; element = element.parentElement) {
            const style = getComputedStyle(element);
            if (style.transform !== "none" || style.position !== "static" || style.willChange !== "auto" || style.userSelect === "none" || style.webkitUserSelect === "none") return false;
          }
          return true;
        }), true);
      }
      const nativeMetrics = field => ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "whiteSpace", "overflowWrap", "padding", "borderWidth", "width", "height"].map(name => getComputedStyle(field)[name]);
      const reference = await context.newPage();
      try {
        await reference.setContent('<!doctype html><html lang="zh-Hans"><meta name="viewport" content="width=device-width, initial-scale=1"><textarea rows="3" cols="24" maxlength="120" spellcheck="false" autocomplete="off"></textarea></html>');
        assert.deepEqual(await page.locator("#input-e").evaluate(nativeMetrics), await reference.locator("textarea").evaluate(nativeMetrics));
      } finally { await reference.close(); }
      const editable = page.locator("#input-f");
      assert.equal(await editable.evaluate(field => field.isContentEditable && field.contentEditable === "plaintext-only" && !field.spellcheck), true);
      assert.match(await page.getByRole("textbox", { name: /F ·/ }).getAttribute("aria-multiline"), /^true$/);
      for (const id of ["a", "e", "f"]) {
        const field = page.locator(`#input-${id}`);
        await field.scrollIntoViewIfNeeded();
        await field.click();
        await field.pressSequentially("wodeshuruyoudianyanchi");
        assert.equal(await field.evaluate(element => element.value ?? element.innerText), "wodeshuruyoudianyanchi");
        assert.equal(await field.evaluate(element => document.activeElement === element), true);
        if (id !== "a") {
          await field.press("Enter");
          await page.keyboard.insertText("第二行");
          assert.equal(await field.evaluate(element => element.value ?? element.innerText), "wodeshuruyoudianyanchi\n第二行");
        }
      }
      assert.deepEqual(await page.evaluate(() => Object.entries(localStorage)), [["scattered-probe-sentinel", "unchanged"]]);
      assert.deepEqual(await page.evaluate(() => Object.entries(sessionStorage)), []);
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine} ${width}px P2: original A preserved, E matches unstyled browser defaults, F editable, multiline typing, isolation`);
    } finally { await context.close(); }
  }
  assert.ok(requests.every(request => request.method === "GET" && (documents.has(request.path) || request.path === "/favicon.ico")));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
