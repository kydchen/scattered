# Live read-only presentation links

Export → Live read-only link → Enable sharing → Copy link. The same URL follows edits from the publishing browser. Viewers need no account, and cannot edit the source or import it into their own local workspace by opening the link.

## Boundaries

- Only opted-in canvases are uploaded. Google sync is independent, and the GitHub Pages edition does not gain Google sign-in. Its live-link feature explicitly opts into cloud storage.
- The author sends saved content with an 800 ms debounce. The viewer conditionally polls every 3 seconds while visible. No WebSocket, collaboration protocol, or camera synchronization is involved.
- Management capabilities are scoped to the current local/account workspace and stored only in the publishing browser. A random read ID is the only value in the URL fragment. Write credentials never enter links, JSON/SVG exports, or Drive snapshots.
- A source browser must be open, visible, and online to publish. Closing it leaves the last successful copy online, not a running background sync service. Edits from another device only reach a link after its publishing browser has received them through Drive and publishes them.
- Stop sharing retains the original canvas but clears its public content. Old URLs cannot be reactivated, including by delayed write requests. A new share gets a new URL. Deleting a locally shared canvas first requires successful revocation. Remote deletions are revoked when the publishing browser next reconciles its workspace.
- Clearing site data loses local management credentials; stop sharing first. Switching accounts never uses one account's capability for another account's board. Account switching, import, and duplication do not transfer capabilities.
- Anyone with a read link can forward or save the content. No login, confidentiality guarantee, password, collaboration, or cross-device sharing-management UI is provided. Already downloaded or offline copies cannot be retracted.
- Limit: 256 KiB, 500 notes and 1,000 connections per canvas. Initial service cap: 1,000 active shares and 20,000 total IDs including revocation tombstones. New requests fail explicitly when full; existing links can still be revoked. No content is silently truncated.

## Backend deployment

The existing OAuth Worker also routes `/shares/<random-id>`. Its original OAuth secrets, endpoints, and return-URL allowlist stay unchanged.

1. Create `scattered-shares` using `wrangler d1 create scattered-shares` if it does not already exist.
2. Set its ID as the `SHARES` binding in `worker/wrangler.jsonc`. Keep D1 reads on the primary (do not introduce replica reads here without preserving fresh revocation checks).
3. From `worker/`, run `wrangler d1 execute scattered-shares --remote --file=schema.sql`.
4. Deploy with `wrangler deploy --keep-vars`. The `SHARE_WRITES` and `SHARE_CREATES` rate-limit bindings are required; a missing binding fails sharing closed without affecting OAuth.
5. Deploy the static files, including `present.html`, the new sharing modules, and the bumped service-worker assets. `share-config.js` must point at this Worker's origin.

New-share creation is limited per IP; reads and updates are limited per IP and share, so multiple presenters on one classroom network do not share an update allowance. IP limiting is only an abuse guard, not identity authentication or a guaranteed global quota. Storage caps are enforced by the insert statement. Update requests additionally require the private capability and a matching revision.

## Checks

`npm test` includes real SQLite checks for authentication, input limits, conditional reads/writes, account boundaries, offline retry, opt-in, and revocation. Requires Node 22.13+ (SQLite is still marked experimental on Node 22).

For optional browser checks, use an existing Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node --experimental-sqlite test-sharing-browser.mjs
```

This starts a localhost server and an isolated headless Chrome. It uses synthetic canvases and an in-memory copy of the real share database; all production API requests are intercepted. It checks live editing, stable links, untouched viewer storage, XML escaping, offline display, mobile layout and revoked-link removal. It never uses the user's Chrome profile or real notes.

Cloudflare references: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
