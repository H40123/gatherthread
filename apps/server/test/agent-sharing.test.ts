import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SharedAgentRequestAcceptedSchema, AgentShareJobClaimResponseSchema, AgentShareLimitsSchema,
  type SharedExecutionCapability, type SharedAgentProfile } from "@gatherthread/protocol";
import { CollaborationDatabase, type DatabaseOptions } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { AgentSharing, AGENT_SHARE_LEASE_MS } from "../src/agent-sharing.js";
import { ApiError } from "../src/errors.js";

const capability: SharedExecutionCapability = { version: 1, isolated: true, project_only: true, cancellation: true, liveness_watchdog: true };
const profile: SharedAgentProfile = { harness: "codex", provider: "openai", model: "fixture-model", reasoning_effort: "high" };
function fixture(path = ":memory:", options: DatabaseOptions = {}) {
  let time = Date.parse("2026-10-15T01:00:00.000Z"); const clock = () => new Date(time);
  const db = new CollaborationDatabase(path, { ...options, clock, authTokenPepper: "fictional-sharing-test-pepper-long-enough" }), service = new CollaborationService(db);
  const owner = db.bootstrapIdentity({ display_name: "Fixture A", device_name: "Fixture A device" }).actor;
  const peer = db.createIdentity({ display_name: "Fixture B", device_name: "Fixture B device", can_create_projects: true }).actor;
  const other = db.createIdentity({ display_name: "Fixture C", device_name: "Fixture C device", can_create_projects: true }).actor;
  const { session } = service.createSession(owner, { mode: "multi", title: "Shared fixture", idempotency_key: "sharing-fixture-session" });
  service.setMembership(owner, session.id, peer.user_id, "participant", "sharing-fixture-peer");
  service.setMembership(owner, session.id, other.user_id, "participant", "sharing-fixture-other");
  const solo = service.createSession(peer, { project_id: session.project_id, mode: "solo", title: "B Solo", idempotency_key: "sharing-fixture-solo" }).session;
  const runtime = service.registerRuntime(owner, { session_id: session.id, device_id: owner.device_id, ...profile,
    execution_profiles: [{ provider: profile.provider, model: profile.model, reasoning_efforts: ["low", "high"] }],
    sharing_capability: capability, context_deletion_version: 1, local_session_id: "native-fixture-A", capture_fidelity: "harness_transcript" });
  const sharing = new AgentSharing(service, { clock, autoStart: false });
  sharing.sourceAvailability(owner, { project_id: session.project_id, source_runtime_id: runtime.id,
    state: "ready", idempotency_key: "fixture-native-ready" });
  const save = (limits = AgentShareLimitsSchema.parse({}), users = [peer.user_id, other.user_id]) => sharing.save(owner, session.project_id,
    { source_runtime_id: runtime.id, execution_profile: profile, allowed_user_ids: users, limits, expected_revision: null,
      idempotency_key: "sharing-fixture-save" }).share;
  const enable = (id: string) => sharing.control(owner, session.project_id, id, { action: "enable",
    expected_revision: sharing.store.row(id).revision, idempotency_key: `fixture-enable-${randomUUID()}` }).share;
  const start = (id: string, requester = peer, target = session, key = `fixture-start-${randomUUID()}`, ack = false) => sharing.start(requester, target.id,
    { share_id: id, share_revision: sharing.store.row(id).revision, content: "Compute 6 × 7 without private data", content_revision: target.content_revision ?? 0,
      solo_transfer_ack: ack, idempotency_key: key });
  const claim = (id: string) => sharing.claim(owner, id, { idempotency_key: `fixture-claim-${id}` });
  const complete = (id: string) => sharing.complete(owner, id, { claim_attempt: 1, idempotency_key: `fixture-complete-${id}`,
    payload: { content: "42", status: "completed", capture_fidelity: "harness_transcript", source_harness: "codex" },
    observed_model: profile.model, observed_reasoning_effort: profile.reasoning_effort!, outcome: "completed", executor_stopped: true });
  return { db, service, owner, peer, other, session, solo, runtime, sharing, save, enable, start, claim, complete,
    advance: (ms: number) => { time += ms; }, clock, close: () => { sharing.close(); db.close(); } };
}
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

