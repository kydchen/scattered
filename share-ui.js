import { createLiveShare } from "./live-share.js";
import { SHARE_API } from "./share-config.js";
import { hasMessage, t } from "./i18n.js?v=78";

const quietStates = new Set(["shareOff", "shareUploading", "shareLive", "shareStopping", "shareCopied"]);
const bilingual = (key) => `${t(key, {}, "zh-Hans")} / ${t(key, {}, "en")}`;

export function mountLiveSharing({ storage, getScope, getBoards, getCurrentId, save, canPublish, onOpen }) {
  const trigger = document.querySelector("#export-share-button");
  const dialog = document.createElement("dialog");
  dialog.id = "share-dialog";
  dialog.className = "share-dialog";
  dialog.setAttribute("aria-labelledby", "share-heading");
  dialog.setAttribute("aria-describedby", "share-consent");
  dialog.innerHTML = `<h2 id="share-heading" class="sr-only"></h2>
    <header class="share-header">
      <svg class="share-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"></path></svg>
      <p id="share-board-title"></p>
      <button id="share-close" class="share-icon" type="button" data-share-label="shareClose">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>
      </button>
    </header>
    <p id="share-consent" data-share-text="shareConsent"></p>
    <p id="share-status" role="status" aria-atomic="true" class="sr-only"></p>
    <footer class="share-footer">
      <details class="share-details">
        <summary class="share-icon" data-share-label="shareDetails">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6m0-10v.5"></path></svg>
        </summary>
        <div class="share-link-row" hidden>
          <label for="share-url" class="sr-only"></label>
          <input id="share-url" type="url" readonly hidden />
        </div>
        <p class="share-notice" data-share-text="shareNoticeUpdates"></p>
        <p class="share-notice" data-share-text="shareNoticeControls"></p>
        <p class="share-notice" data-share-text="shareNoticeStop"></p>
      </details>
      <div class="share-actions">
        <button id="share-copy" class="share-icon" type="button" data-share-label="shareCopy" hidden>
          <svg class="share-copy-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg>
          <svg class="share-copied-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>
        </button>
        <a id="share-preview" class="share-icon" target="_blank" rel="noopener noreferrer" data-share-label="sharePreview" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"></path></svg>
        </a>
        <button id="share-enable" class="share-icon" type="button" data-share-label="shareEnable">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"></path></svg>
        </button>
        <button id="share-stop" class="share-icon" type="button" data-share-label="shareStop" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2M3 3l18 18"></path></svg>
        </button>
      </div>
    </footer>`;
  document.body.append(dialog);
  dialog.querySelector("#share-heading").textContent = bilingual("shareTitle");
  dialog.querySelector('label[for="share-url"]').textContent = bilingual("shareLink");
  for (const element of dialog.querySelectorAll("[data-share-label]")) {
    element.setAttribute("aria-label", bilingual(element.dataset.shareLabel));
  }
  for (const element of dialog.querySelectorAll("[data-share-text]")) {
    for (const language of ["zh-Hans", "en"]) {
      const text = document.createElement("span");
      text.lang = language;
      text.textContent = t(element.dataset.shareText, {}, language);
      element.append(text);
    }
  }
  const field = dialog.querySelector("#share-url");
  const message = dialog.querySelector("#share-status");
  const enable = dialog.querySelector("#share-enable");
  const copy = dialog.querySelector("#share-copy");
  const preview = dialog.querySelector("#share-preview");
  const stop = dialog.querySelector("#share-stop");
  let boardId;
  let scope;
  let busy = false;
  let timer;
  let scheduled = false;
  const service = createLiveShare({ apiUrl: SHARE_API, storage, getScope, getBoards, onStatus: refresh });
  function showMessage(key) {
    const known = hasMessage(key) ? key : "shareUnavailable";
    dialog.dataset.state = known;
    const description = bilingual(known);
    if (message.textContent !== description) message.textContent = description;
    message.classList.toggle("sr-only", quietStates.has(known));
    copy.dataset.copied = String(known === "shareCopied");
  }

  function refresh() {
    try {
      trigger.dataset.sharing = String(Boolean(service.current(getCurrentId())));
      if (!dialog.open) return;
      if (scope !== getScope() || boardId !== getCurrentId()) { dialog.close(); return; }
      const record = service.current(boardId);
      dialog.querySelector(".share-link-row").hidden = !record?.ready;
      field.hidden = copy.hidden = preview.hidden = !record?.ready;
      enable.hidden = Boolean(record?.ready);
      enable.disabled = busy || !service.available;
      stop.hidden = !record;
      stop.disabled = busy;
      copy.disabled = busy;
      enable.setAttribute("aria-busy", String(busy));
      stop.setAttribute("aria-busy", String(busy));
      field.value = record?.ready ? new URL(`present.html#${record.id}`, location.href).href : "";
      if (record?.ready) preview.href = field.value;
      else preview.removeAttribute("href");
      showMessage(service.available ? (record?.blocked ? "shareConflict" : service.state(boardId)) : "shareUnavailable");
    } catch { showMessage("shareStorage"); }
  }

  async function action(work) {
    if (busy || scope !== getScope() || boardId !== getCurrentId()) return;
    busy = true;
    refresh();
    let error;
    try { await work(); } catch (caught) { error = caught; }
    busy = false;
    refresh();
    if (error) showMessage(error.message);
  }

  trigger.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!await save()) return;
    boardId = getCurrentId();
    scope = getScope();
    dialog.querySelector(".share-details").open = false;
    dialog.querySelector("#share-board-title").textContent = getBoards().find((item) => item.id === boardId)?.board.title || "Scattered";
    onOpen?.();
    if (!dialog.open) dialog.showModal();
    refresh();
  });
  enable.addEventListener("click", () => action(() => service.enable(boardId)));
  stop.addEventListener("click", () => action(() => service.stop(boardId)));
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(field.value); showMessage("shareCopied"); }
    catch {
      dialog.querySelector(".share-details").open = true;
      field.focus(); field.select(); showMessage("shareCopyManually");
    }
  });
  dialog.querySelector("#share-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => document.querySelector("#boards-button").focus());

  async function update() {
    if (scheduled || !canPublish() || document.hidden) return;
    scheduled = true;
    try { await service.update(); } catch { /* No local writes are blocked by an unavailable share service. */ }
    finally { scheduled = false; refresh(); }
  }
  window.setInterval(update, 5_000);
  window.addEventListener("online", update);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void update(); });
  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(update, 800);
      refresh();
    },
    async stopCurrent() {
      try { await service.stop(getCurrentId()); return true; }
      catch { alert(bilingual("shareStopFailed")); return false; }
    },
  };
}
