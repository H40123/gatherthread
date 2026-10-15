import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationApi, AppendEventInput, RuntimeRegistration, CompleteAgentRequestInput } from "@gatherthread/bridge";
import { AgentShareSchema, AgentShareJobSchema, CanonicalEventSchema, type SharedAgentRequestInput } from "@gatherthread/protocol";
import { CollaborationMcpService } from "../src/index.js";

const timestamp = "2026-10-15T01:00:00.000Z";
const profile = { harness: "codex", provider: "openai", model: "fixture-model" };
const share = AgentShareSchema.parse({ id: "share-a", project_id: "p1", owner_user_id: "owner-a", owner_display_name: "Synthetic A",
  owner_avatar_id: null, revision: 7, enabled: true, available: true, disabled_reason: null, execution_profile: profile, limits: {},
  usage: { utc_day: "2026-10-15", calls: 0, seconds_used: 0, seconds_reserved: 0, active_jobs: 0 }, created_at: timestamp, updated_at: timestamp });
const job = AgentShareJobSchema.parse({ id: "job-a", project_id: "p1", share_id: share.id, share_revision: 7, session_id: "s1",
  request_event_id: "event-request", status: "queued", requester_user_id: "requester-b", requester_display_name: "Synthetic B",
  execution_profile: profile, created_at: timestamp, deadline_at: "2026-10-15T01:12:00.000Z", finished_at: null, error_code: null, cleanup_pending: false });
const event = CanonicalEventSchema.parse({ id: job.request_event_id, session_id: "s1", sequence: 1, idempotency_key: "shared-fixture-request",
  type: "agent_request", actor_user_id: "requester-b", created_at: timestamp, visibility: "session", reply_to_event_id: null,
  payload: { content: "Compute 42" }, runtime_provenance: null, content_revision: 3,
  shared_execution: { share_id: share.id, share_revision: 7, job_id: job.id, executor_owner_user_id: share.owner_user_id,
    executor_owner_display_name: share.owner_display_name, execution_profile: profile } });
const input = { session_id: "s1", share_id: share.id, share_revision: 7, content: "Compute 42", content_revision: 3,
  idempotency_key: "shared-fixture-request" };
