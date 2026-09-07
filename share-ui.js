import { createLiveShare } from "./live-share.js";
import { SHARE_API } from "./share-config.js";
import { applyTranslations, hasMessage, t } from "./i18n.js?v=71";

export function mountLiveSharing({ storage, getScope, getBoards, getCurrentId, save, canPublish }) {
  const trigger = document.querySelector("#export-share-button");
  const dialog = document.createElement("dialog");
  dialog.id = "share-dialog";
  dialog.className = "share-dialog";
  dialog.setAttribute("aria-labelledby", "share-heading");
  dialog.setAttribute("aria-describedby", "share-consent");
  dialog.innerHTML = `<h2 id="share-heading" data-i18n-text="shareTitle"></h2>
    <p id="share-board-title"></p>
    <p id="share-consent" data-i18n-text="shareConsent"></p>
    <p class="share-notice" data-i18n-text="sharePublisherNotice"></p>
    <label for="share-url" class="sr-only" data-i18n-text="shareLink"></label>
    <input id="share-url" type="url" readonly hidden />
    <p id="share-status" role="status"></p>
    <div class="share-actions">
      <button id="share-enable" type="button" data-i18n-text="shareEnable"></button>
      <button id="share-copy" type="button" data-i18n-text="shareCopy" hidden></button>
      <button id="share-stop" type="button" data-i18n-text="shareStop" hidden></button>
      <button id="share-close" type="button" data-i18n-text="shareClose"></button>
    </div>`;
  document.body.append(dialog);
  applyTranslations(dialog);
  const field = dialog.querySelector("#share-url");
  const message = dialog.querySelector("#share-status");
  const enable = dialog.querySelector("#share-enable");
  const copy = dialog.querySelector("#share-copy");
  const stop = dialog.querySelector("#share-stop");
  let boardId;
  let scope;
  let busy = false;
  let timer;
  let scheduled = false;
  const service = createLiveShare({ apiUrl: SHARE_API, storage, getScope, getBoards, onStatus: refresh });
  const explain = (key) => t(hasMessage(key) ? key : "shareUnavailable");

  function refresh() {
    try {
      trigger.dataset.sharing = String(Boolean(service.current(getCurrentId())));
      trigger.title = t("shareTitle");
      if (!dialog.open) return;
      if (scope !== getScope() || boardId !== getCurrentId()) { dialog.close(); return; }
      const record = service.current(boardId);
      field.hidden = copy.hidden = !record?.ready;
      enable.hidden = Boolean(record?.ready);
      enable.disabled = busy || !service.available;
      stop.hidden = !record;
      stop.disabled = busy;
      copy.disabled = busy;
      field.value = record?.ready ? new URL(`present.html#${record.id}`, location.href).href : "";
      message.textContent = explain(service.available ? (record?.blocked ? "shareConflict" : service.state(boardId)) : "shareUnavailable");
    } catch { message.textContent = t("shareStorage"); }
  }

  async function action(work) {
    if (busy || scope !== getScope() || boardId !== getCurrentId()) return;
    busy = true;
    refresh();
    let error;
    try { await work(); } catch (caught) { error = caught; }
    busy = false;
    refresh();
    if (error) message.textContent = explain(error.message);
  }

  trigger.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!await save()) return;
    boardId = getCurrentId();
    scope = getScope();
    dialog.querySelector("#share-board-title").textContent = getBoards().find((item) => item.id === boardId)?.board.title || "Scattered";
    if (!dialog.open) dialog.showModal();
    refresh();
  });
  enable.addEventListener("click", () => action(() => service.enable(boardId)));
  stop.addEventListener("click", () => action(() => service.stop(boardId)));
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(field.value); message.textContent = t("shareCopied"); }
    catch { field.focus(); field.select(); message.textContent = t("shareCopyManually"); }
  });
  dialog.querySelector("#share-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => trigger.focus());

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
      catch { alert(t("shareStopFailed")); return false; }
    },
  };
}
