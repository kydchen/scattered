const origin = globalThis.location?.origin;
export const DRIVE_SYNC_API = ["https://scattered.pages.dev", "http://localhost:4173"].includes(origin)
  ? "https://scattered-sync.kyd405836552.workers.dev"
  : "";