test("native sources start offline before any grant; offline is source-scoped and lock is device-scoped", () => {
  const f = fixture(); try {
    const secondProfile: SharedAgentProfile = { harness: "deepseek-harness", provider: "deepseek", model: "fixture-dsh" };
    const second = f.service.registerRuntime(f.owner, { session_id: f.session.id, device_id: f.owner.device_id,
      ...secondProfile, sharing_capability: capability, context_deletion_version: 1,
      local_session_id: "native-fixture-dsh", capture_fidelity: "harness_transcript" });
    const sourceInput = { project_id: f.session.project_id, source_runtime_id: second.id };
    assert.equal(f.sharing.sources(f.owner, f.session.project_id).runtimes.find(item => item.id === second.id)?.sharing_availability, "offline");
    const saveInput = { source_runtime_id: second.id, execution_profile: secondProfile, allowed_user_ids: [f.peer.user_id],
      limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "source-dsh-save" };
    assert.throws(() => f.sharing.save(f.owner, f.session.project_id, saveInput), code("agent_share_offline"));
    assert.throws(() => f.sharing.sourceAvailability(f.peer, { ...sourceInput, state: "ready", idempotency_key: "wrong-native-owner" }), code("not_found"));
    const ready = { ...sourceInput, state: "ready" as const, idempotency_key: "source-dsh-first-ready" };
    assert.deepEqual(f.sharing.sourceAvailability(f.owner, ready), { shares: [] });
    const codex = f.enable(f.save().id), dsh = f.enable(f.sharing.save(f.owner, f.session.project_id, saveInput).share.id);
    f.sharing.sourceAvailability(f.owner, { ...sourceInput, state: "offline", idempotency_key: "source-dsh-offline" });
    assert.equal(f.sharing.store.row(dsh.id).enabled, 0); assert.equal(f.sharing.store.row(codex.id).enabled, 1);
    f.sharing.sourceAvailability(f.owner, ready);
    assert.equal(f.sharing.sources(f.owner, f.session.project_id).runtimes.find(item => item.id === second.id)?.sharing_availability, "offline");
    assert.throws(() => f.sharing.sourceAvailability(f.owner, { ...ready, state: "unsupported" }), code("idempotency_conflict"));
    f.sharing.sourceAvailability(f.owner, { ...ready, idempotency_key: "source-dsh-new-ready" });
    assert.equal(f.sharing.store.row(dsh.id).enabled, 0); f.enable(dsh.id);
    f.sharing.sourceAvailability(f.owner, { project_id: f.session.project_id, source_runtime_id: f.runtime.id,
      state: "locked", idempotency_key: "source-device-locked" });
    assert.equal(f.sharing.store.row(dsh.id).enabled, 0); assert.equal(f.sharing.store.row(codex.id).enabled, 0);
    assert.equal(f.sharing.sources(f.owner, f.session.project_id).runtimes.every(item => item.sharing_availability === "locked"), true);
  } finally { f.close(); }
});
test("availability receipt exhaustion cannot block an emergency stop or reopen the saturated source", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id);
    for (let index = 1; index < 1024; index++) f.db.sqlite.prepare(`INSERT INTO agent_share_source_receipts
      (runtime_id,owner_user_id,idempotency_key,input_digest,created_at) VALUES(?,?,?,?,?)`)
      .run(f.runtime.id, f.owner.user_id, `source-fixture-${index}`, "fixture-digest", f.clock().toISOString());
    const input = { project_id: f.session.project_id, source_runtime_id: f.runtime.id };
    f.sharing.sourceAvailability(f.owner, { ...input, state: "offline", idempotency_key: "source-full-emergency" });
    assert.equal(f.sharing.store.row(share.id).enabled, 0);
    assert.equal(f.sharing.store.job(started.job.id).status, "cancelled");
    assert.equal(f.sharing.store.job(started.job.id).cleanup_pending, 1);
    assert.throws(() => f.sharing.sourceAvailability(f.owner, { ...input, state: "ready", idempotency_key: "source-full-reopen" }), code("agent_share_source_capacity"));
    assert.throws(() => f.enable(share.id), code("agent_share_source_capacity"));
  } finally { f.close(); }
});
test("source readiness is independent of its default model while grants keep exact catalog validation", () => {
  const f = fixture(); try {
    const advertised: SharedAgentProfile = { harness: "codex", provider: "fixture-alt", model: "fixture-current-model", reasoning_effort: "high" };
    const runtime = f.service.registerRuntime(f.owner, { session_id: f.session.id, device_id: f.owner.device_id,
      harness: "codex", provider: "old-provider", model: "old-default-model", local_session_id: "fixture-stale-default",
      execution_profiles: [{ provider: advertised.provider, model: advertised.model, reasoning_efforts: ["high"] }],
      sharing_capability: capability, context_deletion_version: 1, capture_fidelity: "harness_transcript" });
    f.sharing.sourceAvailability(f.owner, { project_id: f.session.project_id, source_runtime_id: runtime.id,
      state: "ready", idempotency_key: "stale-default-native-ready" });
    const input = { source_runtime_id: runtime.id, execution_profile: advertised, allowed_user_ids: [f.peer.user_id],
      limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "stale-default-valid-share" };
    assert.throws(() => f.sharing.save(f.owner, f.session.project_id, { ...input, execution_profile:
      { harness: "codex", provider: runtime.provider, model: runtime.model }, idempotency_key: "stale-default-invalid-share" }), code("agent_share_profile_changed"));
    const share = f.enable(f.sharing.save(f.owner, f.session.project_id, input).share.id);
    const job = f.start(share.id), claim = f.claim(job.job.id);
    assert.deepEqual(claim.capsule.job.execution_profile, advertised);
    f.db.sqlite.prepare("UPDATE runtimes SET execution_profiles_json=? WHERE id=?")
      .run(JSON.stringify([{ provider: "another", model: "changed" }]), runtime.id);
    assert.throws(() => f.sharing.renewLease(f.owner, job.job.id,
      { claim_attempt: 1, idempotency_key: "stale-default-catalog-change" }), code("agent_share_lease_expired"));
    assert.equal(f.sharing.store.row(share.id).enabled, 1, "catalog edits do not disable a source-level grant");
    assert.equal(f.sharing.store.job(job.job.id).status, "cancelled");
    assert.throws(() => f.start(share.id), code("agent_share_profile_changed"), "legacy omitted selections never switch to another model");
  } finally { f.close(); }
});

