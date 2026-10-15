import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { ApiError, HttpCollaborationApi } from "../src/api.js";
import { composerAgentAction, mountAgentRequestControl, retryAgentRequestPermission } from "../src/agent-request-control.js";
import { eventAuthorLabel, eventExecutionOwner } from "../src/avatars.js";
import { DEFAULT_SHARE_LIMITS } from "../src/shared-agent-view.js";

const profile = { harness: "codex", provider: "openai", model: "fixture-model", reasoning_effort: "high" };
const stamp = "2026-10-15T00:00:00.000Z";
const usage = { utc_day: "2026-10-15", calls: 1, seconds_used: 0, seconds_reserved: 720, active_jobs: 1 };
const share = { id: "share-a", project_id: "project-a", owner_user_id: "alice", owner_display_name: "Alice", owner_avatar_id: "cat",
  revision: 1, enabled: true, available: true, disabled_reason: null, execution_profile: profile, limits: DEFAULT_SHARE_LIMITS,
  usage, created_at: stamp, updated_at: stamp };
const input = { share_id: share.id, share_revision: share.revision, content: "Do the fixture task", content_revision: 0,
  solo_transfer_ack: true, idempotency_key: "shared-start-fixture-key" };
const shared = { share_id: share.id, share_revision: share.revision, job_id: "job-a", executor_owner_user_id: "alice",
  executor_owner_display_name: "Alice", execution_profile: profile };
const event = { id: "request-a", session_id: "session-b", sequence: 1, type: "agent_request", visibility: "session",
  idempotency_key: input.idempotency_key, actor_user_id: "bob", actor_display_name: "Bob", created_at: stamp,
  reply_to_event_id: null, runtime_provenance: null, content_revision: 0, shared_execution: shared,
  payload: { content: input.content, shared_agent: shared } };
const job = { id: shared.job_id, project_id: "project-a", share_id: share.id, share_revision: 1, session_id: event.session_id,
  request_event_id: event.id, status: "queued", requester_user_id: "bob", requester_display_name: "Bob", execution_profile: profile,
  created_at: stamp, deadline_at: null, finished_at: null, error_code: null, cleanup_pending: false };
const receipt = { event, job, replayed: false };
const safeResponseError = error => error instanceof ApiError && error.code === "invalid_agent_share_response"
  && !error.message.includes("private-fixture");
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

test("shared API uses exact separate routes with Cookie credentials and no native bearer", async () => {
  const previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url: String(url), options }); return Response.json({ data:
    String(url).endsWith("/control") ? { share } : String(url).endsWith("shared-agent-requests") ? receipt : { shares: [share] } }); };
  try {
    const api = new HttpCollaborationApi({ baseUrl: "https://gatherthread.example" }), controller = new AbortController();
    await api.listAgentShares("project-a", { signal: controller.signal });
    await api.controlAgentShare("project-a", "share-a", { action: "disable", idempotency_key: "disable-fixture-key" });
    await api.startSharedAgentRequest("session-b", input);
    assert.deepEqual(requests.map(request => [request.url, request.options.method ?? "GET"]), [
      ["https://gatherthread.example/v1/projects/project-a/agent-shares", "GET"],
      ["https://gatherthread.example/v1/projects/project-a/agent-shares/share-a/control", "POST"],
      ["https://gatherthread.example/v1/sessions/session-b/shared-agent-requests", "POST"],
    ]);
    assert.ok(requests.every(request => request.options.credentials === "include" && !request.options.headers.Authorization));
    assert.equal(requests[0].options.signal, controller.signal); assert.equal(requests[1].options.signal, undefined);
    assert.deepEqual(JSON.parse(requests[2].options.body), input);
  } finally { globalThis.fetch = previous; }
});

