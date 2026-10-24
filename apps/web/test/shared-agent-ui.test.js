import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SHARE_LIMITS, mountSharedAgents, sharedAgentChoices, sharedAgentDisclosure,
  sharedAgentKey, supportsAgentSharing } from "../src/shared-agent-view.js";

class Element {
  constructor(doc, tag = "div") {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {};
    this.listeners = new Map(); this.value = ""; this.hidden = false; this.disabled = false; this.checked = false;
    this.className = ""; this.textContent = ""; this.open = false;
    this.classList = { add: (...values) => { this.className += ` ${values.join(" ")}`; },
      toggle: (value, enabled) => { this.className = this.className.split(/\s+/u).filter(item => item !== value).join(" "); if (enabled) this.className += ` ${value}`; } };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, callback) { const entries = this.listeners.get(type) ?? []; entries.push(callback); this.listeners.set(type, entries); }
  dispatch(type, values = {}) { const event = { target: this, preventDefault() {}, ...values }; for (const listener of this.listeners.get(type) ?? []) listener(event); }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() { this.doc.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
  remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
}
const capability = { version: 1, isolated: true, project_only: true, cancellation: true, liveness_watchdog: true };
const runtime = { id: "runtime-a", userId: "alice", deviceId: "device-a", harness: "codex", purpose: "execution", status: "online",
  provider: "openai", model: "fixture-model", sharingCapability: capability, sharingAvailability: "ready",
  executionProfiles: [{ provider: "openai", model: "fixture-model", reasoningEfforts: ["high"] }] };
const profile = { harness: "codex", provider: "openai", model: "fixture-model", reasoning_effort: "high" };
const usage = { utc_day: "2026-10-15", calls: 2, seconds_used: 60, seconds_reserved: 120, active_jobs: 0 };
const grant = { id: "share-a", project_id: "project-a", owner_user_id: "alice", owner_display_name: "Alice", owner_avatar_id: null,
  revision: 1, enabled: true, available: true, disabled_reason: null, execution_profile: profile, limits: DEFAULT_SHARE_LIMITS, usage,
  total_usage: usage, allowed_user_ids: ["bob"], source_runtime_id: "runtime-a", owner_device_id: "device-a",
  created_at: "2026-10-15T00:00:00.000Z", updated_at: "2026-10-15T00:00:00.000Z" };
const flush = async () => { for (let index = 0; index < 18; index++) await Promise.resolve(); };
function fixture({ initial = [], overrides = {}, deadline = 8000, patch = {}, autosave = 0 } = {}) {
  const doc = { activeElement: null, documentElement: { lang: "en" }, createElement: tag => new Element(doc, tag),
    createElementNS: (_namespace, tag) => new Element(doc, tag) };
  doc.body = new Element(doc, "body");
  doc.getElementById = id => {
    const find = node => node.id === id ? node : node.children.map(find).find(Boolean);
    return find(doc.body);
  };
  let context = { scope: "alice:project-a:session-a", userId: "alice", projectId: "project-a", sessionId: "session-a", mode: "multi", writable: true,
    ownRuntimes: [runtime], devices: [{ id: "device-a", name: "Alice Mac" }], members: [
      { userId: "alice", username: "Alice", role: "owner" }, { userId: "bob", username: "Bob", role: "participant" },
      { userId: "viewer", username: "Viewer", role: "viewer" }], ...patch };
  let shares = initial.map(value => structuredClone(value)), counter = 0; const calls = []; let changes = 0, exits = 0;
  const api = {
    listAgentShares: async () => ({ shares: structuredClone(shares) }),
    saveAgentShare: async (project, input) => { calls.push(["save", project, structuredClone(input)]);
      const share = { ...structuredClone(grant), id: input.share_id ?? "created-share", revision: input.expected_revision === null ? 1 : input.expected_revision + 1,
        enabled: Boolean(input.enabled), available: Boolean(input.enabled), disabled_reason: input.enabled ? null : "manual", execution_profile: input.execution_profile ?? profile,
        limits: input.limits, allowed_user_ids: input.allowed_user_ids, source_runtime_id: input.source_runtime_id };
      shares = [...shares.filter(value => value.id !== share.id), share]; return { share }; },
    controlAgentShare: async (project, id, input) => { calls.push(["control", project, id, structuredClone(input)]);
      const share = shares.find(value => value.id === id); share.enabled = input.action === "enable"; share.available = share.enabled;
      share.disabled_reason = share.enabled ? null : "manual"; share.revision++; return { share: structuredClone(share) }; },
    ...overrides,
  };
  const ui = mountSharedAgents({ document: doc, api, localizer: { t: value => value }, getContext: () => context,
    makeKey: kind => `${kind}-fixture-${++counter}`, onChange: () => changes++, onExit: () => exits++,
    readDeadlineMs: deadline, autosaveDelayMs: autosave });
  doc.body.append(ui.elements.button, ui.elements.picker);
  ui.updateContext();
  return { ui, doc, api, calls, el: id => doc.getElementById(`agent-sharing-${id}`),
    update(value) { context = { ...context, ...value }; ui.updateContext(); }, get context() { return context; },
    set shares(value) { shares = value; }, get changes() { return changes; }, get exits() { return exits; } };
}

const wait = async () => { await new Promise(resolve => setTimeout(resolve, 8)); await flush(); };
const openEditor = async f => { await f.ui.open(); f.el("list").children[0].children[0].click(); };
const checkBob = f => { const input = f.el("members").children[0].children[0]; input.checked = true; input.dispatch("change"); };

test("session runtimes on one device form one unconfigured Agent, without merging devices or grants", async () => {
  const second = { ...runtime, id: "runtime-b", sessionId: "session-b", status: "offline", sharingAvailability: "offline" };
  const f = fixture({ patch: { ownRuntimes: [second, runtime] } });
  await f.ui.open();
  assert.equal(f.el("list").children.length, 1);
  assert.equal(f.el("list").children[0].children[0].dataset.sourceId, "runtime-a");

  const separate = fixture({ patch: { ownRuntimes: [runtime, { ...second, deviceId: "device-b" }],
    devices: [{ id: "device-a", name: "Mac Launcher" }, { id: "device-b", name: "Mac Launcher" }] } });
  await separate.ui.open();
  const labels = separate.el("list").children.map(row => row.children[0].attributes["aria-label"]);
  assert.equal(labels.length, 2);
  assert.notEqual(labels[0], labels[1]);

  const saved = fixture({ initial: [grant, { ...grant, id: "share-b", source_runtime_id: "runtime-b" }],
    patch: { ownRuntimes: [runtime, second] } });
  await saved.ui.open();
  assert.equal(saved.el("list").children.length, 2);
  assert.ok(saved.el("list").children.every(row => !row.children[1].disabled));
});

test("an unconfigured editor retains its exact offline source and representative changes preserve focus", async () => {
  const second = { ...runtime, id: "runtime-b" };
  const f = fixture({ patch: { ownRuntimes: [runtime, second] } });
  await openEditor(f);
  f.update({ ownRuntimes: [second] });
  assert.equal(f.el("source").value, "runtime-a");
  assert.ok(f.el("source").children.some(option => option.value === "runtime-a"));
  assert.equal(f.el("toggle").disabled, true);
  const list = fixture({ patch: { ownRuntimes: [runtime, { ...second, status: "offline" }] } });
  await list.ui.open();
  list.el("list").children[0].children[0].focus();
  list.update({ ownRuntimes: [{ ...runtime, status: "offline" }, second] });
  assert.equal(list.el("list").children[0].children[0].dataset.sourceId, "runtime-b");
  assert.equal(list.doc.activeElement, list.el("list").children[0].children[0]);
});

test("complete confinement/cancellation/liveness capabilities are required", () => {
  assert.equal(supportsAgentSharing(runtime), true);
  for (const key of Object.keys(capability)) { const missing = structuredClone(runtime); delete missing.sharingCapability[key]; assert.equal(supportsAgentSharing(missing), false); }
  assert.equal(supportsAgentSharing({ ...runtime, harness: "claude-code" }), false);
});
test("overview includes unsaved connected Agents once, without model/effort duplicates or nested buttons", async () => {
  const f = fixture({ patch: { ownRuntimes: [{ ...runtime, executionProfiles: [
    { provider: "openai", model: "one", reasoningEfforts: ["low", "high"] }, { provider: "openai", model: "two" }] },
    { ...runtime, id: "dsh", harness: "deepseek-harness" }] } });
  await f.ui.open(); assert.equal(f.el("list").children.length, 2);
  const row = f.el("list").children[0]; assert.equal(row.children.length, 2);
  assert.equal(row.children[0].tagName, "BUTTON"); assert.equal(row.children[1].tagName, "BUTTON");
  assert.equal(row.children[0].children[1].children[0].textContent, "Click to add recipients");
  assert.equal(f.el("new"), undefined); assert.equal(f.el("save"), undefined);
  row.children[0].click(); assert.equal(f.el("overview").hidden, true); assert.equal(f.el("editor").hidden, false);
  assert.equal(f.el("source").children.length, 2); assert.ok(f.el("source").children.every(option => option.value));
  f.ui.elements.dialog.close();
});
test("recipients and budgets autosave; start flushes the latest draft and synchronizes both green/red toggles", async () => {
  const f = fixture({ autosave: 1000 }); await openEditor(f);
  assert.equal(f.el("members").children.length, 1); checkBob(f);
  f.el("total_daily_calls").value = "55"; f.el("total_daily_calls").dispatch("input");
  f.el("toggle").click(); await flush();
  assert.equal(f.calls.length, 1); const input = f.calls[0][2];
  assert.equal(input.enabled, true); assert.equal(input.execution_profile, undefined); assert.deepEqual(input.allowed_user_ids, ["bob"]);
  assert.equal(input.limits.total_daily_calls, 55); assert.equal(input.limits.per_member_daily_calls, 55);
  assert.equal(input.limits.total_daily_seconds, 18000); assert.equal(input.limits.max_request_seconds, 720);
  assert.equal(f.el("toggle").textContent, "Stop sharing"); assert.equal(f.el("toggle").dataset.enabled, "true");
  assert.equal(f.el("list").children[0].children[1].textContent, "Stop sharing");
  f.el("toggle").click(); await flush(); assert.equal(f.calls[1][3].action, "disable");
  assert.equal(f.el("toggle").textContent, "Start sharing"); assert.equal(f.el("list").children[0].children[1].dataset.enabled, "false");
  assert.equal(f.el("members").children[0].children[0].checked, true); f.ui.elements.dialog.close();
});
test("edits autosave without enabling, duplicate configs, a save button, or an acceptance invitation", async () => {
  const f = fixture(); await openEditor(f); checkBob(f); await wait();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].enabled, false); assert.equal(f.el("status").textContent, "Changes saved automatically");
  f.el("total_daily_seconds").value = "60"; f.el("total_daily_seconds").dispatch("input"); await wait();
  assert.equal(f.calls[1][2].share_id, "created-share"); assert.equal(f.calls[1][2].expected_revision, 1);
  assert.equal(f.calls[1][2].limits.total_daily_seconds, 3600); assert.equal(f.el("list").children.length, 1); f.ui.elements.dialog.close();
});
test("removing the final recipient autosaves an empty disabled configuration", async () => {
  const f = fixture({ initial: [grant] }); await openEditor(f);
  const input = f.el("members").children[0].children[0]; input.checked = false; input.dispatch("change"); await wait();
  assert.deepEqual(f.calls[0][2].allowed_user_ids, []); assert.equal(f.calls[0][2].enabled, false);
  assert.equal(f.el("toggle").textContent, "Start sharing"); f.ui.elements.dialog.close();
});
test("typing during an autosave coalesces against the confirmed revision and start waits for latest configuration", async () => {
  let resolve, first = true;
  const f = fixture({ initial: [grant], overrides: { saveAgentShare: async (_p, input) => {
    f.calls.push(["save", _p, structuredClone(input)]);
    if (first) { first = false; await new Promise(done => { resolve = done; }); }
    return { share: { ...grant, revision: input.expected_revision + 1, limits: input.limits, enabled: input.enabled } };
  } } });
  await openEditor(f); f.el("total_daily_calls").value = "40"; f.el("total_daily_calls").dispatch("input"); await wait();
  f.el("total_daily_calls").value = "41"; f.el("total_daily_calls").dispatch("input"); resolve(); await wait();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1][2].expected_revision, 2); assert.equal(f.calls[1][2].limits.total_daily_calls, 41);
  assert.equal(f.el("total_daily_calls").value, "41"); f.ui.elements.dialog.close();
});
test("missing replies retry frozen autosave with the same idempotency key", async () => {
  const inputs = []; let reject = true;
  const f = fixture({ initial: [grant], overrides: { saveAgentShare: async (_p, input) => { inputs.push(structuredClone(input));
    if (reject) { reject = false; throw new Error("dropped receipt"); } return { share: { ...grant, revision: 2, limits: input.limits } }; } } });
  await openEditor(f); f.el("total_daily_calls").value = "30"; f.el("total_daily_calls").dispatch("input"); await wait();
  assert.equal(f.el("retry").hidden, false); f.el("retry").click(); await flush();
  assert.deepEqual(inputs[0], inputs[1]); assert.equal(f.el("retry").hidden, true); f.ui.elements.dialog.close();
});
test("a pending live autosave or list read cannot block immediate stop; late save receipts cannot re-enable", async () => {
  let resolve;
  const f = fixture({ initial: [grant], overrides: { saveAgentShare: async () => new Promise(done => { resolve = done; }) } });
  await openEditor(f); f.el("total_daily_calls").value = "22"; f.el("total_daily_calls").dispatch("input"); await wait();
  assert.equal(f.el("toggle").disabled, false); f.el("toggle").click(); await flush();
  resolve({ share: { ...grant, revision: 2 } }); await flush();
  assert.equal(f.el("toggle").textContent, "Start sharing"); assert.equal(f.el("state").textContent, "Sharing is off"); f.ui.clear();
});
test("invalid budgets never write; offline editing may save while starting remains unavailable", async () => {
  const f = fixture({ patch: { ownRuntimes: [{ ...runtime, sharingAvailability: "offline" }] } });
  await openEditor(f); f.el("total_daily_calls").value = "0"; f.el("total_daily_calls").dispatch("input"); await wait(); assert.equal(f.calls.length, 0);
  assert.equal(f.el("toggle").disabled, true); f.el("total_daily_calls").value = "12"; f.el("total_daily_calls").dispatch("input"); await wait();
  assert.equal(f.calls[0][2].enabled, false); assert.equal(f.el("toggle").disabled, true); f.ui.elements.dialog.close();
});
test("borrowers choose their advertised model/effort independently; all dropdown options are real values", async () => {
  const shared = { ...grant, execution_profiles: [{ provider: "openai", model: "fixture-model", reasoning_efforts: ["low", "high"], default_reasoning_effort: "high" },
    { provider: "other", model: "model-two", reasoning_efforts: ["medium", "max"] }] };
  const f = fixture({ initial: [shared], patch: { userId: "bob", scope: "bob:project-a:solo", mode: "solo" } });
  await f.ui.refresh(); assert.equal(f.ui.agents().length, 1); f.ui.select(sharedAgentKey(shared));
  assert.deepEqual(f.ui.selected().target, { kind: "shared", share_id: grant.id, share_revision: 1, ...profile });
  f.el("model").value = JSON.stringify(["other", "model-two"]); f.el("model").dispatch("change");
  f.el("effort").value = "max"; f.el("effort").dispatch("change");
  assert.equal(f.ui.selected().target.model, "model-two"); assert.equal(f.ui.selected().target.reasoning_effort, "max");
  assert.match(f.el("disclosure").textContent, /Alice's device/u);
  for (const id of ["model", "effort"]) assert.ok(f.el(id).children.every(option => option.value));
  f.shares = [{ ...shared, execution_profiles: [shared.execution_profiles[0]] }]; await f.ui.refresh();
  assert.equal(f.ui.selected(), null, "removed model never silently falls back");
  f.shares = [{ ...shared, revision: 2 }]; await f.ui.refresh(); assert.equal(f.ui.selected(), null, "changed grant never substitutes a new revision");
});
test("avatar overflow, member names, focus and Chinese labels stay accessible", async () => {
  const people = Array.from({ length: 6 }, (_, i) => ({ userId: i ? `member-${i}` : "bob", username: i ? `成员${i}` : "<script>fixture</script>", role: "participant" }));
  const f = fixture({ initial: [{ ...grant, allowed_user_ids: people.map(member => member.userId) }], patch: { members: people } });
  f.doc.documentElement.lang = "zh-CN"; f.ui.refreshLanguage(); await openEditor(f);
  const avatars = f.el("list").children[0].children[0].children[1]; assert.equal(avatars.children.length, 5); assert.equal(avatars.children[4].textContent, "…");
  assert.equal(f.el("members").children[0].children[2].textContent, "<script>fixture</script>");
  const input = f.el("members").children[0].children[0]; input.focus(); f.ui.updateContext(); assert.equal(f.doc.activeElement.value, "bob");
  assert.equal(f.el("toggle").textContent, "停止共享"); assert.equal(f.el("close").attributes["aria-label"], "关闭 Agent 共享面板"); f.ui.elements.dialog.close();
});
test("stale account reads and in-flight autosaves cannot populate another account", async () => {
  let resolve; const f = fixture({ overrides: { listAgentShares: () => new Promise(done => { resolve = done; }) } });
  const opening = f.ui.open(); f.update({ scope: "bob:other", userId: "bob", projectId: "project-b" }); resolve({ shares: [grant] }); await opening;
  assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.ui.agents().length, 0); assert.equal(f.el("list").children.length, 0);
});
test("close waits for the latest autosave instead of hiding an unconfirmed change", async () => {
  let resolve; const f = fixture({ initial: [grant], overrides: { saveAgentShare: async (_p, input) => {
    await new Promise(done => { resolve = done; }); return { share: { ...grant, revision: 2, limits: input.limits } };
  } } });
  await openEditor(f); f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input");
  f.el("close").click(); await flush(); assert.equal(f.ui.elements.dialog.open, true);
  resolve(); await flush(); assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 1);
});
test("overview Back returns to Agent management while the corner close exits to the workspace", async () => {
  const f = fixture(); await f.ui.open();
  assert.match(f.el("overview-back").className, /agent-dialog-back/u);
  assert.equal(f.el("overview-back").children[0].tagName, "SVG");
  assert.match(f.el("close").className, /workspace-icon-button/u);
  assert.equal(f.el("close").children[0].tagName, "SVG");
  f.el("overview-back").click(); assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 0);
  await f.ui.open(); f.el("close").click(); assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 1);
});
test("editor Back and Escape return one level at a time without exiting the workspace", async () => {
  const f = fixture(); await openEditor(f);
  f.el("back").click(); assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("overview").hidden, false);
  f.el("list").children[0].children[0].click(); let prevented = 0;
  f.ui.elements.dialog.dispatch("cancel", { preventDefault() { prevented++; } });
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("editor").hidden, true);
  f.ui.elements.dialog.dispatch("cancel", { preventDefault() { prevented++; } });
  assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 0); assert.equal(prevented, 2);
});
test("Back waits for a valid autosave before leaving the editor", async () => {
  let release; const f = fixture({ autosave: 1000, initial: [grant], overrides: { saveAgentShare: async (_p, input) => {
    await new Promise(resolve => { release = resolve; }); return { share: { ...grant, revision: 2, limits: input.limits } };
  } } });
  await openEditor(f); f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input");
  f.el("back").click(); await flush(); assert.equal(f.el("editor").hidden, false); assert.equal(f.ui.elements.dialog.open, true);
  release(); await flush(); assert.equal(f.el("editor").hidden, true); assert.equal(f.el("overview").hidden, false);
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.exits, 0); f.ui.clear();
});
test("Escape replaces a pending exit with a return to the previous page", async () => {
  let release; const f = fixture({ autosave: 1000, initial: [grant], overrides: { saveAgentShare: async (_p, input) => {
    await new Promise(resolve => { release = resolve; }); return { share: { ...grant, revision: 2, limits: input.limits } };
  } } });
  await openEditor(f); f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input");
  f.el("close").click(); await flush(); f.ui.elements.dialog.dispatch("cancel"); release(); await flush();
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("overview").hidden, false); assert.equal(f.exits, 0); f.ui.clear();
});
test("editing after a queued exit cancels that navigation before either save receipt arrives", async () => {
  let release, first = true;
  const f = fixture({ autosave: 1000, initial: [grant], overrides: { saveAgentShare: async (_p, input) => {
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return { share: { ...grant, revision: input.expected_revision + 1, limits: input.limits } };
  } } });
  await openEditor(f); f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input");
  f.el("close").click(); await flush(); f.el("total_daily_calls").value = "26"; f.el("total_daily_calls").dispatch("input");
  release(); await wait(); assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("editor").hidden, false); assert.equal(f.exits, 0); f.ui.clear();
});
test("an unconfirmed save keeps navigation visible and retry cannot later execute an obsolete exit", async () => {
  let first = true; const f = fixture({ autosave: 1000, initial: [grant], overrides: { saveAgentShare: async (_p, input) => {
    if (first) { first = false; throw Error("lost save response"); }
    return { share: { ...grant, revision: 2, limits: input.limits } };
  } } });
  await openEditor(f); f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input"); f.el("close").click(); await flush();
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("editor").hidden, false); assert.equal(f.exits, 0);
  assert.equal(f.el("retry").hidden, false); assert.match(f.el("error").textContent, /not confirmed/u);
  f.el("retry").click(); await flush(); assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.exits, 0);
  f.el("close").click(); assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 1);
});
test("invalid fields and subsequent valid autosaves cannot execute an earlier rejected exit", async () => {
  const f = fixture({ autosave: 1000, initial: [{ ...grant, enabled: false, available: false }] }); await openEditor(f);
  f.el("total_daily_calls").value = "0"; f.el("total_daily_calls").dispatch("input"); f.el("close").click();
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.calls.length, 0); assert.equal(f.exits, 0);
  f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input");
  assert.equal(f.el("leave-confirmation").hidden, true, "continued editing retires the old discard choice");
  f.el("leave-discard").click(); f.el("toggle").click(); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].enabled, true);
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.exits, 0); f.ui.clear();
});
test("a pending exit cannot close another account's interface after its save settles", async () => {
  let release; const f = fixture({ autosave: 1000, initial: [grant], overrides: { saveAgentShare: async (_p, input) => {
    await new Promise(resolve => { release = resolve; }); return { share: { ...grant, revision: 2, limits: input.limits } };
  } } });
  await openEditor(f); f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input");
  f.el("close").click(); await flush(); f.update({ scope: "bob:project-b:session-b", userId: "bob", projectId: "project-b", sessionId: "session-b" });
  await f.ui.open(); release(); await flush(); assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.exits, 0); f.ui.clear();
});
test("permission loss offers a local-only discard choice for Back and workspace exit", async () => {
  for (const action of ["back", "close"]) {
    const f = fixture({ autosave: 30, initial: [grant] });
    f.doc.documentElement.lang = "zh-CN"; f.ui.refreshLanguage(); await openEditor(f);
    f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input"); f.update({ writable: false });
    assert.equal(f.el("total_daily_calls").disabled, true);
    f.el(action).click(); assert.equal(f.el("leave-confirmation").hidden, false);
    assert.match(f.el("leave-message").textContent, /无权保存.*放弃未保存/u);
    f.el("leave-stay").click(); assert.equal(f.el("leave-confirmation").hidden, true);
    assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("editor").hidden, false); assert.equal(f.exits, 0);
    f.el(action).click(); f.el("leave-discard").click();
    assert.equal(f.el("editor").hidden, action === "back");
    assert.equal(f.ui.elements.dialog.open, action === "back"); assert.equal(f.exits, action === "close" ? 1 : 0);
    f.update({ writable: true }); await new Promise(resolve => setTimeout(resolve, 40)); await flush();
    assert.equal(f.calls.length, 0, "discard cannot write later if permission is restored"); f.ui.clear();
  }
});
test("permission loss permits leaving but keeps the unconfirmed request fenced until reauthorized recovery", async () => {
  let release, first = true; const inputs = [];
  const f = fixture({ autosave: 1000, initial: [grant],
    overrides: { saveAgentShare: async (_p, input) => {
      inputs.push(structuredClone(input));
      if (first) { first = false; await new Promise(resolve => { release = resolve; }); throw Error("unconfirmed save"); }
      return { share: { ...grant, revision: 2, limits: input.limits } };
    } } });
  await openEditor(f); f.el("total_daily_calls").value = "25"; f.el("total_daily_calls").dispatch("input");
  f.el("close").click(); await flush(); f.update({ writable: false });
  f.el("back").click(); assert.equal(f.el("leave-confirmation").hidden, true, "Back can still wait for the already pending save");
  f.el("close").click(); f.el("leave-pending").click();
  assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 1);
  release(); await flush(); await f.ui.open();
  assert.equal(f.el("retry").hidden, false); assert.equal(f.el("retry").disabled, true);
  f.el("retry").click(); await flush(); assert.equal(inputs.length, 1, "revoked write permission cannot recover by mutation");
  f.update({ writable: true }); f.el("retry").click(); await flush();
  assert.equal(inputs.length, 2); assert.deepEqual(inputs[0], inputs[1], "leaving did not discard or replace the accepted identity");
  assert.equal(f.el("retry").hidden, true); assert.equal(f.ui.elements.dialog.open, true); f.ui.clear();
});
test("a pending read never blocks the saved Agent's immediate stop button", async () => {
  const f = fixture({ initial: [grant], deadline: 5 }); await openEditor(f);
  f.api.listAgentShares = () => new Promise(() => {}); const reading = f.ui.refresh();
  assert.equal(f.el("toggle").disabled, false); f.el("toggle").click(); await flush();
  assert.equal(f.calls[0][3].action, "disable"); assert.equal(f.el("toggle").textContent, "Start sharing");
  await reading; f.ui.clear();
});
test("invalid unsaved fields stay editable when Back is clicked", async () => {
  const f = fixture(); await openEditor(f); f.el("total_daily_calls").value = "0"; f.el("total_daily_calls").dispatch("input");
  f.el("back").click(); assert.equal(f.el("editor").hidden, false); assert.equal(f.el("overview").hidden, true);
  assert.equal(f.calls.length, 0); f.ui.clear();
});

