import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentShareJobClaimResponseSchema, SharedAgentRequestAcceptedSchema, AgentSharesResponseSchema } from "@gatherthread/protocol";
import { startCollaborationServer } from "../src/server.js";
import { identityFixture, browserSessionFixture } from "./auth-fixtures.js";

test("sharing HTTP separates owner browser grants, authorized requester actions and exact native execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-sharing-http-"));
  const browserOrigin = "http://sharing-fixture.invalid";
  const server = await startCollaborationServer({ databasePath: join(directory, "fixture.sqlite"),
    authTokenPepper: "fictional-sharing-http-pepper-long-enough", allowedOrigins: [browserOrigin], actorWriteRateLimit: { windowMs: 1000, limit: 100 } }, 0);
  const owner = identityFixture(server, { body: { display_name: "Fixture sharing A" } }).body.data,
    peer = identityFixture(server, { body: { display_name: "Fixture sharing B" } }).body.data,
    outsider = identityFixture(server, { body: { display_name: "Fixture outsider" } }).body.data;
  const cookie = (token: string) => browserSessionFixture(server, { token }).headers.get("set-cookie")!.split(";")[0]!;
  const ownerCookie = cookie(owner.token), peerCookie = cookie(peer.token), outsiderCookie = cookie(outsider.token);
  const { session } = server.service.createSession(owner.actor, { mode: "multi", title: "Sharing HTTP", idempotency_key: "http-sharing-session" });
  server.service.setMembership(owner.actor, session.id, peer.actor.user_id, "participant", "http-sharing-peer");
  const solo = server.service.createSession(peer.actor, { project_id: session.project_id, mode: "solo", title: "B Solo", idempotency_key: "http-sharing-solo" }).session;
  const profile = { harness: "codex" as const, provider: "openai", model: "fixture-http-model" };
  const runtime = server.service.registerRuntime(owner.actor, { session_id: session.id, device_id: owner.actor.device_id, ...profile,
    sharing_capability: { version: 1, isolated: true, project_only: true, cancellation: true, liveness_watchdog: true },
    context_deletion_version: 1, local_session_id: "fixture-http-native", capture_fidelity: "harness_transcript" });
  async function request(path: string, method = "GET", body?: unknown, credential = ownerCookie, native = false, origin?: string) {
    const response = await fetch(server.origin + path, { method, headers: {
      ...(native ? { authorization: `Bearer ${credential}` } : { cookie: credential, origin: origin ?? browserOrigin }),
      ...(native && origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as { data: any; error?: { code: string } } };
  }
  try {
    const readiness = { project_id: session.project_id, source_runtime_id: runtime.id, state: "ready", idempotency_key: "http-native-ready" };
    assert.equal((await request("/v1/agent-sharing-sources/availability", "POST", readiness, ownerCookie)).status, 403);
    assert.equal((await request("/v1/agent-sharing-sources/availability", "POST", readiness, peer.token, true)).status, 404);
    assert.equal((await request("/v1/agent-sharing-sources/availability", "POST", readiness, owner.token, true)).status, 200);
    const root = `/v1/projects/${session.project_id}/agent-shares`, input = { source_runtime_id: runtime.id, execution_profile: profile,
      allowed_user_ids: [peer.actor.user_id], expected_revision: null, idempotency_key: "http-create-share" };
    assert.equal((await request(root, "POST", input, owner.token, true)).status, 403);
    assert.equal((await request(root, "POST", input, ownerCookie, false, "https://foreign.example")).status, 403);
    const created = await request(root, "POST", input); assert.equal(created.status, 200);
    const shareId = created.body.data.share.id;
    const controlPath = `${root}/${shareId}/control`;
    assert.equal((await request(controlPath, "POST", { action: "disable", idempotency_key: "B-cannot-disable" }, peerCookie)).status, 404);
    const enabled = await request(controlPath, "POST", { action: "enable", expected_revision: 1, idempotency_key: "http-enable-share" });
    assert.equal(enabled.status, 200); assert.equal(enabled.body.data.share.available, true);
    const allowed = await request(root, "GET", undefined, peerCookie); AgentSharesResponseSchema.parse(allowed.body.data);
    assert.equal(allowed.body.data.shares[0].source_runtime_id, undefined);
    assert.equal((await request(root, "GET", undefined, outsiderCookie)).status, 404);
    const requestPath = `/v1/sessions/${solo.id}/shared-agent-requests`, requestInput = { share_id: shareId, share_revision: 2,
      content: "Compute 7 × 6", content_revision: 0, idempotency_key: "http-B-solo-shared-request" };
    assert.equal((await request(requestPath, "POST", requestInput, peerCookie)).body.error?.code, "agent_share_solo_disclosure_required");
    const accepted = await request(requestPath, "POST", { ...requestInput, solo_transfer_ack: true }, peerCookie);
    assert.equal(accepted.status, 202); SharedAgentRequestAcceptedSchema.parse(accepted.body.data);
    assert.equal((await request(requestPath, "POST", { ...requestInput, solo_transfer_ack: true }, peerCookie)).body.data.replayed, true);
    const jobId = accepted.body.data.job.id, claimPath = `/v1/agent-share-jobs/${jobId}/claim`, claimBody = { idempotency_key: "http-native-share-claim" };
    assert.equal((await request(claimPath, "POST", claimBody, ownerCookie)).body.error?.code, "native_device_required");
    assert.equal((await request(claimPath, "POST", claimBody, owner.token, true, server.origin)).status, 403);
    assert.equal((await request(claimPath, "POST", claimBody, peer.token, true)).status, 404);
    const claimed = await request(claimPath, "POST", claimBody, owner.token, true); assert.equal(claimed.status, 200);
    AgentShareJobClaimResponseSchema.parse(claimed.body.data);
    assert.equal((await request(`/v1/sessions/${solo.id}/agent-requests/${accepted.body.data.event.id}/claim`, "POST", { runtime_id: runtime.id }, owner.token, true)).status, 403);
    const stopped = await request(controlPath, "POST", { action: "disable", idempotency_key: "http-emergency-disable" });
    assert.equal(stopped.status, 200);
    const listed = await request(`/v1/agent-share-jobs?project_id=${session.project_id}`, "GET", undefined, owner.token, true);
    assert.equal(listed.body.data.jobs[0].status, "cancelled"); assert.equal(listed.body.data.jobs[0].cleanup_pending, true);
    const late = await request(`/v1/agent-share-jobs/${jobId}/complete`, "POST", { claim_attempt: 1, idempotency_key: "http-late-result",
      payload: { content: "42" }, observed_model: profile.model, outcome: "completed", executor_stopped: true }, owner.token, true);
    assert.equal(late.status, 409);
    const ack = await request(`/v1/agent-share-jobs/${jobId}/abort-ack`, "POST", { claim_attempt: 1, idempotency_key: "http-stopped-ack", executor_stopped: true }, owner.token, true);
    assert.equal(ack.status, 200); assert.equal(ack.body.data.job.cleanup_pending, false);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});