test("shared API rejects identity overrides, invalid budgets and unknown fields before transport", () => {
  const api = new HttpCollaborationApi(); let calls = 0; api.request = () => { calls++; throw new Error("transport must stay idle"); };
  for (const invalid of [{ ...input, owner_user_id: "alice" }, { ...input, runtime_id: "foreign-native-runtime" },
    { ...input, share_revision: 0 }, { ...input, api_key: "dummy" }]) {
    assert.throws(() => api.startSharedAgentRequest("session-b", invalid), error => error instanceof ApiError && error.status === 422);
  }
  assert.throws(() => api.controlAgentShare("project-a", "share-a", { action: "enable", idempotency_key: "enable-fixture-key" }), /input is invalid/u);
  assert.equal(calls, 0);
});

test("share replies are project-scoped and never accept accidental private fields", async () => {
  const api = new HttpCollaborationApi();
  for (const result of [{ shares: [{ ...share, project_id: "other-project" }] }, { shares: [{ ...share, token: "private-fixture" }] },
    { shares: [share], credential: "private-fixture" }]) {
    api.request = async () => result; await assert.rejects(api.listAgentShares("project-a"), safeResponseError);
  }
});

test("control/save acknowledgements bind the share being changed, rather than another share in the same project", async () => {
  const api = new HttpCollaborationApi(); api.request = async () => ({ share: { ...share, id: "different-share" } });
  await assert.rejects(api.controlAgentShare("project-a", "share-a", { action: "disable", idempotency_key: "disable-fixture-key" }), safeResponseError);
  await assert.rejects(api.saveAgentShare("project-a", { share_id: share.id, source_runtime_id: "source-a", execution_profile: profile,
    allowed_user_ids: ["bob"], limits: DEFAULT_SHARE_LIMITS, expected_revision: 1, idempotency_key: "save-fixture-key" }), safeResponseError);
});

test("accepted shared requests bind session, original exact share and the canonical job/event linkage", async () => {
  const api = new HttpCollaborationApi();
  const invalid = [
    { ...receipt, job: { ...job, session_id: "different-session" } },
    { ...receipt, job: { ...job, share_id: "different-share" } },
    { ...receipt, job: { ...job, share_revision: 2 } },
    { ...receipt, job: { ...job, request_event_id: "different-request" } },
    { ...receipt, event: { ...event, type: "human_chat" } },
    { ...receipt, event: { ...event, payload: { ...event.payload, shared_agent: { ...shared, job_id: "different-job" } } } },
    { ...receipt, event: { ...event, shared_execution: undefined } },
    { ...receipt, event: { ...event, shared_execution: { ...shared, share_id: "different-share" } } },
    { ...receipt, event: { ...event, shared_execution: { ...shared, share_revision: 2 } } },
    { ...receipt, event: { ...event, shared_execution: { ...shared, job_id: "different-job" } } },
  ];
  for (const result of invalid) {
    api.request = async () => result; await assert.rejects(api.startSharedAgentRequest("session-b", input), safeResponseError);
  }
});

test("shared Stop validates its original job identity and keeps transport errors generic", async () => {
  const api = new HttpCollaborationApi();
  for (const wrong of [{ ...job, session_id: "different-session" }, { ...job, request_event_id: "different-request" }]) {
    api.request = async () => ({ job: wrong, replayed: false });
    await assert.rejects(api.cancelSharedAgentRequest("session-b", "request-a", { idempotency_key: "shared-stop-fixture-key" }), safeResponseError);
  }
  api.request = async () => { throw new ApiError("private-fixture exception body", { status: 503, code: "agent_share_unavailable" }); };
  await assert.rejects(api.cancelSharedAgentRequest("session-b", "request-a", { idempotency_key: "shared-stop-fixture-key" }),
    error => error instanceof ApiError && error.status === 503 && error.code === "agent_share_unavailable" && !error.message.includes("private-fixture"));
  assert.throws(() => api.cancelSharedAgentRequest("session-b", "request-a", { idempotency_key: "shared-stop-fixture-key", owner_override: "alice" }),
    error => error instanceof ApiError && error.status === 422);
});