for (const existing of [false, true]) for (const expired of [false, true]) {
  test(`uncertain enable is independently stoppable: ${existing ? "saved grant" : "first create"}, ${expired ? "lost receipt" : "in-flight receipt"}`, async () => {
    let release, accepted;
    const f = fixture({ initial: existing ? [{ ...grant, enabled: false }] : [], deadline: 5, autosave: 1000,
      overrides: { saveAgentShare: async (_project, input) => {
        f.calls.push(["save", _project, structuredClone(input)]);
        accepted = { ...grant, id: input.share_id ?? "accepted-new-share", revision: existing ? 2 : 1, enabled: true };
        f.shares = [accepted]; return new Promise(resolve => { release = resolve; });
      } } });
    await openEditor(f); if (!existing) checkBob(f);
    f.el("toggle").click(); await flush();
    if (expired) { await wait(); assert.equal(f.el("retry").hidden, false); }
    assert.equal(f.el("toggle").textContent, "Stop sharing"); assert.equal(f.el("toggle").disabled, false);
    const rowToggle = f.el("list").children[0].children[1];
    assert.equal(rowToggle.textContent, "Stop sharing"); assert.equal(rowToggle.disabled, false);
    // Exercise both action dispatchers, including the row with no saved ID.
    (expired ? rowToggle : f.el("toggle")).click(); await flush();
    const stopped = f.calls.find(call => call[0] === "control");
    assert.equal(stopped[2], accepted.id); assert.equal(stopped[3].action, "disable");
    release({ share: { ...accepted, enabled: true } }); await flush();
    assert.equal(f.el("toggle").textContent, "Start sharing"); assert.equal(f.el("state").textContent, "Sharing is off");
    f.ui.clear();
  });
}

