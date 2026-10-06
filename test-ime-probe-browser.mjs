import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// Verifies the diagnostic controls and isolation, not native IME latency.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs BROWSER=webkit node test-ime-probe-browser.mjs
const html = await readFile(new URL("./diagnostics/ime-input.html", import.meta.url), "utf8");
assert.doesNotMatch(html, /<script\b|<form\b|<iframe\b|\bon\w+\s*=/i);
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  response.writeHead(request.url === "/diagnostics/ime-input.html" ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
  response.end(request.url === "/diagnostics/ime-input.html" ? html : "");
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
    } finally { await context.close(); }
  }
  assert.ok(requests.every(request => request.method === "GET" && ["/diagnostics/ime-input.html", "/favicon.ico"].includes(request.path)));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