test("shared Agent replies use executor owner avatars/name while request ownership and delete authority stay with requester", () => {
  const actor = { id: "bob", username: "Bob" };
  const request = { id: event.id, type: "agent_request", actor, payload: event.payload };
  const reply = { type: "agent_response", actor, sharedExecution: shared, payload: { content: "Done", shared_agent: shared } };
  assert.deepEqual(eventExecutionOwner(request), actor); assert.equal(eventAuthorLabel(request), "Bob");
  assert.deepEqual(eventExecutionOwner(reply), { id: "alice", username: "Alice" }); assert.equal(eventAuthorLabel(reply), "Alice's Agent");
  assert.equal(reply.actor.id, "bob", "presentation must not rewrite the canonical author");
  assert.deepEqual(eventExecutionOwner({ ...reply, sharedExecution: undefined, shared_execution: shared }), { id: "alice", username: "Alice" });
  const forged = { ...reply, sharedExecution: undefined };
  assert.deepEqual(eventExecutionOwner(forged), actor, "legacy payload metadata without server proof cannot impersonate the executor");
  assert.equal(eventAuthorLabel(forged), "Bob's Agent");
});

test("authenticated replay keeps readonly shared execution proof separate from untrusted payload metadata", async () => {
  const api = new HttpCollaborationApi();
  api.request = async () => ({ events: [{ ...event, type: "agent_response", reply_to_event_id: "request-a" }], cursor: 1, has_more: false, content_revision: 0 });
  const page = await api.replayEvents("session-b", { afterSequence: 0 });
  assert.deepEqual(page.events[0].sharedExecution, shared); assert.equal(page.events[0].actor.id, "bob");
  assert.equal(eventExecutionOwner(page.events[0]).id, "alice");
});

test("queued shared requests are immediately stoppable, author-scoped and never treated as local pause/resume", async () => {
  const request = { id: "request-a", actor: { id: "bob" }, type: "agent_request", payload: { shared_agent: shared, content: input.content } };
  assert.equal(composerAgentAction([request], "bob").action, "stop"); assert.equal(composerAgentAction([request], "alice").action, "request");
  assert.equal(retryAgentRequestPermission(request, { currentUser: { id: "bob" }, connectionPhase: "live",
    session: { id: "session-b", mode: "solo", ownerUserId: "bob", members: [{ userId: "bob", role: "participant", runtime: null }] } }).allowed, true);
  const doc = { createElement: () => ({ setAttribute() {}, textContent: "" }) };
  const button = { ownerDocument: doc, disabled: false, dataset: {}, setAttribute() {}, replaceChildren() {} }, label = {}, error = {};
  const calls = []; let once = true, count = 0;
  const ui = mountAgentRequestControl({ button, targetLabel: label, errorNode: error,
    api: { cancelSharedAgentRequest: async (...args) => { calls.push(args); if (once) { once = false; throw new Error("Lost cancellation ACK"); } },
      pauseAgentRequest: async () => assert.fail("shared cancellation must not use local pause") },
    getContext: () => ({ scope: "bob:session-b:0", sessionId: "session-b", userId: "bob", events: [request], writable: true }),
    makeKey: kind => `${kind}-fixture-${++count}`, onChange: () => ui.update() });
  ui.update(); ui.handleClick(); await flush(); ui.handleClick(); await flush();
  assert.equal(calls.length, 2); assert.equal(calls[0][2].idempotency_key, calls[1][2].idempotency_key);
  assert.match(label.textContent, /Stops your shared request/u);
});