test("first-create Stop stays recoverable until acceptance is discoverable and never retries the enable", async () => {
  let release; const f = fixture({ autosave: 1000, overrides: {
    saveAgentShare: async (_p, input) => { f.calls.push(["save", _p, input]); return new Promise(resolve => { release = resolve; }); },
  } });
  await openEditor(f); checkBob(f); f.el("toggle").click(); await flush();
  f.el("toggle").click(); await flush();
  assert.equal(f.el("retry").hidden, false); assert.equal(f.el("toggle").textContent, "Stop sharing");
  assert.equal(f.calls.filter(call => call[0] === "control").length, 0, "missing grant must not be reported as stopped");
  f.shares = [{ ...grant, id: "late-accepted-create" }]; release({ share: { ...grant, id: "late-accepted-create" } }); await flush();
  f.el("toggle").click(); await flush();
  assert.equal(f.calls.filter(call => call[0] === "save").length, 1, "Stop discovery never resubmits an enable");
  assert.equal(f.calls.find(call => call[0] === "control")[2], "late-accepted-create");
  assert.equal(f.el("toggle").textContent, "Start sharing"); f.ui.clear();
});

test("lost owner Stop acknowledgement retries the same disable key", async () => {
  const f = fixture({ initial: [grant] }), control = f.api.controlAgentShare; let drop = true;
  f.api.controlAgentShare = async (...args) => { const result = await control(...args);
    if (drop) { drop = false; throw new Error("Lost disable receipt"); } return result; };
  await openEditor(f); f.el("toggle").click(); await flush();
  assert.equal(f.el("toggle").textContent, "Stop sharing"); assert.equal(f.el("toggle").disabled, false);
  f.el("toggle").click(); await flush();
  const controls = f.calls.filter(call => call[0] === "control");
  assert.equal(controls.length, 2); assert.equal(controls[0][3].idempotency_key, controls[1][3].idempotency_key);
  assert.equal(f.el("toggle").textContent, "Start sharing"); f.ui.clear();
});