test("sharing is explicit, owner-only, project-scoped and sanitized for recipients", () => {
  const f = fixture(); try {
    const share = f.save(); assert.equal(share.enabled, false); assert.equal(share.available, false);
    assert.ok(share.source_runtime_id); assert.deepEqual(share.allowed_user_ids, [f.peer.user_id, f.other.user_id].sort());
    const enabled = f.enable(share.id); assert.equal(enabled.available, true);
    const recipient = f.sharing.list(f.peer, f.session.project_id).shares[0]!;
    assert.equal(recipient.owner_display_name, "Fixture A");
    for (const field of ["owner_device_id", "source_runtime_id", "allowed_user_ids", "total_usage"]) assert.equal(Object.hasOwn(recipient, field), false);
    assert.throws(() => f.sharing.control(f.peer, f.session.project_id, share.id, { action: "disable", idempotency_key: "peer-cannot-revoke" }), code("not_found"));
    assert.equal(f.sharing.sources(f.peer, f.session.project_id).runtimes.length, 0);
    assert.equal(f.sharing.sources(f.owner, f.session.project_id).runtimes[0]?.sharing_capability?.version, 1);
    assert.equal(Object.hasOwn(f.sharing.sources(f.owner, f.session.project_id).runtimes[0]!, "local_session_id"), false);
  } finally { f.close(); }
});
test("B may request A in B Solo only after disclosure; ordinary ACL and claims remain unchanged", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id);
    assert.throws(() => f.start(share.id, f.peer, f.solo), code("agent_share_solo_disclosure_required"));
    const started = f.start(share.id, f.peer, f.solo, "solo-shared-request", true);
    SharedAgentRequestAcceptedSchema.parse(started);
    assert.throws(() => f.service.claimAgentRequest(f.owner, f.solo.id, started.event.id, f.runtime.id), code("forbidden"));
    assert.throws(() => f.service.appendEvent(f.peer, f.solo.id, { type: "agent_request", visibility: "session",
      idempotency_key: "forged-shared-request", payload: started.event.payload }), code("forbidden"));
    const claim = f.claim(started.job.id); AgentShareJobClaimResponseSchema.parse(claim);
    assert.equal(claim.capsule.job.requester_user_id, f.peer.user_id); assert.equal(claim.capsule.sandbox_scope, "project_only");
    assert.equal(claim.capsule.source_runtime_id, f.runtime.id);
    assert.throws(() => f.sharing.claim(f.peer, started.job.id, { idempotency_key: "wrong-owner-claim" }), code("not_found"));
    f.advance(1234); const completed = f.complete(started.job.id);
    assert.equal(completed.event.actor_user_id, f.peer.user_id);
    assert.equal(completed.event.runtime_provenance?.user_id, f.owner.user_id);
    assert.equal(completed.event.runtime_provenance?.runtime_id, undefined);
    assert.equal(completed.event.shared_execution?.executor_owner_user_id, f.owner.user_id);
    assert.equal((completed.event.payload as { shared_agent: { executor_owner_user_id: string } }).shared_agent.executor_owner_user_id, f.owner.user_id);
    assert.equal(completed.job.status, "completed"); assert.equal(completed.job.cleanup_pending, false);
    assert.equal(f.sharing.store.usage(f.sharing.store.row(share.id), f.peer.user_id).seconds_used, 2);
    assert.equal(f.complete(started.job.id).event.id, completed.event.id);
    assert.throws(() => f.service.appendEvent(f.owner, f.solo.id, { type: "human_chat", visibility: "session",
      idempotency_key: "A-still-cannot-write", payload: { content: "No" } }), code("forbidden"));
  } finally { f.close(); }
});
test("single request retries charge one call and mismatched keys cannot alter the task", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), first = f.start(share.id, f.peer, f.session, "same-shared-request");
    assert.equal(f.start(share.id, f.peer, f.session, "same-shared-request").event.id, first.event.id);
    assert.equal(f.sharing.store.usage(f.sharing.store.row(share.id), f.peer.user_id).calls, 1);
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { share_id: share.id, share_revision: share.revision, content: "Different",
      content_revision: 0, solo_transfer_ack: false, idempotency_key: "same-shared-request" }), code("idempotency_conflict"));
    f.claim(first.job.id);
    assert.equal(f.claim(first.job.id).replayed, true);
    assert.throws(() => f.sharing.claim(f.owner, first.job.id, { idempotency_key: "different-claim" }), code("conflict"));
  } finally { f.close(); }
});
test("disable cancels queues and fences running output; cleanup holds its native slot", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), first = f.start(share.id), queued = f.start(share.id, f.other);
    f.claim(first.job.id);
    const stopped = f.sharing.control(f.owner, f.session.project_id, share.id, { action: "disable", idempotency_key: "owner-emergency-stop" });
    assert.equal(stopped.share.enabled, false);
    assert.equal(f.sharing.store.job(first.job.id).status, "cancelled");
    assert.equal(f.sharing.store.job(first.job.id).cleanup_pending, 1);
    assert.equal(f.sharing.store.job(queued.job.id).status, "cancelled");
    assert.equal(f.sharing.store.job(queued.job.id).seconds_reserved, 0);
    assert.throws(() => f.complete(first.job.id), code("agent_share_lease_expired"));
    assert.equal(f.sharing.control(f.owner, f.session.project_id, share.id, { action: "disable", idempotency_key: "owner-emergency-stop" }).replayed, true);
    const enabled = f.enable(share.id), next = f.start(enabled.id);
    assert.throws(() => f.claim(next.job.id), code("agent_share_busy"));
    f.advance(3000);
    const ack = f.sharing.abortAck(f.owner, first.job.id, { claim_attempt: 1, executor_stopped: true, idempotency_key: "exact-exit-ack" });
    assert.equal(ack.job.cleanup_pending, false); assert.equal(f.sharing.store.job(first.job.id).seconds_used, 3);
    assert.equal(f.claim(next.job.id).job.status, "running");
    assert.throws(() => f.sharing.abortAck(f.owner, next.job.id, { claim_attempt: 1, executor_stopped: true, idempotency_key: "cannot-release-live" }), code("conflict"));
  } finally { f.close(); }
});
test("per-member and total daily duration reservations are atomic and survive disable", () => {
  const f = fixture(); try {
    const limits = AgentShareLimitsSchema.parse({ per_member_daily_calls: 2, per_member_daily_seconds: 720,
      total_daily_calls: 3, total_daily_seconds: 1440, max_request_seconds: 720 });
    const share = f.enable(f.save(limits).id), first = f.start(share.id);
    assert.throws(() => f.start(share.id), code("agent_share_daily_limit"));
    const second = f.start(share.id, f.other);
    assert.equal(f.sharing.store.usage(f.sharing.store.row(share.id), "").seconds_reserved, 1440);
    f.sharing.cancelRequest(f.peer, f.session.id, first.event.id, { idempotency_key: "cancel-queued-first" });
    assert.equal(f.sharing.store.usage(f.sharing.store.row(share.id), f.peer.user_id).calls, 1);
    f.start(share.id);
    assert.throws(() => f.start(share.id), code("agent_share_daily_limit"));
    assert.equal(f.sharing.store.usage(f.sharing.store.row(share.id), "").calls, 3);
    assert.equal(f.sharing.store.job(second.job.id).status, "queued");
  } finally { f.close(); }
});
test("locked, offline and lapsed lease disable the grant; readiness never reenables", () => {
  for (const reason of ["locked", "offline", "lease"] as const) {
    const f = fixture(); try {
      const share = f.enable(f.save().id), first = f.start(share.id); f.claim(first.job.id);
      if (reason === "lease") { f.advance(AGENT_SHARE_LEASE_MS + 1); f.sharing.pump(); }
      else f.sharing.availability(f.owner, share.id, { state: reason, idempotency_key: `availability-${reason}` });
      assert.equal(f.sharing.store.row(share.id).enabled, 0); assert.equal(f.sharing.store.job(first.job.id).status, "cancelled");
      f.service.heartbeatRuntime(f.owner, f.runtime.id);
      f.sharing.availability(f.owner, share.id, { state: "ready", idempotency_key: "availability-ready" });
      assert.equal(f.sharing.store.row(share.id).enabled, 0); assert.equal(f.sharing.store.members(f.sharing.store.row(share.id)).length, 2);
      assert.throws(() => f.complete(first.job.id), code("agent_share_lease_expired"));
      assert.throws(() => f.sharing.availability(f.peer, share.id, { state: "ready", idempotency_key: "B-cannot-set-A-ready" }), code("not_found"));
    } finally { f.close(); }
  }
});
test("model changes, viewers and either party's revoked device fail closed", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), first = f.start(share.id); f.claim(first.job.id);
    assert.throws(() => f.sharing.validateSelection(f.peer, f.session.id, { share_id: share.id, share_revision: share.revision,
      ...profile, model: "other-model" }, true), code("agent_share_profile_changed"));
    f.service.setMembership(f.owner, f.session.id, f.peer.user_id, "viewer", "downgrade-shared-peer"); f.sharing.pump();
    assert.equal(f.sharing.store.job(first.job.id).status, "cancelled");
    assert.equal(f.sharing.list(f.peer, f.session.project_id).shares.length, 0);
    assert.throws(() => f.start(share.id), code("forbidden"));
    f.service.setMembership(f.owner, f.session.id, f.peer.user_id, "participant", "restore-shared-peer");
    f.db.revokeDevice(f.owner, f.owner.device_id); f.sharing.pump();
    assert.equal(f.sharing.store.row(share.id).enabled, 0);
  } finally { f.close(); }
});
test("unsupported connectors cannot share and profile changes revoke all prior grants", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), started = f.start(share.id);
    f.service.registerRuntime(f.owner, { session_id: f.session.id, device_id: f.owner.device_id, ...profile,
      context_deletion_version: 1, local_session_id: "native-fixture-A", capture_fidelity: "harness_transcript" });
    f.sharing.pump(); assert.equal(f.sharing.store.row(share.id).enabled, 0);
    assert.equal(f.sharing.store.job(started.job.id).status, "cancelled");
    assert.throws(() => f.enable(share.id), code("agent_share_unsupported"));
  } finally { f.close(); }
});
test("erasure clears derived shared capsules inside the canonical transaction", () => {
  const f = fixture(); try {
    const message = f.service.appendEvent(f.peer, f.solo.id, { type: "human_chat", visibility: "session",
      idempotency_key: "shared-capsule-source", payload: { content: "Fictional source to erase" } });
    const share = f.enable(f.save().id), started = f.start(share.id, f.peer, f.solo, "erasure-shared-request", true);
    const claim = f.claim(started.job.id); assert.match(JSON.stringify(claim.capsule.context), /Fictional source/);
    f.service.deleteMessage(f.peer, f.solo.id, message.id, "erase-shared-source");
    const erased = f.sharing.store.job(started.job.id);
    assert.equal(erased.status, "cancelled"); assert.equal(erased.content, ""); assert.equal(erased.context_json, "{}");
    assert.throws(() => f.complete(started.job.id), code("agent_share_lease_expired"));
    assert.equal(erased.cleanup_pending, 1);
  } finally { f.close(); }
});
test("restart retains quotas and allowlist but requires manual reenable", () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-sharing-restart-")), f = fixture(join(directory, "fixture.sqlite"));
  try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id); f.sharing.close();
    const restored = new AgentSharing(f.service, { clock: f.clock, autoStart: false });
    try {
      assert.equal(restored.store.row(share.id).enabled, 0); assert.equal(restored.store.row(share.id).disabled_reason, "restart");
      assert.equal(restored.store.members(restored.store.row(share.id)).length, 2);
      assert.equal(restored.store.usage(restored.store.row(share.id), f.peer.user_id).calls, 1);
      assert.equal(restored.store.job(started.job.id).cleanup_pending, 1);
    } finally { restored.close(); }
  } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
});
test("shared progress is exact, allowlisted, redacted and immutable on retry", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id);
    const input = { claim_attempt: 1, idempotency_key: "bounded-progress-once", observed_model: profile.model,
      observed_reasoning_effort: profile.reasoning_effort!, payload: { content: "Working", phase: "lifecycle", status: "thinking" } };
    const progress = f.sharing.progress(f.owner, started.job.id, input);
    assert.equal(progress.event.actor_user_id, f.peer.user_id);
    assert.equal(f.sharing.progress(f.owner, started.job.id, input).event.id, progress.event.id);
    assert.throws(() => f.sharing.progress(f.owner, started.job.id, { ...input, payload: { ...input.payload, content: "Different" } }), code("idempotency_conflict"));
    assert.throws(() => f.sharing.progress(f.owner, started.job.id, { ...input, idempotency_key: "wrong-model-progress", observed_model: "another" }), code("agent_share_profile_changed"));
    assert.throws(() => f.sharing.progress(f.owner, started.job.id, { ...input, idempotency_key: "private-progress-fields", payload: { ...input.payload, hidden_reasoning: "private" } }));
    assert.throws(() => f.sharing.complete(f.owner, started.job.id, { ...input, idempotency_key: "forged-final-metadata", outcome: "completed", executor_stopped: true,
      payload: { content: "Result", shared_agent: {} } }), code("forbidden"));
    assert.throws(() => f.sharing.complete(f.owner, started.job.id, { ...input, idempotency_key: "raw-final-private-fields", outcome: "completed", executor_stopped: true,
      payload: { content: "Result", private_instructions: "private" } }));
  } finally { f.close(); }
});
test("ordinary native claims and shared jobs share one exact project device execution slot", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), shared = f.start(share.id); f.claim(shared.job.id);
    const own = f.service.appendEvent(f.owner, f.session.id, { type: "agent_request", visibility: "session", idempotency_key: "A-own-request-during-shared",
      payload: { content: "Owner's ordinary task", execution_profile: { harness: profile.harness, provider: profile.provider,
        model: profile.model, reasoning_effort: profile.reasoning_effort!, runtime_id: f.runtime.id } } });
    assert.throws(() => f.service.claimAgentRequest(f.owner, f.session.id, own.id, f.runtime.id), code("runtime_busy"));
    f.complete(shared.job.id); const claim = f.service.claimAgentRequest(f.owner, f.session.id, own.id, f.runtime.id);
    assert.equal(claim.status, "claimed");
    const next = f.start(share.id); assert.throws(() => f.claim(next.job.id), code("agent_share_busy"));
  } finally { f.close(); }
});
test("account deletion anonymizes executor links on B-owned Multi answers and erases private broker copies", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id); const completed = f.complete(started.job.id);
    f.db.transferProjectOwnership(f.owner, f.session.project_id, f.peer.user_id, "transfer-before-delete-A");
    f.db.deleteAccount(f.owner);
    const event = f.db.getEvent(f.session.id, completed.event.id), shared = (event.payload as { shared_agent: { executor_owner_user_id: string; executor_owner_display_name: string } }).shared_agent;
    assert.equal(event.actor_user_id, f.peer.user_id);
    assert.equal(shared.executor_owner_user_id, "deleted-account"); assert.equal(shared.executor_owner_display_name, "Deleted member");
    assert.equal(event.shared_execution?.executor_owner_user_id, "deleted-account");
    assert.equal(event.runtime_provenance?.user_id, "deleted-account");
    assert.equal(f.sharing.store.job(started.job.id).owner_user_id, "deleted-account");
    assert.equal(f.sharing.store.job(started.job.id).context_json, "{}");
    assert.equal(f.sharing.list(f.peer, f.session.project_id).shares.length, 0);
    assert.equal(f.db.listSessionAvatarProfiles(f.peer, f.session.id).some(value => value.user_id === f.owner.user_id), false);
  } finally { f.close(); }
});
test("device revocation fences and clears broker tasks in the same authorization transaction", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id);
    f.db.revokeDevice(f.peer, f.peer.device_id);
    const job = f.sharing.store.job(started.job.id);
    assert.equal(job.status, "cancelled"); assert.equal(job.context_json, "{}"); assert.equal(job.cleanup_pending, 1);
    f.sharing.pump();
    assert.ok(f.sharing.store.job(started.job.id).response_event_id);
    assert.throws(() => f.complete(started.job.id), code("agent_share_lease_expired"));
  } finally { f.close(); }
});
test("grant mutations keep daily consumption and saturated budgets disable discovery availability", () => {
  const f = fixture(); try {
    const limits = AgentShareLimitsSchema.parse({ per_member_daily_calls: 1, total_daily_calls: 1 });
    const share = f.enable(f.save(limits).id), started = f.start(share.id);
    const listed = f.sharing.list(f.peer, f.session.project_id).shares[0]!;
    assert.equal(listed.enabled, true); assert.equal(listed.available, false); assert.equal(listed.disabled_reason, "daily_limit");
    f.sharing.cancelRequest(f.peer, f.session.id, started.event.id, { idempotency_key: "cancel-without-call-refund" });
    f.sharing.control(f.owner, f.session.project_id, share.id, { action: "disable", idempotency_key: "turn-off-after-limit" }); f.enable(share.id);
    assert.throws(() => f.start(share.id), code("agent_share_daily_limit"));
  } finally { f.close(); }
});
test("a model answer that exceeds storage commits one fixed failure and releases confirmed native cleanup", () => {
  const f = fixture(":memory:", { maxEventBytes: 4096 }); try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id);
    const input = { claim_attempt: 1, idempotency_key: "oversized-answer-completion", observed_model: profile.model,
      observed_reasoning_effort: profile.reasoning_effort!, payload: { content: "x".repeat(8192) }, outcome: "completed" as const, executor_stopped: true as const };
    const result = f.sharing.complete(f.owner, started.job.id, input);
    assert.equal(result.job.status, "failed"); assert.equal(result.job.error_code, "storage_quota_exceeded");
    assert.equal(result.job.cleanup_pending, false);
    assert.equal(result.event.runtime_provenance, null);
    assert.equal(f.sharing.complete(f.owner, started.job.id, input).event.id, result.event.id);
    const answers = f.service.replay(f.peer, f.session.id, 0, 100).events.filter(event => event.reply_to_event_id === started.event.id && event.type === "agent_response");
    assert.equal(answers.length, 1); assert.equal(JSON.stringify(answers[0]).includes("x".repeat(128)), false);
  } finally { f.close(); }
});
test("UTC daily reset retains outstanding older-day reservations and accepted calls are never refunded", () => {
  const f = fixture(); try {
    const limits = AgentShareLimitsSchema.parse({ per_member_daily_calls: 1, total_daily_calls: 1 });
    const share = f.enable(f.save(limits).id), started = f.start(share.id); f.claim(started.job.id);
    f.advance(86400000); f.service.heartbeatRuntime(f.owner, f.runtime.id); f.sharing.pump();
    assert.equal(f.sharing.store.row(share.id).enabled, 1); assert.equal(f.sharing.store.job(started.job.id).cleanup_pending, 1);
    const old = f.db.sqlite.prepare("SELECT calls,seconds_reserved FROM agent_share_daily_usage WHERE utc_day='2026-10-15' AND member_user_id=?").get(f.peer.user_id);
    assert.equal(old?.calls, 1); assert.equal(old?.seconds_reserved, 720);
    f.sharing.abortAck(f.owner, started.job.id, { claim_attempt: 1, executor_stopped: true, idempotency_key: "next-day-cleanup-ack" });
    f.enable(share.id); const next = f.start(share.id);
    assert.equal(next.job.status, "queued"); assert.equal(f.sharing.store.usage(f.sharing.store.row(share.id), f.peer.user_id).calls, 1);
  } finally { f.close(); }
});
test("quotes and mentions retain canonical references and reject private, foreign or mismatched sources", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), source = f.service.appendEvent(f.other, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "quote-a-public-source", payload: { content: "Please calculate the result" } });
    const label = `@${f.other.display_name}`, input = { share_id: share.id, share_revision: share.revision, content: `${label} use the quotation`,
      content_revision: 0, solo_transfer_ack: false, reply_to_event_id: source.id,
      mentions: [{ user_id: f.other.user_id, start: 0, end: label.length }], idempotency_key: "shared-quote-and-mention" };
    const started = f.sharing.start(f.peer, f.session.id, input);
    assert.equal(started.event.reply_to_event_id, source.id);
    assert.deepEqual((started.event.payload as { mentions: unknown }).mentions, input.mentions);
    const claim = f.claim(started.job.id); assert.equal(claim.capsule.reply_to_event_id, source.id);
    assert.equal(claim.capsule.quoted_message?.content, "Please calculate the result");
    assert.equal(claim.capsule.context.items.some(item => item.event_id === source.id), true);
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...input, reply_to_event_id: null }), code("idempotency_conflict"));
    const privateSource = f.service.appendEvent(f.owner, f.session.id, { type: "human_chat", visibility: "owner_only",
      idempotency_key: "quote-a-private-source", payload: { content: "Private source" } });
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...input, reply_to_event_id: privateSource.id, idempotency_key: "private-source-denied" }), code("forbidden"));
    const foreign = f.service.createSession(f.owner, { mode: "multi", title: "Other project", idempotency_key: "foreign-project-session" }).session;
    const foreignMessage = f.service.appendEvent(f.owner, foreign.id, { type: "human_chat", visibility: "session",
      idempotency_key: "foreign-source-message", payload: { content: "Outside project" } });
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...input, reply_to_event_id: foreignMessage.id, idempotency_key: "foreign-source-denied" }), code("not_found"));
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...input, mentions: [{ user_id: f.other.user_id, start: 1, end: label.length }],
      idempotency_key: "wrong-mention-range" }), code("conflict"));
    const before = f.sharing.store.usage(f.sharing.store.row(share.id), f.peer.user_id).calls;
    assert.equal(before, 1);
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...input, mentions: [{ user_id: f.owner.user_id, start: 0, end: label.length }],
      idempotency_key: "wrong-mention-name" }), code("conflict"));
    assert.equal(f.sharing.store.usage(f.sharing.store.row(share.id), f.peer.user_id).calls, before);
  } finally { f.close(); }
});
test("saturated progress receipts retain bounded independent cancellation and cleanup receipts", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id);
    for (let index = 0; index < 254; index++) f.db.sqlite.prepare("INSERT INTO agent_share_job_receipts(job_id,idempotency_key,input_digest,event_id,created_at) VALUES(?,?,?,NULL,?)")
      .run(started.job.id, `fictional-progress-${index}`, "fictional-digest", f.clock().toISOString());
    assert.throws(() => f.sharing.progress(f.owner, started.job.id, { claim_attempt: 1, idempotency_key: "one-more-progress", observed_model: profile.model,
      observed_reasoning_effort: profile.reasoning_effort!, payload: { content: "Working", phase: "lifecycle", status: "thinking" } }), code("agent_share_progress_limit"));
    f.sharing.cancelRequest(f.peer, f.session.id, started.event.id, { idempotency_key: "reserved-stop-receipt" });
    f.sharing.cancelRequest(f.peer, f.session.id, started.event.id, { idempotency_key: "last-ordinary-noop-receipt" });
    assert.throws(() => f.sharing.cancelRequest(f.peer, f.session.id, started.event.id, { idempotency_key: "too-many-noop-receipts" }), code("agent_share_progress_limit"));
    const input = { claim_attempt: 1, executor_stopped: true as const, idempotency_key: "reserved-exit-receipt" };
    assert.equal(f.sharing.abortAck(f.owner, started.job.id, input).job.cleanup_pending, false);
    assert.equal(f.sharing.abortAck(f.owner, started.job.id, input).replayed, true);
    assert.throws(() => f.sharing.abortAck(f.owner, started.job.id, { ...input, idempotency_key: "unbounded-noop-ack" }), code("agent_share_progress_limit"));
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_share_job_receipts WHERE job_id=?").get(started.job.id)?.count, 257);
  } finally { f.close(); }
});
test("long-lived sharing ignores the initial browser expiry and follows the exact native source authority", () => {
  const f = fixture(); try {
    const authorization = f.service.createDeviceAuthorization(f.owner), browser = f.service.claimDeviceAuthorization({
      authorization_token: authorization.authorization_token, device_id: "fixture-second-A-browser", device_name: "Second A browser" }).actor;
    const saved = f.sharing.save(browser, f.session.project_id, { source_runtime_id: f.runtime.id, execution_profile: profile,
      allowed_user_ids: [f.peer.user_id], limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "second-browser-save-share" });
    const share = f.sharing.control(browser, f.session.project_id, saved.share.id, { action: "enable", expected_revision: 1, idempotency_key: "second-browser-enable" }).share;
    const request = f.start(share.id); f.claim(request.job.id);
    f.db.revokeDevice(f.owner, browser.device_id);
    assert.equal(f.sharing.store.row(share.id).enabled, 1); assert.equal(f.sharing.store.job(request.job.id).status, "running");
    f.sharing.control(f.owner, f.session.project_id, share.id, { action: "disable", idempotency_key: "new-browser-explicit-disable" });
    f.sharing.abortAck(f.owner, request.job.id, { claim_attempt: 1, executor_stopped: true, idempotency_key: "second-browser-cancel-ack" });
    const next = f.enable(share.id);
    assert.equal(next.enabled, true); assert.equal(next.source_runtime_id, f.runtime.id);
    assert.equal(f.sharing.store.row(share.id).authorizing_device_id, f.owner.device_id);
    f.db.revokeDevice(f.owner, f.owner.device_id); assert.equal(f.sharing.store.row(share.id).enabled, 0);
  } finally { f.close(); }
});
test("historical untrusted payload metadata cannot impersonate a shared executor; proof survives private job cleanup", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), started = f.start(share.id); f.claim(started.job.id); const completed = f.complete(started.job.id);
    assert.equal(f.db.getEvent(f.session.id, started.event.id).shared_execution?.job_id, started.job.id);
    const ordinary = f.service.appendEvent(f.peer, f.session.id, { type: "agent_request", visibility: "session",
      idempotency_key: "legacy-untrusted-shared-namespace", payload: { content: "An old ordinary request" } });
    f.db.sqlite.prepare("UPDATE events SET payload_json=? WHERE id=?")
      .run(JSON.stringify({ content: "An old spoofed request", shared_agent: started.event.shared_execution }), ordinary.id);
    const old = f.db.getEvent(f.session.id, ordinary.id); assert.equal(old.shared_execution, undefined);
    f.db.sqlite.prepare("DELETE FROM agent_share_jobs WHERE id=?").run(started.job.id);
    assert.equal(f.db.getEvent(f.session.id, completed.event.id).shared_execution?.executor_owner_user_id, f.owner.user_id);
    assert.throws(() => f.service.claimAgentRequest(f.peer, f.session.id, started.event.id, f.runtime.id), code("forbidden"));
    f.service.deleteMessage(f.peer, f.session.id, completed.event.id, "erase-trusted-shared-answer");
    assert.equal(f.db.getEvent(f.session.id, completed.event.id).shared_execution, undefined);
  } finally { f.close(); }
});
test("an advertised alternate provider/model is attributed to the exact granted route", () => {
  const f = fixture(); try {
    const alternate: SharedAgentProfile = { harness: "codex", provider: "fixture-alternate-provider", model: "fixture-alternate-model" };
    f.service.registerRuntime(f.owner, { session_id: f.session.id, device_id: f.owner.device_id, ...profile,
      execution_profiles: [{ provider: profile.provider, model: profile.model, reasoning_efforts: ["high"] },
        { provider: alternate.provider, model: alternate.model }], sharing_capability: capability, context_deletion_version: 1,
      local_session_id: "native-fixture-A", capture_fidelity: "harness_transcript" });
    const share = f.sharing.save(f.owner, f.session.project_id, { source_runtime_id: f.runtime.id, execution_profile: alternate,
      allowed_user_ids: [f.peer.user_id], limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "share-alternate-route" }).share;
    f.enable(share.id); const started = f.start(share.id); f.claim(started.job.id);
    const result = f.sharing.complete(f.owner, started.job.id, { claim_attempt: 1, idempotency_key: "complete-alternate-route",
      payload: { content: "Alternate model answer" }, observed_model: alternate.model, outcome: "completed", executor_stopped: true });
    assert.equal(result.event.runtime_provenance?.provider, alternate.provider);
    assert.equal(result.event.shared_execution?.execution_profile.provider, alternate.provider);
    assert.equal(result.event.runtime_provenance?.model, alternate.model);
    assert.equal(result.event.runtime_provenance?.capture_fidelity, "harness_transcript");
  } finally { f.close(); }
});

