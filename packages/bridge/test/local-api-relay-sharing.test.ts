import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { AgentShareSchema, AgentShareJobSchema, CanonicalEventSchema, type SharedAgentRequestInput } from "@gatherthread/protocol";
import { LocalConnectorApiRelayServer, LocalConnectorCollaborationClient, resolveWorkspaceConnectorApiPath,
  type CollaborationApi, type AppendEventInput, type RuntimeRegistration, type CompleteAgentRequestInput } from "../src/index.js";

const timestamp = "2026-10-15T01:00:00.000Z";
const profile = { harness: "codex", provider: "openai", model: "fixture-shared-model" };
const share = AgentShareSchema.parse({ id: "share-fixture", project_id: "p1", owner_user_id: "owner-a", owner_display_name: "Synthetic owner",
  owner_avatar_id: null, revision: 4, enabled: true, available: true, disabled_reason: null, execution_profile: profile, limits: {},
  usage: { utc_day: "2026-10-15", calls: 0, seconds_used: 0, seconds_reserved: 0, active_jobs: 0 }, created_at: timestamp, updated_at: timestamp });
const job = AgentShareJobSchema.parse({ id: "job-fixture", project_id: "p1", share_id: share.id, share_revision: 4, session_id: "s1",
  request_event_id: "event-request", status: "queued", requester_user_id: "borrower-b", requester_display_name: "Synthetic borrower",
  execution_profile: profile, created_at: timestamp, deadline_at: "2026-10-15T01:12:00.000Z", finished_at: null, error_code: null, cleanup_pending: false });
const event = CanonicalEventSchema.parse({ id: job.request_event_id, session_id: "s1", sequence: 1, idempotency_key: "relay-shared-request",
  type: "agent_request", actor_user_id: "borrower-b", created_at: timestamp, visibility: "session", reply_to_event_id: null,
  payload: { content: "Compute 42" }, runtime_provenance: null,
  shared_execution: { share_id: share.id, share_revision: 4, job_id: job.id, executor_owner_user_id: share.owner_user_id,
    executor_owner_display_name: share.owner_display_name, execution_profile: profile } });
const input: SharedAgentRequestInput = { share_id: share.id, share_revision: 4, content: "Compute 42", content_revision: 6,
  solo_transfer_ack: false, idempotency_key: "relay-shared-request" };