for (const [label, configure] of [
  ["zero call limit", f => { f.el("total_daily_calls").value = "0"; }],
  ["empty call limit", f => { f.el("total_daily_calls").value = ""; }],
  ["fractional call limit", f => { f.el("total_daily_calls").value = "1.5"; }],
  ["call limit above maximum", f => { f.el("total_daily_calls").value = "10001"; }],
  ["fractional second limit", f => { f.el("total_daily_seconds").value = "0.001"; }],
  ["unsupported connection", f => { f.update({ ownRuntimes: [{ ...runtime, sharingCapability: null }] }); }],
  ["removed connection", f => { f.update({ ownRuntimes: [] }); }],
]) {
  test(`an unsent ${label} draft can be explicitly discarded when leaving`, async () => {
    const f = fixture({ autosave: 1000 });
    await openEditor(f); configure(f);
    f.el("total_daily_calls").dispatch("input"); f.el("close").click(); await flush();
    assert.equal(f.el("leave-confirmation").hidden, false, "the user chooses whether to discard the unsaved local draft");
    assert.equal(f.el("leave-discard").hidden, false); assert.equal(f.el("leave-pending").hidden, true);
    assert.equal(f.el("leave-discard").type, "button", "discard is not a native form submission");
    f.el("leave-discard").click();
    assert.equal(f.calls.length, 0, "discard never writes invalid or missing-source settings");
    assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 1);
    f.ui.clear();
  });
}