test("source autosave/start is atomic and borrowers select exact catalog models and efforts", () => {
  const f = fixture(); try {
    const alternate = { harness: "codex" as const, provider: "fixture-other", model: "fixture-alternate", reasoning_effort: "medium" };
    f.db.sqlite.prepare("UPDATE runtimes SET execution_profiles_json=? WHERE id=?").run(JSON.stringify([
      { provider: profile.provider, model: profile.model, reasoning_efforts: ["low", "high"] },
      { provider: alternate.provider, model: alternate.model, reasoning_efforts: ["medium", "high"] }]), f.runtime.id);
    const input = { source_runtime_id: f.runtime.id, allowed_user_ids: [f.peer.user_id], enabled: true,
      limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "atomic-sharing-start" };
    const saved = f.sharing.save(f.owner, f.session.project_id, input);
    assert.equal(saved.share.enabled, true); assert.equal(saved.share.available, true);
    assert.equal(f.sharing.save(f.owner, f.session.project_id, input).replayed, true);
    assert.equal(f.sharing.list(f.peer, f.session.project_id).shares[0]!.execution_profiles!.length, 2);
    const body = { share_id: saved.share.id, share_revision: saved.share.revision, execution_profile: alternate,
      content: "Use the selected alternate model", content_revision: 0, solo_transfer_ack: false, idempotency_key: "borrow-alternate" };
    const started = f.sharing.start(f.peer, f.session.id, body);
    assert.deepEqual(started.job.execution_profile, alternate);
    assert.deepEqual(f.claim(started.job.id).capsule.job.execution_profile, alternate);
    assert.equal(f.sharing.start(f.peer, f.session.id, body).replayed, true);
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...body, execution_profile: { ...alternate, reasoning_effort: "invented" },
      idempotency_key: "borrow-invalid-effort" }), code("agent_share_profile_changed"));
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...body, execution_profile: { ...alternate, model: "not-advertised" },
      idempotency_key: "borrow-invalid-model" }), code("agent_share_profile_changed"));
    assert.throws(() => f.sharing.start(f.peer, f.session.id, { ...body, execution_profile: profile }), code("idempotency_conflict"));
    const stopped = f.sharing.save(f.owner, f.session.project_id, { ...input, share_id: saved.share.id, enabled: false, allowed_user_ids: [],
      expected_revision: saved.share.revision, idempotency_key: "empty-autosave" }).share;
    assert.equal(stopped.enabled, false); assert.deepEqual(stopped.allowed_user_ids, []);
    assert.equal(f.sharing.store.job(started.job.id).status, "cancelled");
    assert.throws(() => f.enable(stopped.id), code("conflict"));
  } finally { f.close(); }
});
test("late autosaves and accepted start retries cannot reopen an explicitly stopped share", () => {
  const f = fixture(); try {
    const input = { source_runtime_id: f.runtime.id, allowed_user_ids: [f.peer.user_id], enabled: true,
      limits: AgentShareLimitsSchema.parse({}), expected_revision: null, idempotency_key: "autosave-start-before-stop" };
    const share = f.sharing.save(f.owner, f.session.project_id, input).share;
    f.sharing.control(f.owner, f.session.project_id, share.id, { action: "disable", idempotency_key: "stop-before-stale-save" });
    assert.throws(() => f.sharing.save(f.owner, f.session.project_id, { ...input, share_id: share.id,
      expected_revision: share.revision, idempotency_key: "late-enabled-autosave" }), code("conflict"));
    const replay = f.sharing.save(f.owner, f.session.project_id, input);
    assert.equal(replay.replayed, true); assert.equal(replay.share.enabled, false);
  } finally { f.close(); }
});
test("borrower model discovery never publishes credential-shaped native catalog labels", () => {
  const f = fixture(); try {
    const share = f.enable(f.save().id), sensitive = { provider: "fixture", model: "password=fictional-test-only" };
    f.db.sqlite.prepare("UPDATE runtimes SET execution_profiles_json=? WHERE id=?").run(JSON.stringify([
      { provider: profile.provider, model: profile.model, reasoning_efforts: ["high"] }, sensitive]), f.runtime.id);
    const listed = f.sharing.list(f.peer, f.session.project_id).shares[0]!;
    assert.equal(listed.execution_profiles!.length, 1); assert.equal(JSON.stringify(listed).includes(sensitive.model), false);
    f.db.sqlite.prepare("UPDATE runtimes SET execution_profiles_json=? WHERE id=?").run(JSON.stringify([sensitive]), f.runtime.id);
    assert.equal(f.sharing.list(f.peer, f.session.project_id).shares[0]!.available, false);
    assert.throws(() => f.start(share.id), code("agent_share_profile_changed"));
  } finally { f.close(); }
});