class SharingApi implements CollaborationApi {
  calls: unknown[][] = []; ordinaryWrites = 0; denySolo = false; exposeCapsule = false; oversized = false; unprovenResponse = false;
  async listProjects() { return [{ id: "p1", name: "Fixture", state: "active" as const, role: "participant" as const, sessionCount: 1 }]; }
  async listProjectSessions() { return [{ id: "s1", projectId: "p1", name: "Fixture Solo", mode: "solo" as const }]; }
  async listSessions() { return this.listProjectSessions(); }
  async readEvents(_sessionId: string, after: number) { return { events: [], nextSequence: after, hasMore: false }; }
  async appendEvent(sessionId: string, value: AppendEventInput) { this.ordinaryWrites++; return { id: "ordinary", sessionId, sequence: 1,
    type: value.type, actorId: "borrower-b", timestamp, payload: value.payload }; }
  async registerRuntime(value: RuntimeRegistration) { return { ...value, id: "private-native", userId: "borrower-b" }; }
  async claimAgentRequest(_sessionId: string, requestId: string, runtimeId: string) { return { claimed: true, status: "claimed" as const, requestId, runtimeId }; }
  async completeAgentRequest(sessionId: string, _requestId: string, value: CompleteAgentRequestInput) {
    return this.appendEvent(sessionId, { type: "agent_response", idempotencyKey: value.idempotencyKey, payload: value.payload });
  }
  agentSharingRequestApi() { return {
    list: async (projectId: string) => { this.calls.push(["list", projectId]); return { shares: [share,
      { ...share, id: "own-grant", source_runtime_id: "private-source", owner_device_id: "private-device", allowed_user_ids: ["member-c"] }] }; },
    start: async (sessionId: string, body: SharedAgentRequestInput) => {
      this.calls.push(["start", sessionId, body]);
      if (this.denySolo && !body.solo_transfer_ack) throw new Error("agent_share_solo_disclosure_required");
      const { shared_execution: _proof, ...unproven } = event;
      return { event: this.unprovenResponse ? CanonicalEventSchema.parse({ ...unproven, payload: { shared_agent: event.shared_execution! } })
        : this.oversized ? { ...event, payload: { content: "x".repeat(1024 * 1024) } } : event, job, replayed: true,
        ...(this.exposeCapsule ? { capsule: { source_runtime_id: "private-source" } } : {}) };
    },
    cancel: async (sessionId: string, eventId: string, body: { idempotency_key: string }) => {
      this.calls.push(["cancel", sessionId, eventId, body]); return { job: { ...job, status: "cancelled" as const }, replayed: true };
    },
  }; }
}
async function raw(endpoint: string, capability: string, method: string, params: unknown[]) {
  return await new Promise<{ result?: any; error?: string }>((resolve, reject) => {
    const socket = net.createConnection(endpoint); let output = ""; socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: "sharing-fixture", capability, method, params })}\n`));
    socket.on("data", chunk => { output += chunk; }); socket.once("error", reject);
    socket.once("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
}
test("local relay exposes only sanitized public sharing calls and preserves Solo/retry pins", async t => {
  if (process.platform === "win32") { t.skip("POSIX socket fixture; named-pipe transport uses the same allowlist"); return; }
  const directory = await mkdtemp("/tmp/gts-"); const home = path.join(directory, "home"), workspace = path.join(directory, "work");
  await mkdir(workspace); const endpoint = resolveWorkspaceConnectorApiPath(workspace, home), api = new SharingApi();
  const relay = new LocalConnectorApiRelayServer({ endpoint, api, projectId: "p1", homeDirectory: home });
  t.after(async () => { await relay.close(); await rm(directory, { recursive: true, force: true }); });
  await relay.start();
  const capability = (await readFile(`${endpoint}.capability`, "utf8")).trim();
  const client = new LocalConnectorCollaborationClient({ endpoint, homeDirectory: home }), sharing = client.agentSharingRequestApi();
  const listed = await sharing.list("p1"); assert.equal(listed.shares.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), /private-source|private-device|source_runtime_id|owner_device_id|allowed_user_ids|capsule|Bearer/);
  api.denySolo = true;
  await assert.rejects(sharing.start("s1", input), /solo_disclosure_required/);
  assert.equal((api.calls.at(-1)![2] as SharedAgentRequestInput).solo_transfer_ack, false);
  const approved = { ...input, solo_transfer_ack: true };
  await sharing.start("s1", approved); await sharing.start("s1", approved);
  assert.deepEqual(api.calls.at(-1), api.calls.at(-2));
  assert.equal((api.calls.at(-1)![2] as SharedAgentRequestInput).content_revision, 6);
  assert.equal((await sharing.cancel("s1", job.request_event_id, { idempotency_key: "relay-shared-cancel" })).job.status, "cancelled");
  assert.deepEqual(api.calls.at(-1), ["cancel", "s1", job.request_event_id, { idempotency_key: "relay-shared-cancel" }]);
  const before = api.calls.length;
  for (const [method, params] of [
    ["listSharedAgents", ["p2"]], ["listSharedAgents", ["p1", "extra"]], ["startSharedAgent", ["s2", approved]],
    ["startSharedAgent", ["s1", { ...approved, source_runtime_id: "private-source" }]],
    ["startSharedAgent", ["s1", { ...approved, content_revision: undefined }]],
    ["cancelSharedAgentRequest", ["s1", job.request_event_id, { idempotency_key: "relay-shared-cancel", claim_attempt: 1 }]],
    ...["listAgentShareJobs", "claimAgentShareJob", "reportAgentShareAvailability", "reportSourceAvailability", "saveAgentShare", "controlAgentShare"]
      .map(method => [method, []]),
  ] as [string, unknown[]][]) assert.ok((await raw(endpoint, capability, method, params)).error, method);
  assert.equal(api.calls.length, before); assert.equal(api.ordinaryWrites, 0);
  assert.match((await raw(endpoint, "fictional-wrong-capability", "listSharedAgents", ["p1"])).error!, /capability was rejected/);
  api.exposeCapsule = true; await assert.rejects(sharing.start("s1", approved), /capsule|unrecognized/i);
  api.exposeCapsule = false; api.unprovenResponse = true;
  await assert.rejects(sharing.start("s1", approved), /scope mismatch/);
  api.unprovenResponse = false; api.oversized = true;
  await assert.rejects(sharing.start("s1", approved), /too large/);
});
test("shared project and session calls refuse ambiguous connector routing", async t => {
  if (process.platform === "win32") { t.skip("POSIX multiplexer fixture"); return; }
  const directory = await mkdtemp("/tmp/gtsa-"); const home = path.join(directory, "home");
  const firstPath = path.join(directory, "one"), secondPath = path.join(directory, "two");
  await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
  const firstApi = new SharingApi(), secondApi = new SharingApi();
  const first = new LocalConnectorApiRelayServer({ endpoint: resolveWorkspaceConnectorApiPath(firstPath, home), api: firstApi, projectId: "p1", homeDirectory: home });
  const second = new LocalConnectorApiRelayServer({ endpoint: resolveWorkspaceConnectorApiPath(secondPath, home), api: secondApi, projectId: "p1", homeDirectory: home });
  t.after(async () => { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); });
  await first.start(); await second.start();
  const client = new LocalConnectorCollaborationClient({ homeDirectory: home }), api = client.agentSharingRequestApi();
  await assert.rejects(api.list("p1"), /multiple|ambiguous/i);
  await assert.rejects(api.start("s1", input), /multiple|ambiguous/i);
  assert.equal(firstApi.calls.length, 0); assert.equal(secondApi.calls.length, 0);
});