test("an active source going offline cannot trap a dirty configuration or silently stop it", async () => {
  const f = fixture({ initial: [grant], autosave: 1000 });
  await openEditor(f); f.update({ ownRuntimes: [{ ...runtime, sharingAvailability: "offline" }] });
  f.el("total_daily_calls").value = "21"; f.el("total_daily_calls").dispatch("input");
  f.el("back").click(); f.el("leave-stay").click();
  assert.equal(f.el("editor").hidden, false); assert.equal(f.el("total_daily_calls").value, "21");
  assert.equal(f.calls.length, 0); assert.match(f.el("error").textContent, /unavailable|offline/u);
  f.el("back").click(); f.el("leave-discard").click();
  assert.equal(f.el("editor").hidden, true);
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.calls.length, 0); f.ui.clear();
});

test("closing an unconfirmed save preserves its exact recovery key without claiming cancellation", async () => {
  const inputs = []; let lost = true;
  const f = fixture({ initial: [{ ...grant, enabled: false }], autosave: 1000,
    overrides: { saveAgentShare: async (_p, input) => {
      inputs.push(structuredClone(input)); if (lost) { lost = false; throw Error("lost receipt"); }
      return { share: { ...grant, enabled: false, revision: 2, limits: input.limits } };
    } } });
  await openEditor(f); f.el("total_daily_calls").value = "21"; f.el("total_daily_calls").dispatch("input");
  f.el("close").click(); await flush();
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("retry").hidden, false);
  assert.equal(f.el("status").textContent, "Sharing update not confirmed");
  f.el("close").click();
  assert.equal(f.el("leave-confirmation").hidden, false); assert.match(f.el("leave-message").textContent, /not cancel|not stop/u);
  assert.equal(f.el("leave-discard").hidden, true, "a sent write cannot be discarded as a local draft");
  f.el("leave-pending").click();
  assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 1);
  await f.ui.open(); assert.equal(f.el("retry").hidden, false);
  f.el("retry").click(); await flush();
  assert.equal(inputs.length, 2); assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(f.el("retry").hidden, true); assert.equal(f.ui.elements.dialog.open, true);
  assert.equal(f.el("toggle").textContent, "Start sharing"); f.ui.clear();
});

