import { renderAvatar } from "./avatars.js?v=20261029-motion-1";
import { SHARED_AGENT_ZH_CN } from "./shared-agent-i18n.js?v=20261029-motion-1";
import { makeAgentDialogButton } from "./agent-dialog-navigation.js";

export const DEFAULT_SHARE_LIMITS = Object.freeze({ per_member_daily_calls: 20, per_member_daily_seconds: 3600,
  total_daily_calls: 100, total_daily_seconds: 18000, max_concurrent: 1, max_request_seconds: 720 });
const harnessLabel = profile => profile?.harness === "deepseek-harness" ? "DSH" : "Codex";
export const sharedAgentKey = share => JSON.stringify(["shared", share.id, share.revision]);
const modelKey = profile => JSON.stringify([profile.provider, profile.model]);
const memberId = member => member.user_id ?? member.userId ?? member.id;
const memberName = member => member.display_name ?? member.username ?? member.displayName ?? "";
const sourceConnectionKey = runtime => JSON.stringify([runtime.deviceId ?? runtime.device_id ?? runtime.id, runtime.harness]);
export function supportsAgentSharing(runtime) {
  const capability = runtime?.sharingCapability ?? runtime?.sharing_capability;
  return ["codex", "deepseek-harness"].includes(runtime?.harness) && runtime?.purpose !== "snapshot_connector"
    && capability?.version === 1 && capability.isolated === true && capability.project_only === true
    && capability.cancellation === true && capability.liveness_watchdog === true;
}
export function shareProfiles(share) {
  return share.execution_profiles ?? [{ provider: share.execution_profile.provider, model: share.execution_profile.model,
    ...(share.execution_profile.reasoning_effort ? { reasoning_efforts: [share.execution_profile.reasoning_effort],
      default_reasoning_effort: share.execution_profile.reasoning_effort } : {}) }];
}
function defaultProfile(share) {
  const profiles = shareProfiles(share);
  const profile = profiles.find(item => modelKey(item) === modelKey(share.execution_profile)) ?? profiles[0];
  if (!profile) return null;
  const effort = profile.default_reasoning_effort ?? profile.reasoning_efforts?.[0];
  return { harness: share.execution_profile.harness, provider: profile.provider, model: profile.model,
    ...(effort ? { reasoning_effort: effort } : {}) };
}
export function sharedAgentChoices(shares, userId, translate = value => value) {
  return (shares ?? []).filter(share => share.owner_user_id !== userId).map(share => ({
    key: sharedAgentKey(share), share, available: share.available === true,
    target: { kind: "shared", share_id: share.id, share_revision: share.revision, ...defaultProfile(share) },
    label: `${translate("{name}'s {agent}").replace("{name}", () => share.owner_display_name)
      .replace("{agent}", () => harnessLabel(share.execution_profile))}`,
  }));
}
export function sharedAgentDisclosure(share, mode, translate = value => value) {
  if (!share) return "";
  return translate(mode === "solo"
    ? "Solo disclosure: this task and its conversation context will be sent to {name}'s device."
    : "Runs on {name}'s device and uses their shared allowance.").replace("{name}", () => share.owner_display_name);
}
export function sharingReason(reason, translate = value => value) {
  return translate({ locked: "Agent unavailable", offline: "Device offline", unsupported: "Connection unsupported",
    source_changed: "Access changed", access_changed: "Access changed", restart: "Sharing stopped automatically",
    manual: "Sharing is off", daily_limit: "Sharing allowance exhausted", member_daily_limit: "Sharing allowance exhausted",
    total_daily_limit: "Sharing allowance exhausted", busy: "Shared Agent is busy" }[reason] ?? "Unavailable");
}

