/* The window's side of SimpleMail's AI tools (app_mcp.py): say what the window shows, and open
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
        : "SimpleMail couldn't switch mailbox: is a draft open that can't be saved?"};
    }
    if (target.folder) {
      const want = String(target.folder).toLowerCase();
      const folder = state.folders.find((f) => [f.key, f.name, f.server].some((v) => String(v || "").toLowerCase() === want));
      if (!folder) return {error: "This mailbox has no folder called " + target.folder};
      if (folder.key !== state.currentFolder || mailSearch) await selectFolder(folder.key);
    }
    if (target.uid) {
      const listed = state.messages.find((m) => !m.localDraftId && String(m.server_uid || m.uid) === String(target.uid));
      await openMessage(listed ? listed.uid : String(target.uid));
    }
    if (target.draft_id) await resumeComposeDraft(target.draft_id);
    return await mcpScreen();
  } catch (e) { return {error: String(e?.message || e)}; }
}

// The AI changed mail: show the server's lists again rather than remembered ones.
function mcpRefresh() {
  folderCache.clear();
  loadMessages({ quiet: true });
  return true;
}