test("an already pending save can close for now and settle without reopening the panel", async () => {
  let resolve;
  const f = fixture({ initial: [{ ...grant, enabled: false }],
    overrides: { saveAgentShare: async (_p, input) => new Promise(done => {
      resolve = () => done({ share: { ...grant, enabled: false, revision: 2, limits: input.limits } });
    }) } });
  await openEditor(f); f.el("total_daily_calls").value = "21"; f.el("total_daily_calls").dispatch("input"); await wait();
  f.el("close").click(); f.el("leave-pending").click();
  assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.exits, 1);
  resolve(); await flush(); assert.equal(f.ui.elements.dialog.open, false); f.ui.clear();
});

test("staying with an unconfirmed action keeps its recoverable draft and view", async () => {
  const f = fixture({ initial: [grant], overrides: { saveAgentShare: async () => { throw Error("lost receipt"); } } });
  await openEditor(f); f.el("total_daily_calls").value = "42"; f.el("total_daily_calls").dispatch("input"); await wait();
  f.el("close").click(); f.el("leave-stay").click();
  assert.equal(f.el("leave-confirmation").hidden, true);
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.el("editor").hidden, false);
  assert.equal(f.el("total_daily_calls").value, "42"); assert.equal(f.el("retry").hidden, false); f.ui.clear();
});