class SharingApi implements CollaborationApi {
  ordinaryWrites = 0; calls: unknown[][] = []; denySolo = false; invalidResponse = false; unprovenResponse = false; wrongScope = false;
  async listSessions() { return [{ id: "s1", projectId: "p1", name: "Synthetic Solo", mode: "solo" as const }]; }
  async readEvents(_session: string, after: number) { return { events: [], nextSequence: after, hasMore: false }; }
  async appendEvent(sessionId: string, value: AppendEventInput) { this.ordinaryWrites++; return { id: "ordinary", sessionId, sequence: 1,
    type: value.type, actorId: "requester-b", timestamp, payload: value.payload }; }
  async registerRuntime(value: RuntimeRegistration) { return { ...value, id: "runtime-private", userId: "requester-b" }; }
  async claimAgentRequest(_session: string, requestId: string, runtimeId: string) { return { claimed: true, status: "claimed" as const, requestId, runtimeId }; }
  async completeAgentRequest(session: string, _request: string, value: CompleteAgentRequestInput) {
    return this.appendEvent(session, { type: "agent_response", idempotencyKey: value.idempotencyKey, payload: value.payload });
  }
  agentSharingRequestApi() { return {
    list: async (project: string) => { this.calls.push(["list", project]); return { shares: [share,
      { ...share, id: "own-share", source_runtime_id: "native-private", owner_device_id: "device-private", allowed_user_ids: ["other-member"], total_usage: share.usage }] }; },
    start: async (session: string, value: SharedAgentRequestInput) => {
      this.calls.push(["start", session, value]);
      if (this.denySolo && !value.solo_transfer_ack) throw new Error("agent_share_solo_disclosure_required");
      const { shared_execution: _proof, ...unproven } = event;
      return { event: this.unprovenResponse ? CanonicalEventSchema.parse({ ...unproven, payload: { shared_agent: event.shared_execution! } })
        : this.wrongScope ? { ...event, session_id: "another-session" } : event,
        job, replayed: this.calls.filter(item => item[0] === "start").length > 1,
        ...(this.invalidResponse ? { capsule: { source_runtime_id: "never-public" } } : {}) };
    },
    cancel: async (session: string, request: string, value: { idempotency_key: string }) => {
      this.calls.push(["cancel", session, request, value]); return { job: { ...job, status: "cancelled" as const }, replayed: false };
    },
  }; }
}
async function call(service: CollaborationMcpService, name: string, args: unknown) {
  return await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;
}
test("public sharing MCP tools are capability-gated and never expose native management", async () => {
  const api = new SharingApi(), service = new CollaborationMcpService({ api });
  const listed = await service.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as any;
  const tools = listed.result.tools.filter((item: any) => /shared_agent/.test(item.name));
  assert.deepEqual(tools.map((item: any) => item.name), ["collaboration_list_shared_agents", "collaboration_request_shared_agent", "collaboration_cancel_shared_agent_request"]);
  assert.equal(tools[0].annotations.readOnlyHint, true); assert.equal(tools[1].annotations.readOnlyHint, false);
  assert.equal(tools[1].annotations.idempotentHint, true);
  assert.match(tools[1].description, /human has explicitly agreed/);
  const runtime = new CollaborationMcpService({ api, toolProfile: "runtime" });
  assert.equal((await call(runtime, tools[1].name, input)).error.code, -32601);
  const absent = Object.assign(new SharingApi(), { agentSharingRequestApi: undefined });
  assert.equal((await call(new CollaborationMcpService({ api: absent as CollaborationApi }), tools[1].name, input)).error.code, -32601);
  for (const name of ["collaboration_enable_agent_share", "collaboration_claim_shared_agent", "collaboration_report_source_availability"]) {
    assert.equal((await call(service, name, {})).error.code, -32601);
  }
  assert.equal(api.ordinaryWrites, 0);
});
test("shared discovery is sanitized and strict; Solo acknowledgement is never invented", async () => {
  const api = new SharingApi(), service = new CollaborationMcpService({ api });
  const listed = await call(service, "collaboration_list_shared_agents", { project_id: "p1" });
  assert.equal(listed.result.structuredContent.result.shares.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), /native-private|device-private|source_runtime_id|allowed_user_ids|total_usage|capsule|Bearer/);
  const before = api.calls.length;
  assert.equal((await call(service, "collaboration_list_shared_agents", { project_id: "p1", owner_user_id: "owner-a" })).error.code, -32602);
  assert.equal(api.calls.length, before);
  api.denySolo = true;
  assert.match((await call(service, "collaboration_request_shared_agent", input)).error.message, /solo_disclosure_required/);
  assert.equal((api.calls.at(-1)![2] as SharedAgentRequestInput).solo_transfer_ack, false);
  const accepted = await call(service, "collaboration_request_shared_agent", { ...input, solo_transfer_ack: true });
  assert.equal(accepted.result.structuredContent.result.job.id, job.id);
  assert.equal(accepted.result.structuredContent.result.event.shared_execution.executor_owner_user_id, share.owner_user_id);
  assert.equal((api.calls.at(-1)![2] as SharedAgentRequestInput).solo_transfer_ack, true);
  assert.equal(api.ordinaryWrites, 0);
});
test("shared MCP pins revisions and retry keys and refuses credential or routing overrides", async () => {
  const api = new SharingApi(), service = new CollaborationMcpService({ api });
  const valid = { ...input, solo_transfer_ack: true, reply_to_event_id: "event-quote", mentions: [{ user_id: "owner-a", start: 0, end: 2 }] };
  for (let attempt = 0; attempt < 2; attempt++) assert.ok((await call(service, "collaboration_request_shared_agent", valid)).result);
  assert.deepEqual(api.calls[0], api.calls[1]);
  assert.equal((api.calls[0]![2] as SharedAgentRequestInput).content_revision, 3);
  const count = api.calls.length;
  for (const bad of [{ ...input, content_revision: undefined }, { ...input, share_revision: 0 }, { ...input, runtime_id: "private" },
    { ...input, source_runtime_id: "private" }, { ...input, actor_user_id: "owner-a" }, { ...input, payload: {} },
    { ...input, mentions: [{ user_id: "owner-a", start: 0, end: 2, label: "forged" }] },
    { ...input, content: "password=synthetic-example-only" }]) {
    assert.equal((await call(service, "collaboration_request_shared_agent", bad)).error.code, -32602);
  }
  assert.equal(api.calls.length, count); assert.equal(api.ordinaryWrites, 0);
  api.invalidResponse = true;
  assert.equal((await call(service, "collaboration_request_shared_agent", valid)).error.code, -32602);
  api.invalidResponse = false; api.unprovenResponse = true;
  assert.match((await call(service, "collaboration_request_shared_agent", valid)).error.message, /scope mismatch/);
  api.unprovenResponse = false; api.wrongScope = true;
  assert.match((await call(service, "collaboration_request_shared_agent", valid)).error.message, /scope mismatch/);
});
test("shared cancellation uses only the exact requester endpoint and stable key", async () => {
  const api = new SharingApi(), service = new CollaborationMcpService({ api });
  const args = { session_id: "s1", request_event_id: job.request_event_id, idempotency_key: "shared-fixture-cancel" };
  assert.equal((await call(service, "collaboration_cancel_shared_agent_request", args)).result.structuredContent.result.job.status, "cancelled");
  assert.deepEqual(api.calls[0], ["cancel", "s1", job.request_event_id, { idempotency_key: args.idempotency_key }]);
  assert.equal((await call(service, "collaboration_cancel_shared_agent_request", { ...args, share_id: share.id })).error.code, -32602);
  assert.equal(api.calls.length, 1); assert.equal(api.ordinaryWrites, 0);
});