// Execute the real send handler with a bounded workspace, without opening accounts or polling.
const mainSource = (await readFile(new URL("../src/main.js", import.meta.url), "utf8")).replace(/\r\n?/gu, "\n");
function functionSource(name) {
  const start = mainSource.search(new RegExp(`^(?:async )?function ${name}\\(`, "mu")); assert.notEqual(start, -1, name);
  const tail = mainSource.slice(start), end = tail.indexOf("\n}\n") + 2; assert.ok(end > 1); return tail.slice(0, end);
}
test("shared pending status follows verified execution progress rather than the borrower's absent local runtime", () => {
  const makeNode = () => ({ dataset: {}, attributes: {}, children: [], textContent: "", setAttribute(key, value) { this.attributes[key] = value; }, append(...items) { this.children.push(...items); } });
  const context = vm.createContext({ state: { session: { members: [{ userId: "bob" }] } },
    document: { createElement: makeNode }, isExecutionRuntime: () => false, latestStreamedText: () => "",
    localizer: { t: value => value } });
  vm.runInContext(functionSource("renderAgentPendingStatus"), context);
  const request = { actor: { id: "bob" }, sharedExecution: shared, payload: event.payload };
  let rendered = context.renderAgentPendingStatus(request, []);
  assert.equal(rendered.dataset.state, "queued"); assert.equal(rendered.children[1].textContent, "Shared Agent request is queued.");
  rendered = context.renderAgentPendingStatus(request, [{ sharedExecution: shared }]);
  assert.equal(rendered.dataset.state, "answering"); assert.equal(rendered.children[1].textContent, "Shared Agent is responding…");
  assert.equal(context.renderAgentPendingStatus(request, [{ sharedExecution: { ...shared, job_id: "other-job" } }]).dataset.state, "queued");
});
function sendFixture({ mode = "solo", approve = true, apiOverride } = {}) {
  const calls = [], confirmations = [], message = { value: input.content, focus() {}, disabled: false };
  const node = () => ({ disabled: false, childNodes: [], textContent: "", replaceChildren() {}, focus() {}, hidden: false, closest: () => node() });
  const nodes = new Map(), el = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  let metadata = { replyTo: null, mentions: [] };
  let counter = 0;
  const context = vm.createContext({ state: { currentUser: { id: "bob" }, project: { id: "project-a" }, session: { id: "session-b", mode },
    settings: { composer: { confirmAgentRequest: false } }, sync: { contentRevision: 0 } },
    authenticationGeneration: 1, selectedSessionGeneration: 1, workspaceLoadGeneration: 0,
    currentProjectHarness: () => "shared", agentRequestControl: { action: () => "request", update() {} }, messageInput: message,
    sendChatButton: node(), sendAgentButton: node(), sendError: node(), pendingMessageSend: null, pendingSharedAgentIntent: null,
    localizer: { t: value => value }, createIdempotencyKey: kind => `${kind}-fixture-${++counter}`,
    element: el, canAppend: () => ({ allowed: true }), currentCodexResolution: () => ({ runtime: null }),
    DSH_HARNESS: "deepseek-harness", CLOUD_AGENT_ENTRY_ENABLED: true,
    codeSyncUi: { updateContext() {} }, cloudCodeConsent: { updateContext() {} }, cloudGithubUi: { updateContext() {} },
    historySummaryUi: { updateContext() {} }, renderAgentProfileControls() {},
    currentCloudProfile: () => null, agentContextUpdateReason: () => "",
    messageActions: { metadata: () => metadata, sent() {} },
    sharedAgentsUi: { selected: () => ({ available: true, target: { kind: "shared", share_id: share.id, share_revision: share.revision } }),
      disclosure: () => "Solo disclosure: task goes to Alice's device.", refresh: async () => {}, updateContext() {} },
    api: { startSharedAgentRequest: async (id, body) => { calls.push([id, body]); if (apiOverride) return apiOverride(id, body); } },
    window: { confirm: value => { confirmations.push(value); return approve; } },
  });
  vm.runInContext(["captureWorkspaceScope", "renderComposerPermissions", "sendMessage"].map(functionSource).join("\n"), context);
  const marker = 'element("shared-agent-recover").addEventListener("click", async () => {';
  const begin = mainSource.indexOf(marker), tail = mainSource.slice(begin + marker.length), end = tail.indexOf("\n});");
  assert.ok(begin >= 0 && end >= 0, "actual recovery handler exists");
  vm.runInContext(`async function recoverSharedRequest() {${tail.slice(0, end)}\n}`, context);
  return { context, calls, confirmations, message, el, set metadata(value) { metadata = value; } };
}