test("a stale discard control cannot leave a newly opened account or project", async () => {
  const f = fixture({ autosave: 1000 });
  await openEditor(f); f.el("total_daily_calls").value = "0"; f.el("total_daily_calls").dispatch("input"); f.el("close").click();
  const oldDiscard = f.el("leave-discard");
  f.update({ scope: "bob:project-b", userId: "bob", projectId: "project-b" }); await f.ui.open(); oldDiscard.click();
  await flush(); assert.equal(f.el("leave-confirmation").hidden, true);
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.exits, 0); assert.equal(f.calls.length, 0); f.ui.clear();
});

test("a stale unconfirmed-action control cannot leave a newly opened account or project", async () => {
  const f = fixture({ overrides: { saveAgentShare: async () => { throw Error("lost receipt"); } } });
  await openEditor(f); f.el("total_daily_calls").value = "42"; f.el("total_daily_calls").dispatch("input"); await wait();
  f.el("close").click(); const oldLeave = f.el("leave-pending");
  f.update({ scope: "bob:project-b", userId: "bob", projectId: "project-b" }); await f.ui.open(); oldLeave.click();
  assert.equal(f.el("leave-confirmation").hidden, true);
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.exits, 0); f.ui.clear();
});

test("an uncertain enable stays independently stoppable after closing and reopening sharing", async () => {
  const inputs = [];
  const f = fixture({ autosave: 1000, overrides: {
    saveAgentShare: async (_p, input) => {
      inputs.push(structuredClone(input)); f.shares = [{ ...grant, id: "accepted-once", revision: 1, enabled: true }];
      throw Error("enable acknowledgement lost");
    },
  } });
  await openEditor(f); checkBob(f); f.el("toggle").click(); await flush();
  f.el("close").click(); f.el("leave-pending").click(); assert.equal(f.ui.elements.dialog.open, false);
  await f.ui.open(); const stop = f.el("list").children[0].children[1];
  assert.equal(stop.textContent, "Stop sharing"); assert.equal(stop.disabled, false);
  stop.click(); await flush();
  assert.equal(f.calls.find(call => call[0] === "control")[2], "accepted-once");
  assert.equal(f.calls.find(call => call[0] === "control")[3].action, "disable");
  assert.equal(inputs.length, 1, "leaving and stopping never replays enable to discover its result"); f.ui.clear();
});

