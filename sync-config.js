const origin = globalThis.location?.origin;
export const DRIVE_SYNC_API = [
  "https://scatterednote.space",
  "https://www.scatterednote.space",
  "https://scattered.pages.dev",
  "https://codex-sync-preview.scattered.pages.dev",
  "http://localhost:4173",
].includes(origin)
  ? "https://sync.scatterednote.space"
  : "";
