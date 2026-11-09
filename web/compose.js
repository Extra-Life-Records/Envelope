/* Local recovery snapshots protect typing while durable saves are in flight. */
"use strict";
let composeSession = null;
let composeSaveTimer = null;

function composeVisible() {
  return $("compose-backdrop").classList.contains("show");
}

function hideCompose() {
  $("compose-backdrop").classList.remove("show");
  $(state.selectedUid ? "reply-btn" : "compose-btn").focus();
}

function focusComposeBody() {
  const body = $("compose-body");
  body.focus();
  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  body.closest(".compose-content").scrollTop = 0;
}

function setComposeBusy(session, busy) {
  session.busy = busy;
  document.querySelectorAll("#compose-backdrop button,#compose-backdrop input").forEach(control => { control.disabled = busy; });
  $("compose-body").contentEditable = busy ? "false" : "true";
}

function startComposeSession(accountId, draft = null) {
  clearTimeout(composeSaveTimer);
  composeSession = {id: draft?.id || crypto.randomUUID(), accountId, revision: draft?.revision || 0,
    generation: 0, savedGeneration: 0, queue: Promise.resolve(), busy: false, payload: null,
    inReplyTo: draft?.payload?.in_reply_to || "", references: draft?.payload?.references || "",
    attachments: draft?.attachments || []};
  $("compose-save-status").textContent = "Saving on this device…";
}

function recoveryKey(session) { return "simplemail-compose:" + session.accountId + ":" + session.id; }

function composeSnapshot() {
  return {to: $("compose-to").value, subject: $("compose-subject").value,
    body: composeText(), body_html: composeHtml(), cc: $("compose-cc").value, bcc: $("compose-bcc").value,
    in_reply_to: composeSession.inReplyTo, references: composeSession.references,
    attachment_ids: composeSession.attachments.map(item => item.id)};
}

function composeChanged() {
  const session = composeSession;
  if (!session || session.busy) return;
  session.payload = composeSnapshot();
  session.generation++;
  backupCompose(session);
  $("compose-save-status").textContent = "Saving on this device…";
  clearTimeout(composeSaveTimer);
  composeSaveTimer = setTimeout(() => persistCompose().catch(() => {}), 600);
}

function backupCompose(session) {
  try {
    localStorage.setItem(recoveryKey(session), JSON.stringify({id: session.id, account_id: session.accountId,
      revision: session.revision, payload: session.payload, attachments: session.attachments,
      updated_at: new Date().toISOString(), status: "pending"}));
  } catch {
    $("compose-save-status").textContent = "Recovery storage unavailable; save before closing";
  }
}

function clearComposeRecovery(session) {
  clearTimeout(composeSaveTimer);
  try { localStorage.removeItem(recoveryKey(session)); } catch {}
}

async function persistCompose() {
  clearTimeout(composeSaveTimer);
  const session = composeSession;
  if (!session) throw Error("No draft to save");
  const payload = composeSnapshot();
  session.payload = payload;
  const generation = session.generation;
  backupCompose(session);
  session.queue = session.queue.catch(() => {}).then(async () => {
    const draft = await api.save_compose_draft(session.accountId, session.id, session.revision,
      payload.to, payload.subject, payload.body, payload.body_html, payload.cc, payload.bcc,
      payload.in_reply_to, payload.references, payload.attachment_ids);
    session.revision = draft.revision;
    session.savedGeneration = Math.max(session.savedGeneration || 0, generation);
    if (session.generation === generation) session.payload = payload;
    backupCompose(session);
    if (composeSession === session && session.generation === generation) {
      $("compose-save-status").textContent = "Saved on this device";
    }
    return draft;
  });
  try { return await session.queue; }
  catch (error) {
    if (composeSession === session) $("compose-save-status").textContent = "Not saved: " +
      (typeof friendlyError === "function" ? friendlyError(error) : error);
    throw error;
  }
}

async function closeCompose() {
  if (!composeVisible()) return true;
  if (!composeSession || composeSession.busy) return false;
  const session = composeSession;
  setComposeBusy(session, true);
  try {
    await persistCompose();
    hideCompose();
    if (state.currentFolder === "drafts") loadMessages();
    return true;
  } catch (error) {
    if (await closeStaleCompose(session, "close")) return true;
    toast("Keep this draft open until saving succeeds: " + error, true); return false;
  }
  finally { setComposeBusy(session, false); }
}

async function discardCompose() {
  const session = composeSession;
  if (!session || session.busy) return;
  setComposeBusy(session, true);
  try {
    await persistCompose();
    await api.discard_compose_draft(session.accountId, session.id, session.revision);
    clearComposeRecovery(session);
    hideCompose();
    if (state.currentFolder === "drafts") loadMessages();
  } catch (error) {
    if (!(await closeStaleCompose(session, "discard"))) toast("Could not discard draft: " + error, true);
  }
  finally { setComposeBusy(session, false); }
}

// What the saved copy of a draft says now: its status and revision (nulls if it can't be read,
// e.g. a new draft that was never saved).
async function composeFate(session) {
  try {
    const draft = await api.get_compose_draft(session.accountId, session.id);
    return {status: draft.status, revision: draft.revision};
  } catch { return {status: null, revision: null}; }
}