test("blocked-draft guidance and discard controls are localized without a false Saving state", async () => {
  const f = fixture({ autosave: 1000 });
  f.doc.documentElement.lang = "zh-CN"; f.ui.refreshLanguage(); await openEditor(f);
  f.el("total_daily_calls").value = "0"; f.el("total_daily_calls").dispatch("input"); f.el("close").click();
  assert.equal(f.el("status").textContent, "共享设置尚未保存");
  assert.match(f.el("error").textContent, /调用次数.*整数.*累计时长/u);
  assert.match(f.el("leave-message").textContent, /放弃修改.*继续编辑/u);
  assert.equal(f.el("leave-discard").textContent, "放弃修改并离开");
  assert.equal(f.el("leave-stay").textContent, "留在此页");
  assert.equal(f.ui.elements.dialog.open, true); assert.equal(f.calls.length, 0); f.ui.clear();
});

for (const blocked of ["suppressed", "unavailable"]) {
  test(`in-dialog discard works when native confirmation is ${blocked}`, async () => {
    const nativeConfirm = globalThis.confirm; let prompts = 0;
    globalThis.confirm = () => { prompts++; if (blocked === "unavailable") throw Error("native modals unavailable"); return false; };
    const f = fixture({ autosave: 1000, patch: { ownRuntimes: [{ ...runtime, sharingCapability: null }] } });
    try {
      await openEditor(f); f.el("total_daily_calls").value = "42"; f.el("total_daily_calls").dispatch("input");
      f.el("close").click(); assert.equal(f.el("leave-confirmation").hidden, false);
      f.el("leave-discard").click();
      assert.equal(f.ui.elements.dialog.open, false); assert.equal(f.calls.length, 0); assert.equal(prompts, 0);
    } finally { f.ui.clear(); if (nativeConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = nativeConfirm; }
  });
}

test("checking a receipt while the leave choice is visible retires that old navigation intent", async () => {
  let first = true; const f = fixture({ initial: [grant], autosave: 1000, overrides: {
    saveAgentShare: async (_p, input) => {
      if (first) { first = false; throw Error("lost receipt"); }
      return { share: { ...grant, revision: 2, limits: input.limits } };
    },
  } });
  await openEditor(f); f.el("total_daily_calls").value = "21"; f.el("total_daily_calls").dispatch("input");
  f.el("close").click(); await flush(); f.el("close").click();
  assert.equal(f.el("leave-confirmation").hidden, false); const oldLeave = f.el("leave-pending");
  f.el("retry").click(); await flush(); oldLeave.click();
  assert.equal(f.ui.elements.dialog.open, true, "checking the result is not consent to the previous Leave choice");
  assert.equal(f.el("leave-confirmation").hidden, true); assert.equal(f.exits, 0); f.ui.clear();
});
