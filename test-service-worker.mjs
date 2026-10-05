import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
const origin = "https://preview.example";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("every cached page has its local script and stylesheet entry points precached", async () => {
  const assets = JSON.parse(source.match(/const ASSETS = (\[[^\n]+\]);/)[1]);
  for (const file of assets.filter(asset => asset.endsWith(".html"))) {
    const html = await readFile(new URL(file, import.meta.url), "utf8");
    for (const [, entry] of html.matchAll(/(?:src|href)="([^\"]+\.(?:css|js)(?:\?[^\"]*)?)"/g)) {
      if (entry.startsWith("https:")) continue;
      assert.ok(assets.includes(`./${entry}`), `${file} requires offline ${entry}`);
    }
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function worker({ cached = "cached shell", online = true, failCacheWrite = false } = {}) {
  const listeners = {}, timers = new Map(), writes = [];
  const network = deferred();
  let nextTimer = 0;
  const cache = {
    match: async () => cached === null ? undefined : new Response(cached),
    put: async (request, response) => {
      if (failCacheWrite) throw new Error("quota");
      writes.push(await response.text());
    },
  };
  runInNewContext(source, {
    self: { location: { origin }, navigator: { onLine: online }, addEventListener: (name, listener) => { listeners[name] = listener; } },
    caches: { open: async () => cache, match: cache.match },
    fetch: () => network.promise,
    URL,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  function request(url = `${origin}/`, method = "GET") {
    let response;
    const lifetime = [];
    listeners.fetch({
      request: new Request(url, { method }),
      respondWith: value => { response = Promise.resolve(value); },
      waitUntil: value => lifetime.push(value),
    });
    return { get response() { return response; }, lifetime };
  }
  return { request, network, timers, writes };
}

test("cached pages do not wait indefinitely for a network that never rejects", async () => {
  const w = worker(), event = w.request();
  await tick();
  assert.equal(w.timers.size, 1, "A cached request must have a fallback deadline");
  const timer = [...w.timers.values()][0];
  assert.ok(timer.delay > 0 && timer.delay <= 1000);
  timer.callback();
  assert.equal(await (await event.response).text(), "cached shell");
  assert.equal(w.timers.size, 0);
  w.network.resolve(new Response("fresh shell"));
  await Promise.all(event.lifetime);
  assert.deepEqual(w.writes, ["fresh shell"], "Late success still refreshes the cache");
});

test("known offline uses the cache immediately without a timeout", async () => {
  const w = worker({ online: false }), event = w.request();
  let response;
  event.response.then(value => { response = value; });
  await tick();
  assert.ok(response, "Offline cache should not depend on fetch settling");
  assert.equal(await response.text(), "cached shell");
  assert.equal(w.timers.size, 0);
  w.network.reject(new Error("offline"));
  await Promise.all(event.lifetime);
});

test("fast successful network responses win and are cached", async () => {
  const w = worker(), event = w.request();
  w.network.resolve(new Response("fresh shell"));
  assert.equal(await (await event.response).text(), "fresh shell");
  await Promise.all(event.lifetime);
  assert.deepEqual(w.writes, ["fresh shell"]);
  assert.equal(w.timers.size, 0);
});

test("HTTP failures and fetch rejection preserve an available offline shell", async () => {
  for (const status of [404, 503, null]) {
    const w = worker(), event = w.request();
    if (status) w.network.resolve(new Response("unavailable", { status }));
    else w.network.reject(new Error("offline"));
    assert.equal(await (await event.response).text(), "cached shell");
    await Promise.all(event.lifetime);
    assert.deepEqual(w.writes, []);
  }
});

test("an uncached request keeps waiting for its actual network response", async () => {
  const w = worker({ cached: null }), event = w.request();
  await tick();
  assert.equal(w.timers.size, 0, "No timeout when there is no usable fallback");
  w.network.resolve(new Response("first visit"));
  assert.equal(await (await event.response).text(), "first visit");
  await Promise.all(event.lifetime);
});

test("cache-write failure does not discard a successful network response", async () => {
  const w = worker({ failCacheWrite: true }), event = w.request();
  w.network.resolve(new Response("fresh shell"));
  assert.equal(await (await event.response).text(), "fresh shell");
  await Promise.all(event.lifetime);
});

test("cross-origin and non-GET requests are not intercepted", () => {
  const w = worker();
  assert.equal(w.request("https://broker.example/token").response, undefined);
  assert.equal(w.request(`${origin}/`, "POST").response, undefined);
});
