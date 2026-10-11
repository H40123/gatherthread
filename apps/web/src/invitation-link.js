import { beijingDateTime } from "./invitation-share.js?v=20261012-invite-1";

export function invitationFromHash(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const values = params.getAll("invite");
  return {
    present: values.length > 0,
    token: values.length === 1 && /^gti_[A-Za-z0-9_-]{32,508}$/.test(values[0]) ? values[0] : null,
  };
}

// The fragment survives registration/login/reload without persisting a secret
// in Web Storage. The only membership write is an explicit confirm click.
export function mountInvitationLink({ document, location, history, api, localizer, getContext, onShow, onDismiss, onSwitchAccount }) {
  const node = id => document.getElementById(id);
  const view = node("invitation-link-view");
  let entry = invitationFromHash(location.hash);
  let generation = 0;
  let controller = null;
  let preview = null;
  let phase = "idle";
  let status = "";

  function reset() {
    generation += 1;
    controller?.abort();
    controller = null;
    preview = null;
    phase = "idle";
    status = "";
    view.hidden = true;
    render();
  }
  function current(revision, scope) {
    return revision === generation && getContext()?.scope === scope;
  }
  async function request(operation) {
    const abort = new AbortController();
    controller = abort;
    // AbortController works on the Safari 15 baseline; timeout() does not.
    const timer = setTimeout(() => abort.abort(), 15_000);
    timer.unref?.();
    try { return await operation(abort.signal); }
    finally { clearTimeout(timer); if (controller === abort) controller = null; }
  }
  function render() {
    node("invitation-auth-hint").hidden = !entry.present;
    node("invitation-details").hidden = !preview;
    node("invitation-link-title").textContent = preview
      ? localizer.t("Join ({project})").replace("{project}", () => preview.project.title)
      : localizer.t("Join a project");
    node("invitation-inviter").textContent = preview?.inviter_display_name ?? "";
    node("invitation-account").textContent = getContext()?.username ?? "";
    node("invitation-member-role").textContent = preview ? localizer.t(preview.role === "participant" ? "Participant" : "Viewer") : "";
    node("invitation-expires").textContent = preview ? `${beijingDateTime(preview.expires_at, document.documentElement.lang)} ${localizer.t("(China Standard Time)")}` : "";
    node("invitation-link-status").textContent = localizer.t(status);
    node("invitation-link-status").setAttribute("role", phase === "error" ? "alert" : "status");
    const accepting = phase === "accepting";
    const loading = phase === "loading";
    view.setAttribute("aria-busy", String(accepting || loading));
    node("invitation-confirm-button").disabled = !preview || accepting || loading;
    node("invitation-confirm-button").textContent = localizer.t(accepting ? "Joining…" : preview?.already_member ? "Open project" : "Confirm and join");
    node("invitation-decline-button").disabled = accepting;
    node("invitation-switch-account-button").disabled = accepting;
    node("invitation-retry-button").hidden = phase !== "error";
  }
  function failure(error, accepting = false) {
    if (error?.code === "invitation_unavailable" || (accepting && error?.status === 401)) {
      return "This invitation is expired, revoked, already used or unavailable. Ask the project owner for a new invitation.";
    }
    if (error?.status === 401) return "Your sign-in has expired. Switch account and sign in again to review this invitation.";
    if (error?.status === 404 || error?.code === "invalid_response") {
      return "This server cannot show the invitation. You can sign in and enter the invitation secret under Join another project.";
    }
    return accepting
      ? "Could not confirm joining. Retry checks whether you already joined before sending another request."
      : "Could not load the invitation. Check your connection and try again.";
  }
  async function open() {
    if (!entry.present) return false;
    reset();
    const context = getContext();
    if (!context) return true;
    onShow();
    view.hidden = false;
    const revision = generation;
    phase = "loading";
    status = "Loading invitation…";
    render();
    node("invitation-link-title").focus();
    try {
      if (!entry.token) throw { code: "invitation_unavailable" };
      const result = await request(signal => api.previewInvitation(entry.token, { signal }));
      if (!current(revision, context.scope)) return true;
      preview = result;
      phase = "ready";
      status = result.already_member
        ? "You already belong to this project. Opening it will not consume the invitation or change your role."
        : "Joining gives you access to this project's current and future conversations. Join only if you recognize the inviter.";
    } catch (error) {
      if (!current(revision, context.scope)) return true;
      phase = "error";
      status = failure(error);
    }
    render();
    return true;
  }
  async function confirm() {
    const context = getContext();
    if (phase !== "ready" || !preview || !entry.token || !context) return;
    const revision = generation;
    const token = entry.token;
    const projectId = preview.project.id;
    phase = "accepting";
    status = "Checking invitation and joining…";
    render();
    try {
      // Revalidate membership/expiry/revocation after any time spent on the page.
      const fresh = await request(signal => api.previewInvitation(token, { signal }));
      if (!current(revision, context.scope)) return;
      if (fresh.project.id !== projectId) throw { code: "invalid_response" };
      if (!fresh.already_member) {
        const result = await request(signal => api.acceptInvitation(token, { signal }));
        if (!current(revision, context.scope)) return;
        if (result.invitation.projectId !== projectId) throw { code: "invalid_response" };
      }
      // Fresh restoration handles workspace loading failures after acceptance.
      // Replace the capability URL, and derive the destination from server data.
      const target = new URL(location.href);
      target.hash = new URLSearchParams({ project: projectId }).toString();
      reset();
      entry = { present: false, token: null };
      location.replace(target.href);
      // Changing only the hash is same-document navigation, so explicitly
      // restore the authenticated workspace instead of leaving the page hidden.
      location.reload();
    } catch (error) {
      if (!current(revision, context.scope)) return;
      preview = null;
      phase = "error";
      status = failure(error, true);
      render();
    }
  }
  node("invitation-confirm-button").addEventListener("click", () => void confirm());
  node("invitation-retry-button").addEventListener("click", () => void open());
  node("invitation-decline-button").addEventListener("click", () => {
    if (phase === "accepting") return;
    const target = new URL(location.href);
    const hash = new URLSearchParams(target.hash.slice(1));
    hash.delete("invite");
    target.hash = hash.toString();
    entry = { present: false, token: null };
    reset();
    history.replaceState(null, "", target.href);
    onDismiss();
  });
  node("invitation-switch-account-button").addEventListener("click", () => {
    if (phase === "accepting") return;
    reset();
    void onSwitchAccount();
  });
  render();
  return {
    hasPending: () => entry.present, open, reset, refreshLanguage: render,
    syncFromHash() {
      const next = invitationFromHash(location.hash);
      if (next.present === entry.present && next.token === entry.token) return false;
      entry = next;
      reset();
      return true;
    },
  };
}
