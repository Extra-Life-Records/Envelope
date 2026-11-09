/* The window's side of Envelope's AI tools (app_mcp.py): say what the window shows, and open
   what the AI puts in front of the owner, through the same functions the owner's clicks use. */
"use strict";

function mcpEnvelope(message, folder) {
  const server = message.server_folder || folder?.server || null;
  // In All mailboxes each row says which mailbox it sits in.
  return {account: messageAccountId(message), uid: message.localDraftId ? null : String(message.server_uid || message.uid),
    server_folder: server, validity: message.validity || folder?.validity || null,
    draft_id: message.localDraftId || null,
    from: message.sender || "", subject: message.subject || "", date: message.date || "", seen: !!message.seen,
    // search results and cloud lists put the folder name where the preview goes
    preview: message.snippet && message.snippet !== server ? message.snippet : "",
    selected: message.uid === state.selectedUid};
}

async function mcpScreen() {
  try {
    const account = activeAccount();
    const folder = state.folders.find((f) => f.key === state.currentFolder) || null;
    let shown = null;
    if (state.selectedUid && $("read-header").style.display !== "none") {
      const message = state.messages.find((m) => m.uid === state.selectedUid) || {uid: state.selectedUid};
      shown = {...mcpEnvelope(message, folder), subject: $("read-subject").textContent,
        from: $("read-meta").querySelector(".sender-line")?.textContent || message.sender || ""};
    }
    return {
      account: allMail() ? {id: "all", label: "All mailboxes"}
        : account ? {id: account.id, label: account.label, address: account.identity || account.email} : null,
      folder: folder ? {name: folder.name, server_name: folder.server} : null,
      search: mailSearch ? $("search-box").value : "",
      messages: state.messages.slice(0, 50).map((m) => mcpEnvelope(m, folder)),
      more_messages: Math.max(0, state.messages.length - 50),
      open_message: shown,
      draft: composeVisible() && composeSession ? {account: composeSession.accountId, draft_id: composeSession.id,
        revision: composeSession.revision, to: $("compose-to").value, subject: $("compose-subject").value,
        title: $("compose-title").textContent} : null,
      settings_open: $("settings-backdrop").classList.contains("show"),
    };
  } catch (e) { return {error: String(e?.message || e)}; }
}

async function mcpShow(target) {
  try {
    const wanted = target.account === "all" ? ALL_MAIL : target.account;
    if (wanted && wanted !== state.activeAccountId) {
      await selectAccount(wanted);
      if (state.activeAccountId !== wanted) return {error: wanted === ALL_MAIL ? "All mailboxes needs two or more mailboxes"
        : "Envelope couldn't switch mailbox: is a draft open that can't be saved?"};
    }
    if (target.folder) {
      const want = String(target.folder).toLowerCase();
      const folder = state.folders.find((f) => [f.key, f.name, f.server].some((v) => String(v || "").toLowerCase() === want));
      if (!folder) return {error: "This mailbox has no folder called " + target.folder};
      if (folder.key !== state.currentFolder || mailSearch) await selectFolder(folder.key);
      if (folder.key !== state.currentFolder) return {error: mcpOpenDraftBlocks()};
    }
    if (target.uid) {
      const listed = state.messages.find((m) => !m.localDraftId && String(m.server_uid || m.uid) === String(target.uid));
      await openMessage(listed ? listed.uid : String(target.uid));
    }
    if (target.draft_id) {
      await resumeComposeDraft(target.draft_id);
      if (!(composeVisible() && composeSession?.id === target.draft_id)) {
        return {error: await mcpDraftProblem(state.activeAccountId, target.draft_id)};
      }
    }
    return await mcpScreen();
  } catch (e) { return {error: String(e?.message || e)}; }
}

// The window stays on a draft it can't save rather than lose the owner's words: say so, so the
// AI tells the owner instead of reporting that something opened when it didn't.
function mcpOpenDraftBlocks() {
  return composeVisible() ? "The draft open in the window can't be saved (" + $("compose-save-status").textContent +
    "), so Envelope stayed on it. The owner can press Keep draft or Discard on it" : "Envelope couldn't change what the window shows";
}

async function mcpDraftProblem(accountId, draftId) {
  if (composeVisible() && composeSession && composeSession.id !== draftId) return mcpOpenDraftBlocks();
  try {
    const draft = await api.get_compose_draft(accountId, draftId);
    if (draft.status === "dismissed") return "That draft was thrown away";
    if (draft.status === "sent") return "That draft was already sent";
    if (draft.status !== "pending") return "That draft is being sent or needs a delivery check: look in Sent";
  } catch (e) { return String(e?.message || e); }
  return "Envelope couldn't open that draft";
}

// The AI changed, sent or threw away a draft: the window follows the saved copy (web/compose.js).
async function mcpDraftChanged(accountId, draftId) {
  try { return {result: await draftChangedElsewhere(accountId, draftId)}; }
  catch (e) { return {error: String(e?.message || e)}; }
}

// The AI changed mail: show the server's lists again rather than remembered ones.
function mcpRefresh() {
  folderCache.clear();
  loadMessages({ quiet: true });
  return true;
}