/** Source-level grants; exact model/effort are selected and frozen by each borrower. */
export function mountSharedAgents({ document: doc = document, api, localizer, getContext, onChange = () => {},
  makeKey = () => crypto.randomUUID(), hostButton, pickerHost, readDeadlineMs = 8000, autosaveDelayMs = 450, onExit = () => {} }) {
  const t = value => {
    const translated = localizer.t(value);
    return translated === value && doc.documentElement?.lang === "zh-CN" ? SHARED_AGENT_ZH_CN[value] ?? value : translated;
  };
  const translations = [];
  function el(tag, text = "", className = "", id) {
    const node = doc.createElement(tag); if (id) node.id = `agent-sharing-${id}`;
    node.setAttribute("data-i18n-skip", ""); node.className = className;
    if (text) { const update = () => { node.textContent = t(text); }; translations.push(update); update(); }
    return node;
  }
  const raw = (tag, text, className = "") => { const node = el(tag, "", className); node.textContent = text; return node; };
  const btn = (text, id, className = "button button-secondary") => {
    const node = el("button", text, className, id); node.type = "button"; return node;
  };
  const fieldLabel = (text, input) => { const label = el("label", text); label.htmlFor = input.id; return label; };
  const button = hostButton ?? btn("Share my Agent", "button");
  button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-controls", "agent-sharing-dialog");
  const dialog = el("dialog", "", "create-dialog agent-sharing-dialog", "dialog");
  dialog.setAttribute("aria-labelledby", "agent-sharing-title"); dialog.setAttribute("aria-describedby", "agent-sharing-description");
  const header = el("header", "", "sharing-heading"), heading = el("div");
  heading.append(el("h2", "Agent sharing", "", "title"), el("p", "Choose who can use each connected Agent. Changes save automatically.", "field-help", "description"));
  const close = makeAgentDialogButton({ document: doc, label: t("Close Agent sharing"), kind: "close",
    id: "agent-sharing-close", onClick: () => requestNavigation("exit") });
  translations.push(() => close.refreshLabel(t("Close Agent sharing")));
  header.append(heading, close);
  const body = el("div", "", "sharing-body");
  const overview = el("section", "", "sharing-overview", "overview");
  const overviewBack = makeAgentDialogButton({ document: doc, label: t("Back"), kind: "back",
    id: "agent-sharing-overview-back", onClick: () => requestNavigation("back") });
  translations.push(() => overviewBack.refreshLabel(t("Back")));
  const listHeading = el("div", "", "sharing-list-heading"), refreshButton = btn("Refresh", "refresh", "text-button");
  listHeading.append(el("h3", "My connected Agents"), refreshButton);
  const ownList = el("ul", "", "sharing-list", "list");
  const empty = el("p", "Connect a supported Codex or DSH before sharing.", "field-help", "empty");
  overview.append(overviewBack, listHeading, empty, ownList);
  const editor = el("form", "", "sharing-editor", "editor"); editor.hidden = true;
  const back = makeAgentDialogButton({ document: doc, label: t("Back"), kind: "back",
    id: "agent-sharing-back", onClick: () => requestNavigation("back") });
  back.className += " sharing-back";
  translations.push(() => back.refreshLabel(t("Back")));
  const source = el("select", "", "", "source"); source.required = true;
  const unsupported = el("p", "", "sharing-warning", "unsupported"); unsupported.hidden = true;
  const sourceField = el("section", "", "sharing-section");
  sourceField.append(fieldLabel("Agent", source), source, unsupported,
    el("p", "Recipients choose their model and reasoning effort. Each Agent keeps one sharing configuration.", "field-help"));
  const membersField = el("fieldset", "", "sharing-section"); membersField.append(el("legend", "Sharing recipients"));
  const members = el("div", "", "sharing-members", "members");
  membersField.append(members, el("p", "Selected members may use this Agent immediately after you enable sharing; they do not need to accept an invitation.", "field-help"));
  const limitsField = el("fieldset", "", "sharing-section"); limitsField.append(el("legend", "Sharing limits"));
  const grid = el("div", "", "sharing-limits");
  const callsInput = el("input", "", "", "total_daily_calls"), minutesInput = el("input", "", "", "total_daily_seconds");
  for (const [input, title, max] of [[callsInput, "Total calls per day", 10000], [minutesInput, "Total minutes per day", 14400]]) {
    input.type = "number"; input.required = true; input.min = input === minutesInput ? String(1 / 60) : "1";
    input.max = String(max); input.step = input === minutesInput ? "any" : "1";
    const wrapper = el("div", "", "sharing-limit"); wrapper.append(fieldLabel(title, input), input); grid.append(wrapper);
  }
  limitsField.append(grid, el("p", "Shared by all recipients. One task at a time, up to 12 minutes per task.", "field-help"),
    el("p", "Daily limits reset at 00:00 UTC. Manual calls and Agent requests count together.", "field-help"));
  const state = el("p", "", "sharing-state", "state"); state.setAttribute("role", "status");
  const ownerUsage = el("p", "", "field-help", "owner-usage");
  const actions = el("div", "", "sharing-actions");
  const toggle = btn("Start sharing", "toggle", "button sharing-toggle"); actions.append(toggle);
  const notes = el("div", "", "sharing-notes");
  notes.append(
    el("p", "Changing an active sharing configuration stops tasks using the previous configuration.", "field-help"),
    el("p", "Only this project's directory may be used. Your credentials stay on your device.", "field-help"),
    el("p", "Shared execution supports project file list, read and write only. Terminal, network and external tools are unavailable.", "field-help"),
    el("p", "After the Agent goes offline, you must enable sharing again manually. Allowed members are kept.", "field-help"),
    el("p", "Disabling cancels queued and running shared tasks. Your own Agent requests are unaffected.", "field-help"));
  editor.append(back, sourceField, membersField, limitsField, state, ownerUsage, actions, notes);
  body.append(overview, editor);
  const footer = el("footer", "", "sharing-footer");
  const status = el("p", "", "field-help", "status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const error = el("p", "", "form-error", "error"); error.setAttribute("role", "alert");
  const retry = btn("Check the last sharing action", "retry"); retry.hidden = true; footer.append(status, error, retry);
  // Example pages deliberately disallow native modals. Keep local navigation
  // decisions inside this dialog instead of depending on window.confirm().
  const leaveConfirmation = el("section", "", "sharing-leave-confirmation", "leave-confirmation");
  leaveConfirmation.hidden = true; leaveConfirmation.setAttribute("role", "group");
  const leaveMessage = el("p", "", "field-help", "leave-message");
  leaveConfirmation.setAttribute("aria-labelledby", leaveMessage.id);
  const leaveActions = el("div", "", "sharing-leave-actions");
  const stay = btn("Stay on this page", "leave-stay"), discard = btn("Discard changes and leave", "leave-discard"),
    leavePending = btn("Leave for now", "leave-pending");
  leaveActions.append(stay, discard, leavePending); leaveConfirmation.append(leaveMessage, leaveActions); footer.append(leaveConfirmation);
  dialog.append(header, body, footer); doc.body.append(dialog);

  const picker = el("div", "", "shared-agent-picker", "picker");
  const modelSelect = el("select", "", "", "model"), effortSelect = el("select", "", "", "effort");
  const modelField = el("div"), effortField = el("div");
  modelField.append(fieldLabel("Model", modelSelect)); modelField.append(modelSelect);
  effortField.append(fieldLabel("Reasoning effort", effortSelect), effortSelect);
  const profileGrid = el("div", "", "sharing-profile-grid"); profileGrid.append(modelField, effortField);
  const disclosure = el("p", "", "sharing-disclosure", "disclosure"); disclosure.setAttribute("role", "status");
  const usage = el("p", "", "field-help", "usage");
  picker.append(profileGrid, disclosure, usage); pickerHost?.append(picker);

  let scope = "", generation = 0, shares = [], selected = null, sourceChoices = [], dirty = false, loaded = false;
  let mutation = null, attempt = null, readController = null, mutationController = null, readBusy = false, mutationEpoch = 0;
  let draftVersion = 0, autosaveTimer, requestedStart = false, selectedKey = "", chosenModel = "", chosenEffort = "";
  let statusSource = "", errorSource = "", returnFocus, navigationIntent = null, navigationDecision = null;
  const memberInputs = new Map();
  const current = (gen, context) => gen === generation && scope === getContext()?.scope && context.projectId === getContext()?.projectId;
  const setStatus = value => { statusSource = value; status.textContent = t(value); };
  const setError = value => { errorSource = value; error.textContent = t(value); };
  const allowedIds = () => [...memberInputs].filter(([, input]) => input.checked).map(([id]) => id);
  const borrowed = () => sharedAgentChoices(shares, getContext()?.userId, t);
  const selectedAgent = () => borrowed().find(choice => choice.key === selectedKey);
  const sourceReady = choice => choice?.supported && choice.runtime.status === "online"
    && (choice.runtime.sharingAvailability ?? choice.runtime.sharing_availability) === "ready";
  function options(node, values, value) {
    node.replaceChildren();
    for (const item of values) { const option = raw("option", item.label); option.value = item.value; option.disabled = Boolean(item.disabled); node.append(option); }
    node.value = value ?? ""; if (!values.some(item => item.value === value)) node.selectedIndex = -1;
  }
  function renderSources(value = source.value) {
    const c = getContext(), names = new Map((c?.devices ?? []).map(device => [device.id, device.name]));
    const existing = shares.filter(share => share.owner_user_id === c?.userId);
    const savedSources = new Set(existing.map(share => share.source_runtime_id));
    const candidates = (c?.ownRuntimes ?? c?.runtimes ?? []).filter(runtime =>
      (!runtime.userId || runtime.userId === c.userId) && (!runtime.user_id || runtime.user_id === c.userId)
      && (!runtime.purpose || runtime.purpose === "execution") && ["codex", "deepseek-harness"].includes(runtime.harness) && runtime.status !== "revoked")
      .map(runtime => ({ key: runtime.id, runtime, supported: supportsAgentSharing(runtime),
        label: `${harnessLabel(runtime)} · ${names.get(runtime.deviceId ?? runtime.device_id) ?? runtime.deviceName ?? t("Shared device")}` }));
    const pinSource = !editor.hidden || mutation || attempt;
    const previous = sourceChoices.find(choice => choice.key === value);
    if (pinSource && previous && !candidates.some(choice => choice.key === value)) {
      candidates.push({ ...previous, missing: true, runtime: { ...previous.runtime, status: "offline", sharingAvailability: "offline", sharing_availability: "offline" } });
    }
    // Runtime IDs are per conversation. Present one unconfigured connection per
    // device/harness, but never hide a saved grant or silently retarget it.
    const groups = new Map();
    for (const choice of candidates) {
      const key = sourceConnectionKey(choice.runtime);
      const group = groups.get(key) ?? []; group.push(choice); groups.set(key, group);
    }
    sourceChoices = [];
    for (const group of groups.values()) {
      const saved = group.filter(choice => savedSources.has(choice.key));
      const pinned = pinSource ? group.find(choice => choice.key === value) : undefined;
      const rank = choice => (sourceReady(choice) ? 4 : 0) + (choice.runtime.status === "online" ? 2 : 0) + (choice.supported ? 1 : 0);
      const best = [...group].sort((a, b) => rank(b) - rank(a) || a.key.localeCompare(b.key))[0];
      const chosen = pinned ?? (saved.some(sourceReady) ? undefined : best);
      sourceChoices.push(...saved);
      if (chosen && !savedSources.has(chosen.key)) sourceChoices.push(chosen);
    }
    for (const share of existing) if (!sourceChoices.some(choice => choice.key === share.source_runtime_id)) {
      sourceChoices.push({ key: share.source_runtime_id, runtime: { id: share.source_runtime_id, ...share.execution_profile, status: "offline" },
        supported: false, label: `${harnessLabel(share.execution_profile)} · ${t("Device offline")}` });
    }
    // Two separately authorized devices may have the same default name. Keep
    // their exact identities and make the visible/accessibility names distinct.
    const labelCounts = new Map();
    for (const choice of sourceChoices) labelCounts.set(choice.label, (labelCounts.get(choice.label) ?? 0) + 1);
    const labelPositions = new Map();
    for (const choice of [...sourceChoices].sort((a, b) => a.key.localeCompare(b.key))) {
      const label = choice.label, position = (labelPositions.get(label) ?? 0) + 1; labelPositions.set(label, position);
      if (labelCounts.get(label) > 1) choice.label += ` · ${t("Connection {number}").replace("{number}", String(position))}`;
    }
    options(source, sourceChoices.map(choice => ({ value: choice.key, label: choice.label })), value);
  }
  function renderMembers(allowed = []) {
    const focus = members.contains(doc.activeElement) ? doc.activeElement.value : null; let restore;
    members.replaceChildren(); memberInputs.clear(); const c = getContext();
    for (const member of c?.members ?? []) {
      const id = memberId(member); if (!id || id === c.userId || member.role === "viewer") continue;
      const label = el("label", "", "sharing-member"), input = el("input"); input.type = "checkbox"; input.value = id; input.checked = allowed.includes(id);
      const avatar = el("span"); renderAvatar(doc, avatar, { userId: id, username: memberName(member), avatarId: member.avatar_id ?? member.avatarId });
      label.append(input, avatar, raw("span", memberName(member))); input.addEventListener("change", markDirty); members.append(label); memberInputs.set(id, input);
      if (focus === id) restore = input;
    }
    if (!memberInputs.size) members.append(el("p", "No eligible project members.", "field-help")); restore?.focus({ preventScroll: true });
  }
  function fillEditor(share) {
    renderSources(share?.source_runtime_id ?? source.value); renderMembers(share?.allowed_user_ids ?? []);
    callsInput.value = String((share?.limits ?? DEFAULT_SHARE_LIMITS).total_daily_calls);
    minutesInput.value = String((share?.limits ?? DEFAULT_SHARE_LIMITS).total_daily_seconds / 60);
  }
  function editorState() {
    state.textContent = selected?.enabled ? t("Sharing is on") : selected?.disabled_reason && selected.disabled_reason !== "manual"
      ? `${t("Sharing stopped automatically")} · ${sharingReason(selected.disabled_reason, t)}` : t("Sharing is off");
    state.dataset.enabled = String(Boolean(selected?.enabled));
    ownerUsage.textContent = selected?.total_usage ? usageText(selected.total_usage, selected.limits.total_daily_calls, selected.limits.total_daily_seconds) : "";
  }
  function usageText(value, calls, seconds) {
    return t("Today: {calls}/{call_limit} calls · {minutes}/{minute_limit} minutes")
      .replace("{calls}", () => String(value.calls)).replace("{call_limit}", () => String(calls))
      .replace("{minutes}", () => String(Math.ceil((value.seconds_used + value.seconds_reserved) / 60))).replace("{minute_limit}", () => String(seconds / 60));
  }
  function stopTarget(share, sourceId) {
    const pending = mutation ?? attempt;
    return Boolean(share?.enabled || pending?.sourceId === sourceId
      && (pending.kind === "control" || pending.kind === "save" && pending.input.enabled));
  }
  function setToggle(node, share, ready, sourceId) {
    const stopping = stopTarget(share, sourceId);
    node.textContent = t(stopping ? "Stop sharing" : "Start sharing"); node.dataset.enabled = String(stopping);
    node.setAttribute("aria-pressed", String(stopping));
    const stoppingNow = mutation?.kind === "control";
    const pending = mutation ?? attempt;
    node.disabled = !getContext()?.writable || stoppingNow || Boolean(pending) && (!stopping || pending.sourceId !== sourceId)
      || !stopping && !ready;
  }
  function updateControls() {
    const c = getContext(); button.disabled = !c?.projectId || !c?.userId;
    const choice = sourceChoices.find(item => item.key === source.value), ready = sourceReady(choice);
    source.disabled = Boolean(mutation || attempt || dirty) || !c?.writable;
    // One row is one configuration: changing Agent opens that Agent's own saved settings.
    for (const input of [...memberInputs.values(), callsInput, minutesInput]) input.disabled = Boolean(attempt) || !c?.writable;
    unsupported.hidden = Boolean(ready);
    unsupported.textContent = choice?.supported ? sharingReason(choice.runtime.sharingAvailability ?? choice.runtime.sharing_availability ?? "offline", t)
      : t("This connection does not support project-confined shared execution. Update or choose another connection.");
    refreshButton.disabled = readBusy;
    retry.hidden = !attempt; retry.disabled = Boolean(mutation) || !c?.writable;
    setToggle(toggle, selected, ready, source.value); editorState(); renderPicker();
  }
  function renderOwnList() {
    const focused = doc.activeElement?.dataset?.sourceId, focusedConnection = doc.activeElement?.dataset?.connectionKey; let restore;
    ownList.replaceChildren(); const c = getContext(), people = new Map((c?.members ?? []).map(member => [memberId(member), member]));
    empty.hidden = sourceChoices.length > 0;
    for (const choice of sourceChoices) {
      const share = shares.find(item => item.owner_user_id === c?.userId && item.source_runtime_id === choice.key);
      const row = el("li", "", "sharing-row"), edit = btn("", undefined, "sharing-edit"); edit.dataset.sourceId = choice.key;
      edit.dataset.connectionKey = sourceConnectionKey(choice.runtime);
      const details = el("span", "", "sharing-row-details"); details.append(raw("strong", choice.label),
        raw("small", [share?.enabled ? t("Sharing is on") : share?.disabled_reason ? sharingReason(share.disabled_reason, t) : t("Not shared"),
          choice.runtime.status === "online" ? t("Device online") : t("Device offline")].join(" · ")));
      const avatars = el("span", "", "sharing-avatar-stack"), allowed = share?.allowed_user_ids ?? [];
      if (!allowed.length) avatars.append(el("span", "Click to add recipients", "sharing-add-recipients"));
      for (const id of allowed.slice(0, 4)) {
        const member = people.get(id), avatar = el("span"); avatar.title = member ? memberName(member) : t("Project member");
        renderAvatar(doc, avatar, { userId: id, username: member ? memberName(member) : t("Project member"), avatarId: member?.avatar_id ?? member?.avatarId }); avatars.append(avatar);
      }
      if (allowed.length > 4) { const more = raw("span", "…", "sharing-avatar-more"); more.setAttribute("aria-label", `${t("Sharing recipients")}: ${allowed.length}`); avatars.append(more); }
      edit.append(details, avatars); edit.setAttribute("aria-label", `${choice.label} · ${t("Sharing recipients")}`);
      edit.disabled = Boolean(mutation || attempt) || !c?.writable;
      edit.addEventListener("click", () => beginEdit(choice.key));
      const smallToggle = btn("", undefined, "sharing-toggle sharing-toggle-compact"); setToggle(smallToggle, share, sourceReady(choice), choice.key);
      smallToggle.setAttribute("aria-label", `${smallToggle.textContent} · ${choice.label}`);
      smallToggle.addEventListener("click", () => {
        if (stopTarget(share, choice.key)) stopSharing(share, choice.key);
        else { beginEdit(choice.key); if (allowedIds().length) startSharing(); else { setStatus("Choose sharing recipients to start."); membersField.focus?.(); } }
      });
      row.append(edit, smallToggle); ownList.append(row);
      if (choice.key === focused || !restore && focusedConnection === edit.dataset.connectionKey) restore = edit;
    }
    restore?.focus({ preventScroll: true });
  }
  function beginEdit(key) {
    if (mutation || attempt || !getContext()?.writable || !loaded) return;
    if (dirty) { saveDraft(); return; }
    selected = shares.find(share => share.owner_user_id === getContext()?.userId && share.source_runtime_id === key) ?? null;
    source.value = key; dirty = false; requestedStart = false; draftVersion++; fillEditor(selected);
    overview.hidden = true; editor.hidden = false; setStatus(""); setError(""); updateControls(); source.focus();
  }
  function renderPicker() {
    const choice = selectedAgent(), profiles = choice ? shareProfiles(choice.share) : [];
    const models = profiles.map(profile => ({ value: modelKey(profile), label: `${profile.model} · ${profile.provider}` }));
    if (chosenModel && !models.some(item => item.value === chosenModel)) models.push({ value: chosenModel, label: t("Unavailable"), disabled: true });
    options(modelSelect, models, chosenModel);
    const profile = profiles.find(item => modelKey(item) === chosenModel), efforts = profile?.reasoning_efforts ?? [];
    const effortOptions = efforts.map(effort => ({ value: effort, label: t(effort) }));
    if (chosenEffort && !efforts.includes(chosenEffort)) effortOptions.push({ value: chosenEffort, label: t("Unavailable"), disabled: true });
    options(effortSelect, effortOptions, chosenEffort); effortField.hidden = !efforts.length && !chosenEffort;
    modelSelect.disabled = !getContext()?.writable || !choice?.available; effortSelect.disabled = modelSelect.disabled || !efforts.length;
    disclosure.textContent = sharedAgentDisclosure(choice?.share, getContext()?.sessionMode ?? getContext()?.mode, t); disclosure.hidden = !choice;
    usage.textContent = choice ? usageText(choice.share.usage, choice.share.limits.per_member_daily_calls, choice.share.limits.per_member_daily_seconds)
      : t("Choose a shared Agent");
  }
  function selectedChoice() {
    const choice = selectedAgent(); if (!choice) return null;
    const profile = shareProfiles(choice.share).find(item => modelKey(item) === chosenModel);
    if (!profile || chosenEffort && !profile.reasoning_efforts?.includes(chosenEffort)) return null;
    return { ...choice, target: { kind: "shared", share_id: choice.share.id, share_revision: choice.share.revision,
      harness: choice.share.execution_profile.harness, provider: profile.provider, model: profile.model,
      ...(chosenEffort ? { reasoning_effort: chosenEffort } : {}) } };
  }
  function cancelRead() { readController?.abort(); readController = null; readBusy = false; }
  function clear() {
    generation++; mutationEpoch++; cancelRead(); clearTimeout(autosaveTimer); mutationController?.abort(); mutationController = null;
    scope = ""; shares = []; selected = null; sourceChoices = []; selectedKey = ""; chosenModel = ""; chosenEffort = "";
    dirty = false; loaded = false; mutation = null; attempt = null; requestedStart = false; navigationIntent = null; clearNavigationDecision();
    if (dialog.open) dialog.close(); overview.hidden = false; editor.hidden = true; ownList.replaceChildren(); members.replaceChildren(); memberInputs.clear();
    source.replaceChildren(); setStatus(""); setError(""); updateControls();
  }
  function updateContext() {
    const c = getContext(), next = c?.scope ?? "";
    if (next !== scope) { clear(); scope = next; }
    renderSources();
    if (dialog.open) { const checked = allowedIds(); renderMembers(checked); renderOwnList(); }
    updateControls();
  }
  async function bounded(operation, controller) {
    let timer;
    try { return await Promise.race([operation(controller.signal), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("Sharing deadline"), { uncertain: true })); }, readDeadlineMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function refresh() {
    updateContext(); const c = getContext(); if (!c?.projectId || readBusy) return;
    const gen = generation, controller = new AbortController(); readController = controller; readBusy = true; updateControls();
    try {
      const result = await bounded(signal => api.listAgentShares(c.projectId, { signal }), controller);
      if (!current(gen, c) || controller.signal.aborted) return;
      shares = result.shares; loaded = true; renderSources(); renderOwnList();
      if (selected && !dirty && !attempt && !mutation) {
        selected = shares.find(share => share.id === selected.id) ?? null; if (!editor.hidden) fillEditor(selected);
      }
      if (!attempt) setError(""); onChange();
    } catch { if (current(gen, c) && (!controller.signal.aborted || readController === controller)) setError("Could not load shared Agents. Refresh and try again."); }
    finally { if (readController === controller) { readController = null; readBusy = false; if (current(gen, c)) updateControls(); } }
  }
  function markDirty() {
    if (attempt) return; navigationIntent = null; clearNavigationDecision(); dirty = true; draftVersion++; setStatus("Saving sharing settings…"); setError("");
    clearTimeout(autosaveTimer); autosaveTimer = setTimeout(saveDraft, autosaveDelayMs); updateControls();
  }
  function inputLimits() {
    const calls = Number(callsInput.value), minutes = Number(minutesInput.value);
    const seconds = Math.round(minutes * 60);
    if (!Number.isInteger(calls) || calls < 1 || calls > 10000 || !Number.isFinite(minutes)
      || seconds < 1 || minutes > 14400 || Math.abs(minutes * 60 - seconds) > .00001) return null;
    return { total_daily_calls: calls, total_daily_seconds: seconds, per_member_daily_calls: calls,
      per_member_daily_seconds: seconds, max_concurrent: 1, max_request_seconds: Math.min(720, seconds) };
  }
  function saveDraft() {
    clearTimeout(autosaveTimer); if (mutation || attempt || !dirty && !requestedStart || !getContext()?.writable) return;
    const choice = sourceChoices.find(item => item.key === source.value), limits = inputLimits(), allowed = allowedIds();
    if (!choice?.supported || choice.missing) {
      requestedStart = false; setStatus("Unsaved sharing changes"); setError("This Agent connection cannot save sharing settings. Reconnect a supported Agent, or discard the unsaved changes when leaving."); return;
    }
    if (!limits) {
      requestedStart = false; setStatus("Unsaved sharing changes"); setError("Enter 1 to 10,000 whole calls and a duration from 1 second to 14,400 minutes, in whole seconds."); return;
    }
    if (requestedStart && !allowed.length) {
      requestedStart = false; setStatus("Unsaved sharing changes"); setError("Choose sharing recipients to start."); return;
    }
    const enabled = Boolean((requestedStart || selected?.enabled) && allowed.length);
    if (enabled && !sourceReady(choice)) {
      requestedStart = false; setStatus("Unsaved sharing changes"); setError("The Agent is unavailable. Reconnect it before saving active sharing, or discard the unsaved changes when leaving."); return;
    }
    const intent = { kind: "save", version: draftVersion, sourceId: choice.key, input: {
      ...(selected ? { share_id: selected.id } : {}), source_runtime_id: choice.key, enabled, allowed_user_ids: allowed, limits,
      expected_revision: selected?.revision ?? null, idempotency_key: makeKey("agent-share-save") } };
    requestedStart = false; void perform(intent);
  }
  async function perform(intent) {
    const c = getContext();
    const revoking = intent.kind === "control" && intent.input.action === "disable";
    if (mutation && !revoking || !c?.writable || !current(generation, c)) return;
    if (revoking) { clearTimeout(autosaveTimer); mutationController?.abort(); attempt = null; requestedStart = false; }
    if (navigationDecision) { navigationIntent = null; clearNavigationDecision(); }
    cancelRead(); const gen = generation, epoch = ++mutationEpoch, controller = new AbortController();
    const active = () => current(gen, c) && epoch === mutationEpoch && mutation === intent;
    mutation = intent; mutationController = controller; setStatus(intent.kind === "save" ? "Saving sharing settings…" : "Updating sharing…"); setError(""); updateControls(); renderOwnList();
    try {
      const result = await bounded(async signal => {
        if (intent.kind === "save") return api.saveAgentShare(c.projectId, intent.input, { signal });
        // A create can already be accepted without its response (and ID) reaching
        // the browser. Discover by exact owner/source; never retry enable to stop.
        if (!intent.shareId) {
          const result = await api.listAgentShares(c.projectId, { signal });
          if (!active() || signal.aborted) throw Object.assign(new Error("Sharing stopped waiting"), { uncertain: true });
          intent.shareId = result.shares.find(share => share.owner_user_id === c.userId
            && share.source_runtime_id === intent.sourceId)?.id;
          if (!intent.shareId) throw Object.assign(new Error("Sharing acceptance is not confirmed"), { uncertain: true });
        }
        return api.controlAgentShare(c.projectId, intent.shareId, intent.input, { signal });
      }, controller);
      if (!active() || controller.signal.aborted) return;
      const share = result.share; shares = [...shares.filter(item => item.id !== share.id), share]; loaded = true; attempt = null;
      if (source.value === share.source_runtime_id) {
        selected = share;
        if (intent.kind === "save" && intent.version === draftVersion) { dirty = false; fillEditor(share); }
      }
      renderSources(); renderOwnList(); editorState(); setStatus(share.enabled ? "Sharing is on" : "Changes saved automatically"); onChange();
    } catch (failure) {
      if (!active()) return;
      navigationIntent = null; clearNavigationDecision();
      if (!failure?.status || failure.status >= 500 || failure.uncertain || failure.name === "AbortError") {
        attempt = intent; setStatus("Sharing update not confirmed"); setError("The sharing action is not confirmed. Check it before another action.");
      } else { attempt = null; dirty = false; requestedStart = false; setStatus(intent.kind === "save" ? "Unsaved sharing changes" : ""); setError(failure.status === 409
        ? "This sharing configuration changed. Refresh before editing." : "Could not update sharing. Refresh and try again."); }
    } finally {
      if (active()) { mutation = null; mutationController = null; updateControls(); renderOwnList();
        if (navigationIntent && !dirty && !attempt && !requestedStart && !errorSource) finishNavigation();
        if (!attempt && (dirty || requestedStart) && !errorSource) autosaveTimer = setTimeout(saveDraft, 0); }
    }
  }
  function startSharing() { navigationIntent = null; clearNavigationDecision(); requestedStart = true; saveDraft(); }
  function stopSharing(share = selected, sourceId = source.value) {
    if (!sourceId) return;
    navigationIntent = null; clearNavigationDecision();
    // An unconfirmed disable is retried with the same key and resolved identity.
    const previous = mutation ?? attempt;
    const intent = previous?.kind === "control" && previous.sourceId === sourceId ? previous
      : { kind: "control", sourceId, shareId: share?.id, input: { action: "disable", idempotency_key: makeKey("agent-share-disable") } };
    void perform(intent);
  }
  async function open() {
    updateContext(); if (button.disabled) return;
    returnFocus = doc.activeElement;
    if (!dialog.open) { navigationIntent = null; clearNavigationDecision(); overview.hidden = false; editor.hidden = true; dialog.showModal(); }
    await refresh();
  }
  function finishNavigation() {
    const intent = navigationIntent; navigationIntent = null; clearNavigationDecision();
    if (!intent || intent.generation !== generation || !dialog.open) return;
    if (intent.kind === "back" && intent.page === "editor") {
      overview.hidden = false; editor.hidden = true; renderOwnList(); refreshButton.focus(); return;
    }
    dialog.close();
    if (intent.kind === "exit") onExit();
  }
  function clearNavigationDecision() {
    navigationDecision = null; leaveConfirmation.hidden = true; leaveMessage.textContent = ""; footer.classList.toggle("sharing-footer-confirming", false);
  }
  function renderNavigationDecision() {
    if (!navigationDecision) return;
    leaveMessage.textContent = t(navigationDecision.message);
    discard.hidden = navigationDecision.mode !== "discard";
    leavePending.hidden = navigationDecision.mode !== "pending";
  }
  function showNavigationDecision(intent, mode, message, pending = null) {
    navigationDecision = { intent, mode, message, pending };
    leaveConfirmation.hidden = false; footer.classList.toggle("sharing-footer-confirming", true); renderNavigationDecision(); stay.focus();
  }
  function currentNavigationDecision(mode) {
    const decision = navigationDecision;
    return decision?.mode === mode && navigationIntent === decision.intent
      && decision.intent.generation === generation && scope === getContext()?.scope && dialog.open ? decision : null;
  }
  stay.addEventListener("click", () => {
    if (!navigationDecision) return;
    navigationIntent = null; clearNavigationDecision();
    (editor.hidden ? refreshButton : !callsInput.disabled ? callsInput : close).focus();
  });
  discard.addEventListener("click", () => {
    if (!currentNavigationDecision("discard") || mutation || attempt) return;
    // No request was sent for this draft. Discarding only clears local edits;
    // it must never stand in for cancelling or rolling back a server mutation.
    clearTimeout(autosaveTimer); dirty = false; requestedStart = false; setStatus(""); setError("");
    finishNavigation();
  });
  leavePending.addEventListener("click", () => {
    const decision = currentNavigationDecision("pending");
    if (!decision || (mutation ?? attempt) !== decision.pending) return;
    // Keep the in-flight request/frozen receipt and key. Reopening the panel
    // exposes its original recovery action instead of silently retrying it.
    finishNavigation();
  });
  function requestNavigation(kind) {
    if (!dialog.open) return;
    const previous = navigationIntent, pending = mutation ?? attempt;
    const waitingForSave = mutation && previous && !navigationDecision;
    const intent = navigationIntent = { kind, generation, page: editor.hidden ? "overview" : "editor" };
    if (pending) {
      // Escape/Back may replace an exit already waiting for the same save.
      if (waitingForSave && kind === "back") return;
      showNavigationDecision(intent, "pending", "A sharing update is pending or unconfirmed. Leave this page for now? This does not cancel it or stop sharing. Use Check the last sharing action to recover the result.", pending);
      return;
    }
    if ((dirty || requestedStart) && !getContext()?.writable) {
      setStatus("Unsaved sharing changes");
      showNavigationDecision(intent, "discard", "You no longer have permission to save these sharing changes. Discard your unsaved changes and leave this page?");
      return;
    }
    if (dirty || requestedStart) {
      saveDraft();
      if (!mutation && !attempt && errorSource) {
        showNavigationDecision(intent, "discard", "These sharing changes could not be saved. Discard the unsaved changes and leave this page? Stay here to keep editing.");
      }
      return;
    }
    finishNavigation();
  }
  function selectAgent(key) {
    selectedKey = key ?? ""; const choice = selectedAgent(), profile = choice && defaultProfile(choice.share);
    chosenModel = profile ? modelKey(profile) : ""; chosenEffort = profile?.reasoning_effort ?? "";
    renderPicker(); onChange();
  }
  modelSelect.addEventListener("change", () => {
    chosenModel = modelSelect.value; const profile = shareProfiles(selectedAgent()?.share ?? { execution_profiles: [] }).find(item => modelKey(item) === chosenModel);
    chosenEffort = profile?.default_reasoning_effort ?? profile?.reasoning_efforts?.[0] ?? ""; renderPicker(); onChange();
  });
  effortSelect.addEventListener("change", () => { chosenEffort = effortSelect.value; renderPicker(); onChange(); });
  button.addEventListener("click", () => void open());
  dialog.addEventListener("cancel", event => { event.preventDefault(); requestNavigation("back"); });
  dialog.addEventListener("close", () => { navigationIntent = null; clearNavigationDecision(); cancelRead(); returnFocus?.focus?.({ preventScroll: true }); });
  refreshButton.addEventListener("click", () => void refresh());
  editor.addEventListener("submit", event => { event.preventDefault(); startSharing(); });
  source.addEventListener("change", () => beginEdit(source.value));
  for (const input of [callsInput, minutesInput]) input.addEventListener("input", markDirty);
  toggle.addEventListener("click", () => stopTarget(selected, source.value) ? stopSharing() : startSharing());
  retry.addEventListener("click", () => { if (attempt && !mutation) void perform(attempt); });
  for (const update of translations) update();
  return { elements: { button, dialog, picker }, updateContext, clear, refresh, open, agents: borrowed,
    selected: selectedChoice, selectionKey: () => selectedKey, select: selectAgent,
    disclosure: mode => selectedAgent() ? sharedAgentDisclosure(selectedAgent().share, mode ?? getContext()?.sessionMode ?? getContext()?.mode, t)
      : t(borrowed().length ? "Choose a shared Agent" : "No shared Agent is available in this project."),
    refreshLanguage() { for (const update of translations) update(); setStatus(statusSource); setError(errorSource);
      renderSources(); renderOwnList(); if (!editor.hidden) renderMembers(allowedIds()); updateControls(); renderNavigationDecision(); },
  };
}