// Why a closed copy closed, said to the owner. action is what they were doing: close, discard or send.
function staleDraftMessage(why, action) {
  if (why === "sending" || why === "uncertain") return "This draft is being sent or needs a delivery check: look in Sent";
  if (action === "send") return {dismissed: "Not sent: this draft was thrown away",
    sent: "Not sent again: this draft was already sent",
    changed: "Not sent: this draft was changed outside this window. Reopen it from Drafts and check it first",
  }[why] || "Not sent: this draft can't be edited any more";
  if (action === "discard" && why === "dismissed") return "Thrown away";
  return {dismissed: "This draft was thrown away, so it was closed",
    sent: "This draft was sent, so it was closed",
    changed: "This draft was changed outside this window, so this copy was closed. Reopen it from Drafts",
  }[why] || "This draft can't be edited any more, so it was closed";
}

// Saving failed. If the draft was thrown away, sent or changed outside this window (by the AI or
// another window), this copy can never be saved, kept, discarded or sent: close it and say why,
// rather than holding the owner in front of a dead draft. Ordinary failures (disk, network) keep
// the editor and its words. Returns true when it closed the editor.
async function closeStaleCompose(session, action) {
  const fate = await composeFate(session);
  let why = null;
  if (fate.status && fate.status !== "pending") why = fate.status;
  else if (fate.status === "pending" && fate.revision !== session.revision) why = "changed";
  if (!why || composeSession !== session) return false;
  if (why === "changed") clearTimeout(composeSaveTimer);   // keep the typing for Drafts to recover
  else clearComposeRecovery(session);                     // nothing left to recover into
  hideCompose();
  // Red only when something didn't happen or needs checking; a draft closed because it was sent
  // or thrown away is just news.
  toast(staleDraftMessage(why, action), action === "send" || !["dismissed", "sent"].includes(why));
  if (state.currentFolder === "drafts") loadMessages();
  return true;
}

// The AI changed, sent or threw away a draft. If it's the one open here, follow the saved copy:
// close it when it's gone, reload it when it changed and nothing typed here is unsaved, so the
// window never keeps an editor that can't save. Says what it did.
async function draftChangedElsewhere(accountId, draftId) {
  const session = composeSession;
  const fate = await composeFate({accountId, id: draftId});
  const gone = fate.status !== "pending";
  if (gone && fate.status) try { localStorage.removeItem(recoveryKey({accountId, id: draftId})); } catch {}
  if (!composeVisible() || !session || composeSession !== session || session.id !== draftId ||
      session.accountId !== accountId) return "not open";
  if (gone) return (await closeStaleCompose(session, "close")) ? "closed" : "kept";
  if (fate.revision === session.revision) return "current";
  if (session.busy || session.generation !== session.savedGeneration) {
    $("compose-save-status").textContent = "Changed outside this window: copy anything new, then reopen it from Drafts";
    return "kept";
  }
  clearComposeRecovery(session);   // its snapshot only holds what was saved before the change
  $("compose-backdrop").classList.remove("show");
  await resumeComposeDraft(draftId, accountId);
  return "reloaded";
}

function composeRecoveryDrafts(accountId, drafts) {
  const merged = new Map(drafts.map(draft => [draft.id, draft]));
  try {
    for (let n = 0; n < localStorage.length; n++) {
      const key = localStorage.key(n);
      if (!key.startsWith("simplemail-compose:" + accountId + ":")) continue;
      const cached = JSON.parse(localStorage.getItem(key));
      if (cached.account_id !== accountId || !cached.payload || typeof cached.payload.body !== "string") continue;
      if (!merged.has(cached.id)) merged.set(cached.id, cached);
    }
  } catch {}
  return Array.from(merged.values()).sort((a,b) => b.updated_at.localeCompare(a.updated_at));
}

