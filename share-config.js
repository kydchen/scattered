// Separate from Google sync: only an explicit share action sends canvas content here.
export const SHARE_API = [
  "https://scatterednote.space",
  "https://www.scatterednote.space",
  "https://scattered.pages.dev",
  "https://kydchen.github.io",
  "http://localhost:4173",
].includes(globalThis.location?.origin) ? "https://sync.scatterednote.space" : "";
