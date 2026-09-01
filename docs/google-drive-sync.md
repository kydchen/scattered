# Optional Google Drive sync / 可选的 Google Drive 同步

[中文说明](#中文说明)

Scattered remains fully local-first when `DRIVE_SYNC_API` is empty. When a user explicitly connects Google Drive, the browser writes versioned workspace snapshots directly to that user's Drive `appDataFolder`. A stateless Cloudflare Worker only performs OAuth token exchange; it has no database and never receives workspace content.

Each browser installation keeps its own Drive file. This avoids two devices overwriting the same file. Independent canvas edits merge automatically; concurrent edits to the same canvas are retained as separate canvas copies.

## Deploy

1. In Google Cloud Console, enable the Google Drive API and configure an external OAuth consent screen.
2. Create an OAuth 2.0 **Web application** client. Add the Worker's exact callback URL, for example `https://scattered-sync.example.workers.dev/oauth/callback`, as an authorized redirect URI.
3. Set the exact application URLs in `worker/wrangler.jsonc` under `APP_URLS`. Keep the trailing slash.
4. From `worker/`, deploy the Worker and enter its secrets:

   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET
   npx wrangler deploy
   ```

   `SESSION_SECRET` must be a random value of at least 32 characters. Rotating it disconnects existing browser sessions.

5. Set the deployed Worker origin in `sync-config.js`, without a trailing slash:

   ```js
   export const DRIVE_SYNC_API = "https://scattered-sync.example.workers.dev";
   ```

6. Bump the cache name in `sw.js`, deploy the static site, and connect the same Google account once on each device.

For local testing, keep `http://localhost:4173/` in `APP_URLS`; the production OAuth callback still points to the Worker. Run `npm test` before deployment.

## Security and operating boundary

- The OAuth scope is limited to `https://www.googleapis.com/auth/drive.appdata`.
- The refresh token is encrypted into an opaque browser-held session using AES-GCM. The Worker stores neither tokens nor canvas content.
- Access tokens are short-lived and kept only in memory. The service worker ignores cross-origin requests, so Drive and broker responses are never cached.
- Disconnecting removes this browser's session. To revoke the Google grant everywhere, use the Google Account third-party access page.
- Use a dedicated origin or custom domain before enabling sync publicly. GitHub Pages project sites under the same `username.github.io` host share one browser origin and therefore share `localStorage`; a separate path is not a security boundary.

## 中文说明

当 `DRIVE_SYNC_API` 为空时，Scattered 仍是完全本地优先的应用。用户主动连接 Google Drive 后，浏览器才会把带版本的工作区快照直接写入该用户 Drive 的 `appDataFolder`。无状态 Cloudflare Worker 只负责 OAuth 凭据交换；它没有数据库，也不会收到工作区内容。

每个浏览器安装会维护自己的 Drive 文件，避免两台设备同时写同一个文件。不同画布的修改会自动合并；如果两边同时修改同一张画布，两个版本都会保留为独立画布副本。

部署步骤与上方一致。正式开启前尤其要注意：建议使用独立域名或自定义域名。GitHub Pages 中同一个 `username.github.io` 下的不同项目路径属于同一浏览器 origin，也会共享 `localStorage`；路径本身不能形成安全隔离。