// A draft reopens bound to the mailbox it was saved in (in All mailboxes the
// row says which); never to whichever mailbox happens to be open.
async function resumeComposeDraft(draftId, accountId = state.activeAccountId) {
  const request = ++composeRequest;
  if (composeVisible() && !(await closeCompose())) return;
  if (request !== composeRequest) return;
  const viewing = state.activeAccountId;
  const account = state.accounts.find(a => a.id === accountId);
  if (!account) { toast("That mailbox is no longer available", true); return; }
  let draft;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(recoveryKey({accountId, id:draftId})) || "null"); } catch {}
  try { draft = await api.get_compose_draft(accountId, draftId); }
  catch (error) { if (cached?.account_id === accountId && cached.revision === 0) draft = cached; else { toast(String(error), true); return; } }
  if (request !== composeRequest || viewing !== state.activeAccountId) return;
  if (draft.status !== "pending") {
    if (draft.status === "sent" || draft.status === "dismissed") clearComposeRecovery({accountId,id:draftId});
    if (draft.status === "uncertain") {
      // The send could not be confirmed. The owner looks in Sent, then may throw the draft away;
      // a cloud mailbox checks the service's own record first and keeps a draft that was sent.
      if (!confirm("This draft's send could not be confirmed. Check Sent first.\n\nThrow this draft away?")) return;
      try {
        await api.discard_compose_draft(accountId, draftId, draft.revision);
        clearComposeRecovery({accountId,id:draftId});
        toast("Thrown away");
      } catch (error) { toast(String(error), true); }
      if (state.currentFolder === "drafts") loadMessages();
      return;
    }
    toast(draft.status === "sent" ? "This draft was already sent" : draft.status === "dismissed" ? "This draft was thrown away"
      : "This draft is being sent. Check Sent before creating another message.", true);
    return;
  }
  if (cached?.account_id === accountId && Date.parse(cached.updated_at) > Date.parse(draft.updated_at) &&
      (cached.revision === draft.revision || cached.revision + 1 === draft.revision)) {
    draft.payload = cached.payload;
    draft.attachments = cached.attachments || draft.attachments;
  }
  composeAccountId = accountId;
  startComposeSession(accountId, draft);
  $("compose-from").textContent = `${account.label} <${account.identity}>`;
  $("compose-to").value = draft.payload.to;
  $("compose-subject").value = draft.payload.subject;
  $("compose-title").textContent = "Draft";
  $("compose-cc").value = draft.payload.cc || "";
  $("compose-bcc").value = draft.payload.bcc || "";
  $("compose-copies").open = !!(draft.payload.cc || draft.payload.bcc);
  renderComposeAttachments();
  // Restore only inert formatting; never insert stored executable markup.
  const parsed = new DOMParser().parseFromString(draft.payload.body_html || "", "text/html");
  const allowed = new Set(["DIV","P","BR","SPAN","B","STRONG","I","EM","U","S","BLOCKQUOTE","PRE","UL","OL","LI","A","IMG","TABLE","TR","TD","TH","TBODY","THEAD"]);
  parsed.body.querySelectorAll("*").forEach(element => {
    if (!allowed.has(element.tagName)) { element.replaceWith(...element.childNodes); return; }
    const image = element.tagName === "IMG" ? element.getAttribute("src") : null;
    const imageSize = image ? [element.getAttribute("width"), element.getAttribute("height")] : [];
    const imageAlt = image ? element.getAttribute("alt") : null;
    const link = element.tagName === "A" ? safeEmailLink(element.getAttribute("href")) : null;
    for (const attr of Array.from(element.attributes)) element.removeAttribute(attr.name);
    if (image && /^data:image\/(png|gif|jpeg|webp);base64,/i.test(image)) {
      element.setAttribute("src", image);
      ["width", "height"].forEach((name, index) => {
        if (/^[1-9]\d{0,3}$/.test(imageSize[index] || "")) element.setAttribute(name, imageSize[index]);
      });
      if (imageAlt) element.setAttribute("alt", imageAlt);
    }
    if (link) { element.setAttribute("href", link); element.setAttribute("rel", "noopener noreferrer"); }
  });
  $("compose-body").innerHTML = parsed.body.innerHTML || escapeHtml(draft.payload.body);
  $("compose-backdrop").classList.add("show");
  focusComposeBody();
  composeChanged();
}

function renderComposeAttachments() {
  const box = $("compose-attachments");
  box.innerHTML = (composeSession?.attachments || []).map((item, index) =>
    `<div class="att"><span class="name">${escapeHtml(item.name)} · ${fmtSize(item.size)}</span>` +
    `<button class="outline secondary" data-remove-attachment="${index}" aria-label="Remove ${escapeHtml(item.name)}">Remove</button></div>`).join("");
  box.querySelectorAll("[data-remove-attachment]").forEach(button => {
    button.onclick = () => {
      if (composeSession.busy) return;
      composeSession.attachments.splice(Number(button.dataset.removeAttachment), 1);
      renderComposeAttachments(); composeChanged();
    };
  });
}

async function addComposeFiles(files) {
  const session = composeSession;
  if (!session || session.busy) return;
  setComposeBusy(session, true);
  try {
    const incoming = Array.from(files);
    if (session.attachments.length + incoming.length > 20 || incoming.some(file => file.size > 10 * 1024 * 1024) ||
      incoming.reduce((sum, file) => sum + file.size, 0) + session.attachments.reduce((sum, item) => sum + item.size, 0) > 20 * 1024 * 1024) {
      throw Error("Select up to 20 files, at most 10 MB each and 20 MB together");
    }
    for (const file of incoming) {
      const encoded = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
        reader.onerror = () => reject(Error("Could not read " + file.name));
        reader.readAsDataURL(file);
      });
      session.attachments.push(await api.add_compose_attachment(session.accountId, file.name, encoded));
    }
  } catch (error) { toast(String(error), true); }
  finally {
    setComposeBusy(session, false); renderComposeAttachments(); composeChanged();
    $("compose-file-input").value = "";
  }
}

["compose-to", "compose-cc", "compose-bcc", "compose-subject", "compose-body"].forEach(id => $(id).addEventListener("input", composeChanged));
$("compose-attach").addEventListener("click", () => $("compose-file-input").click());
$("compose-file-input").addEventListener("change", event => addComposeFiles(event.target.files));
