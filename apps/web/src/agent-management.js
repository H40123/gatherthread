// Presentation only: connection, sharing and Team controls retain their owners.
export function mountAgentManagement({ document: doc, getContext }) {
  const el = id => doc.getElementById(id);
  const host = el("manage-agents-button"), dialog = el("agent-management-dialog");
  const overview = el("agent-management-overview"), connections = el("agent-management-connections");
  const add = el("agent-management-add"), back = el("agent-management-back");
  let scope, returnFocus;
  const focusable = node => node?.isConnected && !node.disabled
    && !node.closest?.("[hidden], [inert], dialog:not([open])") && node.getClientRects?.().length;
  function showConnections(visible) {
    overview.hidden = visible; connections.hidden = !visible; back.hidden = !visible;
  }
  function close() { if (dialog.open) dialog.close(); }
  function updateContext() {
    const next = getContext(); host.disabled = !next.available;
    if (scope !== next.scope || !next.available) close();
    scope = next.scope;
  }
  function open() {
    updateContext(); if (host.disabled || dialog.open) return;
    returnFocus = doc.activeElement; showConnections(false); dialog.showModal(); add.focus();
  }
  host.addEventListener("click", open);
  add.addEventListener("click", () => { showConnections(true); back.focus(); });
  back.addEventListener("click", () => { showConnections(false); add.focus(); });
  el("agent-management-close").addEventListener("click", close);
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    showConnections(false);
    const target = focusable(returnFocus) ? returnFocus : focusable(host) ? host : null;
    returnFocus = null; target?.focus({ preventScroll: true });
  });
  // Child dialogs stay above this menu. Restore their original entry only when
  // native focus did not already return, without stealing another dialog's focus.
  for (const [childId, entryId] of [["connect-codex-dialog", "connect-codex-button"],
    ["connect-dsh-dialog", "connect-dsh-button"], ["connect-claude-dialog", "connect-claude-button"],
    ["settings-dialog", "add-agent-button"],
    ["agent-sharing-dialog", "agent-sharing-button"], ["agent-team-dialog", "agent-teams-button"]]) {
    el(childId)?.addEventListener("close", () => {
      if (!dialog.open || el(childId).open || dialog.contains(doc.activeElement)) return;
      if ([...doc.querySelectorAll("dialog[open]")].some(node => node !== dialog)) return;
      const entry = el(entryId); if (focusable(entry)) entry.focus({ preventScroll: true });
    });
  }
  updateContext();
  return { open, close, updateContext };
}