test("manual Solo shared send requires disclosure even when ordinary request confirmation is off", async () => {
  const declined = sendFixture({ approve: false }); await declined.context.sendMessage("agent_request");
  assert.equal(declined.calls.length, 0); assert.equal(declined.message.value, input.content); assert.match(declined.confirmations[0], /Alice's device/u);
  const accepted = sendFixture(); await accepted.context.sendMessage("agent_request");
  assert.equal(accepted.calls.length, 1); assert.equal(accepted.calls[0][1].solo_transfer_ack, true);
  assert.equal(accepted.calls[0][1].share_id, share.id); assert.equal(accepted.calls[0][1].share_revision, 1);
  assert.equal(accepted.calls[0][1].content_revision, 0); assert.equal(accepted.message.value, "");
});

test("manual Multi shared send remains explicit but uses the separate shared route without Solo acknowledgement", async () => {
  const f = sendFixture({ mode: "multi" }); await f.context.sendMessage("agent_request");
  assert.equal(f.confirmations.length, 0); assert.equal(f.calls[0][1].solo_transfer_ack, false);
});

test("shared composer preserves selected quote and adjusts mention offsets after trimming", async () => {
  const f = sendFixture({ mode: "multi" }); f.message.value = "  @Alice do the fixture task";
  f.metadata = { replyTo: "quoted-event", mentions: [{ user_id: "alice", start: 2, end: 8 }] };
  await f.context.sendMessage("agent_request");
  assert.equal(f.calls[0][1].reply_to_event_id, "quoted-event");
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][1].mentions)), [{ user_id: "alice", start: 0, end: 6 }]);
});

test("unknown first-shared ACK freezes its key/body and blocks another task until explicit same-key recovery", async () => {
  let once = true;
  const f = sendFixture({ apiOverride: async () => { if (once) { once = false; throw new Error("Synthetic network uncertainty"); } } });
  await f.context.sendMessage("agent_request");
  const intent = f.context.pendingSharedAgentIntent; assert.ok(intent); assert.equal(f.context.sendAgentButton.disabled, true);
  assert.equal(f.el("shared-agent-recover").hidden, false); f.message.value = "A newer draft";
  await f.context.sendMessage("agent_request"); assert.equal(f.calls.length, 1, "uncertain accepted call cannot be billed twice");
  await f.context.recoverSharedRequest(); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0][1], f.calls[1][1]); assert.equal(f.context.pendingSharedAgentIntent, null);
  assert.equal(f.message.value, "A newer draft", "recovery does not clear a changed draft");
});

test("an old session's definitive failure cannot clear a newer session's shared request intent", async () => {
  let rejectOld, resolveNew; let calls = 0;
  const f = sendFixture({ apiOverride: async () => ++calls === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; })
    : new Promise(resolve => { resolveNew = resolve; }) });
  const first = f.context.sendMessage("agent_request"); await flush();
  f.context.selectedSessionGeneration++; f.context.state.session = { id: "session-c", mode: "solo" };
  f.context.renderComposerPermissions(); f.message.value = "Second session task";
  const second = f.context.sendMessage("agent_request"); await flush();
  const newer = f.context.pendingSharedAgentIntent; assert.equal(newer.sessionId, "session-c");
  rejectOld(Object.assign(new Error("Old request rejected"), { status: 403 })); await first;
  assert.equal(f.context.pendingSharedAgentIntent, newer, "only the failed operation's own intent may be cleared");
  resolveNew(); await second;
});
test("shared acceptance binds the borrower's selected model/effort, independent of input property order", async () => {
  const api = new HttpCollaborationApi(); api.request = async () => receipt;
  await api.startSharedAgentRequest("session-b", { ...input, execution_profile: {
    reasoning_effort: "high", model: profile.model, provider: profile.provider, harness: profile.harness } });
  await assert.rejects(api.startSharedAgentRequest("session-b", { ...input,
    execution_profile: { ...profile, reasoning_effort: "low" } }), safeResponseError);
});
