import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedAgentAcceptedSchema, HostedAgentFailurePayloadSchema, type HostedAgentRequestInput } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent, HostedModelProxy, HOSTED_AGENT_TIMEOUT_MS, type HostedAgentOptions } from "../src/hosted-agent.js";
import { HostedRepositoryRunner } from "../src/hosted-repository-runner.js";
import { startCollaborationServer } from "../src/server.js";
import { request as httpRequest } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { CloudApiStore } from "../src/cloud-api.js";

const socketTest = process.platform === "win32" ? test.skip : test;
const endpoint = { id: "fixture", profileId: "fixture", label: "Fixture", provider: "openai-compatible" as const,
  model: "fixture", baseUrl: "https://fixture.invalid/v1", apiToken: "fixture-only", quotaGroup: "fixture", dailyRuns: 20, maxConcurrent: 1 };
const limits = { userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 1 };
const input: HostedAgentRequestInput = { profile_id: "fixture", content: "Inspect the task and finish it", include_code: false, idempotency_key: "timeout-fixture-original" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gt-timeout-")), path = join(directory, "db");
  let now = Date.parse("2026-10-12T00:00:00Z");
  const options = { authTokenPepper: "synthetic-timeout-fixture-pepper", clock: () => new Date(now) };
  const db = new CollaborationDatabase(path, options), service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Fixture" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Fixture", idempotency_key: "timeout-fixture-session" }).session;
  return { directory, path, options, db, service, actor, session, advance: () => { now += 30_000; },
    close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("timeout continuation retains the original personal API revision even when model metadata stays the same", () => {
  const f = fixture();
  try {
    const store = new CloudApiStore(f.db, randomBytes(32).toString("base64"));
    const metadata = { expected_revision: null, provider_id: "deepseek" as const, label: "Synthetic fixture", model: "deepseek-chat",
      enabled: true, api_key: ["synthetic", "timeout", "fixture", "value"].join("-") };
    const config = store.put(f.actor, randomUUID(), metadata);
    const original = { ...input, profile_id: config.profile_id, api_config_revision: config.revision };
    const route = store.resolve(f.actor, config.profile_id, config.revision);
    const request = f.db.reserveHostedAgentRequest(f.actor, f.session.id, original, [route], limits).event;
    f.db.finishHostedAgentRequest(request.id, { errorCode: "container_timeout" }); f.advance();
    const child = { ...original, continue_from_event_id: request.id, idempotency_key: "personal-timeout-child" };
    const updated = store.put(f.actor, config.id, { ...metadata, label: "Updated synthetic fixture", expected_revision: config.revision });
    assert.notEqual(updated.revision, config.revision);
    const updatedRoute = store.resolve(f.actor, updated.profile_id, updated.revision);
    assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, f.session.id,
      { ...child, api_config_revision: updated.revision }, [updatedRoute], limits), /original API configuration revision/);
    assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 1);
    assert.equal(f.db.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

for (const erased of ["request", "earlier source"]) {
  test(`timeout continuation refuses an erased ${erased} even with the current client history revision`, () => {
    const f = fixture();
    try {
      const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
        idempotency_key: "timeout-deletion-source", payload: { content: "A source that must not return." } });
      const request = f.db.reserveHostedAgentRequest(f.actor, f.session.id, input, [endpoint], limits).event;
      f.db.finishHostedAgentRequest(request.id, { errorCode: "container_timeout" }); f.advance();
      f.db.deleteMessage(f.actor, f.session.id, erased === "request" ? request.id : source.id, "timeout-delete");
      assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, f.session.id, { ...input,
        content_revision: f.db.requireSession(f.session.id).content_revision,
        continue_from_event_id: request.id, idempotency_key: "deleted-timeout-child" }, [endpoint], limits));
      assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 1);
      assert.equal(f.db.hostedActiveRuns(), 0);
    } finally { f.close(); }
  });
}

for (const code of ["container_timeout", "provider_timeout", "provider_unavailable", "agent_answer_failed", "arbitrary private error"]) {
  test(`durable cloud outcome classifies ${code === "arbitrary private error" ? "unknown safe error" : code} without changing legacy status`, () => {
    const f = fixture();
    try {
      const request = f.db.reserveHostedAgentRequest(f.actor, f.session.id, input, [endpoint], limits).event;
      const response = f.db.finishHostedAgentRequest(request.id, { errorCode: code, providerAttempts: 1 })!;
      const payload = HostedAgentFailurePayloadSchema.parse(response.payload);
      assert.equal(payload.status, "failed");
      assert.equal(payload.outcome, code.endsWith("timeout") ? "timed_out" : "failed");
      assert.equal(payload.error.code, code === "arbitrary private error" ? "model_unavailable" : code);
      assert.equal(payload.error.provider_attempts, 1);
      assert.deepEqual(f.db.sqlite.prepare("SELECT outcome,error_code FROM hosted_agent_outcomes WHERE request_event_id=?").get(request.id),
        Object.assign(Object.create(null), { outcome: payload.outcome, error_code: payload.error.code }));
      assert.equal(f.db.finishHostedAgentRequest(request.id, { errorCode: "provider_timeout" }), undefined);
      assert.equal(f.db.hostedActiveRuns(), 0);
      assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 1);
    } finally { f.close(); }
  });
}

socketTest("timeout Continue uses a new 12-minute round, exact original task, latest public history and one durable child", async () => {
  const f = fixture(); let calls = 0;
  const quote = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
    idempotency_key: "timeout-original-quote", payload: { content: "An existing task note." } });
  const original = { ...input, reply_to_event_id: quote.id };
  const agent = new HostedAgent(f.service, new CodeRepository(f.db, join(f.directory, "code")), {
    ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`,
    runContainer: async (args, timeout, signal) => {
      assert.equal(timeout, 720_000); assert.equal(HOSTED_AGENT_TIMEOUT_MS, timeout); assert.equal(signal?.aborted, false);
      if (++calls === 1) throw new Error("container_timeout");
      const control = args.find(value => value.endsWith("dst=/run/gatherthread,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
      const prompt = readFileSync(join(control, "prompt.txt"), "utf8");
      assert.ok(prompt.includes(input.content)); assert.ok(prompt.includes("The human added useful instructions after timeout."));
      assert.ok(prompt.includes("This is a fresh execution round, with at most 12 minutes."));
      assert.ok(prompt.includes("hidden thinking, unsaved files and internal tool state are unavailable"));
      return JSON.stringify({ answer: "Finished with the new note.", files: [] });
    },
  });
  try {
    const first = await agent.request(f.actor, f.session.id, original);
    assert.equal((first.response_event?.payload as { outcome: string }).outcome, "timed_out");
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "timeout-new-note", payload: { content: "The human added useful instructions after timeout." } });
    f.advance();
    const continuing = { ...original, continue_from_event_id: first.request_event.id, idempotency_key: "timeout-new-round" };
    const second = await agent.request(f.actor, f.session.id, continuing);
    assert.notEqual(first.request_event.id, second.request_event.id);
    assert.equal(second.request_event.reply_to_event_id, quote.id);
    assert.equal((second.request_event.payload as { continue_from_event_id: string }).continue_from_event_id, first.request_event.id);
    assert.equal((second.response_event?.payload as { status: string }).status, "completed");
    assert.equal((await agent.request(f.actor, f.session.id, continuing)).replayed, true);
    f.advance();
    await assert.rejects(agent.request(f.actor, f.session.id, { ...continuing, idempotency_key: "timeout-duplicate-child" }), /already has a continuation/);
    assert.equal(calls, 2); assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 2);
  } finally { f.close(); }
});

test("continuation rejects wrong author, writer role, target, content, code and poisoned generic metadata", () => {
  const f = fixture();
  try {
    const first = f.db.reserveHostedAgentRequest(f.actor, f.session.id, input, [endpoint], limits).event;
    f.db.finishHostedAgentRequest(first.id, { errorCode: "container_timeout" }); f.advance();
    const peer = f.db.createIdentity({ display_name: "Peer", device_name: "Fixture" }).actor;
    f.service.setMembership(f.actor, f.session.id, peer.user_id, "participant", "timeout-add-peer");
    const continuing = { ...input, continue_from_event_id: first.id, idempotency_key: "timeout-author-continuation" };
    assert.throws(() => f.db.reserveHostedAgentRequest(peer, f.session.id, continuing, [endpoint], limits), /Only the author/);
    for (const changed of [{ content: "A different task" }, { include_code: true }, { reply_to_event_id: first.id }, { profile_id: "different" }]) {
      const profile = { ...endpoint, ...(changed.profile_id ? { profileId: changed.profile_id } : {}) };
      assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, f.session.id, { ...continuing, ...changed }, [profile], limits), /must keep the original/);
    }
    assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, f.session.id, continuing, [{ ...endpoint, model: "other" }], limits), /must keep the original/);
    assert.throws(() => f.service.appendEvent(peer, f.session.id, { type: "agent_request", visibility: "session",
      idempotency_key: "timeout-poison-generic", payload: { content: "Poison", continue_from_event_id: first.id } }), /server-owned metadata/);
    f.db.sqlite.prepare("UPDATE devices SET revoked_at=? WHERE id=?").run("2026-10-12T00:00:30Z", f.actor.device_id);
    assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, f.session.id, continuing, [endpoint], limits));
  } finally { f.close(); }
});

test("normal failure and successful requests cannot be continued; old timeout markers migrate idempotently", () => {
  const f = fixture();
  try {
    const first = f.db.reserveHostedAgentRequest(f.actor, f.session.id, input, [endpoint], limits).event;
    f.db.finishHostedAgentRequest(first.id, { errorCode: "provider_auth_failed" }); f.advance();
    assert.throws(() => f.db.reserveHostedAgentRequest(f.actor, f.session.id, { ...input,
      continue_from_event_id: first.id, idempotency_key: "not-timeout-continue" }, [endpoint], limits), /timed-out/);
    const timeout = f.db.reserveHostedAgentRequest(f.actor, f.session.id, { ...input, idempotency_key: "legacy-timeout" }, [endpoint], limits).event;
    const marker = f.db.finishHostedAgentRequest(timeout.id, { errorCode: "provider_timeout" })!;
    const legacy = { ...(marker.payload as Record<string, unknown>) }; delete legacy.outcome;
    f.db.sqlite.prepare("UPDATE events SET payload_json=? WHERE id=?").run(JSON.stringify(legacy), marker.id);
    f.db.sqlite.exec("DROP TABLE hosted_agent_outcomes"); f.db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const migrated = new CollaborationDatabase(f.path, f.options);
      assert.equal(migrated.sqlite.prepare("SELECT outcome FROM hosted_agent_outcomes WHERE request_event_id=?").get(timeout.id)!.outcome, "timed_out");
      assert.equal(Object.hasOwn(migrated.getEvent(f.session.id, marker.id).payload as object, "outcome"), false);
      assert.equal(migrated.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 2);
      migrated.close();
    }
  } finally { if (f.db.sqlite.isOpen) f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

for (const content of ["x".repeat(6000), "测".repeat(6000)]) {
  socketTest(`long ${content.startsWith("x") ? "ASCII" : "Chinese"} task can continue twice without duplicating its text or dropping newer conversation`, async () => {
    const f = fixture(); let calls = 0;
    const agent = new HostedAgent(f.service, new CodeRepository(f.db, join(f.directory, "code")), {
      ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`,
      runContainer: async args => {
        calls++;
        const control = args.find(value => value.endsWith("dst=/run/gatherthread,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
        const prompt = readFileSync(join(control, "prompt.txt"), "utf8");
        assert.equal(prompt.split(content).length, 2, "the complete original task appears exactly once");
        if (calls > 1) {
          assert.ok(prompt.includes("Keep the observed file result and the new decision."));
          assert.ok(prompt.includes("continuation_task_reference"));
        }
        if (calls < 3) throw new Error("container_timeout");
        return JSON.stringify({ answer: "The long task completed.", files: [] });
      },
    });
    try {
      let previous = (await agent.request(f.actor, f.session.id, { ...input, content })).request_event;
      f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "long-task-note",
        payload: { content: "Keep the observed file result and the new decision." } });
      for (let round = 1; round <= 2; round++) {
        f.advance();
        previous = (await agent.request(f.actor, f.session.id, { ...input, content,
          continue_from_event_id: previous.id, idempotency_key: `long-task-round-${round}` })).request_event;
      }
      assert.equal(calls, 3); assert.equal(f.db.hostedAgentUsage(f.actor, 20, 20).user_used_runs, 3);
      const records = f.service.replay(f.actor, f.session.id, 0, 100).events.filter(event => event.type === "agent_request");
      assert.equal(records.length, 3); assert.ok(records.every(event => (event.payload as { content: string }).content === content));
    } finally { f.close(); }
  });
}

socketTest("timed-out summary Continue retains original instructions and selected sources without exposing other history or code", async () => {
  const f = fixture(); let calls = 0;
  const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
    idempotency_key: "timeout-summary-source", payload: { content: "The selected summary source." } });
  const agent = new HostedAgent(f.service, new CodeRepository(f.db, join(f.directory, "code")), {
    ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`,
    runContainer: async args => {
      if (++calls === 1) throw new Error("container_timeout");
      const control = args.find(value => value.endsWith("dst=/run/gatherthread,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
      const prompt = readFileSync(join(control, "prompt.txt"), "utf8");
      assert.ok(prompt.includes("Keep the test decision.")); assert.ok(prompt.includes("The selected summary source."));
      assert.ok(!prompt.includes("Do not transfer this unselected note."));
      const config = JSON.parse(readFileSync(join(control, "opencode.json"), "utf8"));
      assert.equal(config.permission.read, "deny"); assert.equal(config.permission.edit, "deny"); assert.equal(config.permission.bash, "deny");
      return JSON.stringify({ answer: "The resulting summary.", files: [] });
    },
  });
  try {
    const original = { profile_id: "fixture", source_event_ids: [source.id], instructions: "Keep the test decision.", idempotency_key: "timeout-summary-original" };
    const first = await agent.startSummary(f.actor, f.session.id, original);
    for (let tries = 0; f.db.hostedActiveRuns() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session",
      idempotency_key: "timeout-unselected-note", payload: { content: "Do not transfer this unselected note." } }); f.advance();
    const continuation = { profile_id: "fixture", source_event_ids: [source.id], continue_from_event_id: first.request_event.id,
      idempotency_key: "timeout-summary-continue" };
    await assert.rejects(agent.startSummary(f.actor, f.session.id, { ...continuation, instructions: "Changed instructions" }), /keeps the original instructions/);
    const next = await agent.startSummary(f.actor, f.session.id, continuation);
    for (let tries = 0; f.db.hostedActiveRuns() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((next.request_event.payload as { content: string }).content, (first.request_event.payload as { content: string }).content);
    assert.equal(f.service.replay(f.actor, f.session.id, 0, 100).events.filter(event => event.type === "agent_response").length, 2);
    assert.equal(calls, 2);
  } finally { f.close(); }
});

socketTest("repository runner shares the 12-minute cancellation signal and preserves timeout category", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-repository-deadline-")); let caught = false;
  const options: HostedAgentOptions = { ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`,
    runContainer: async (_args, timeout, signal) => { assert.equal(timeout, 720_000); assert.equal(signal?.aborted, false); throw new Error("container_timeout"); } };
  try {
    await assert.rejects(new HostedRepositoryRunner(options).run([
      { path: "package.json", content_base64: Buffer.from('{"name":"fixture","version":"1.0.0"}').toString("base64"), executable: false },
      { path: "package-lock.json", content_base64: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}').toString("base64"), executable: false },
    ], "Inspect", endpoint, () => {}), error => {
      caught = error instanceof Error && error.message === "container_timeout"; return caught;
    }); assert.equal(caught, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

socketTest("provider timeout retains a safe category and streaming cancellation cannot hang proxy cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-provider-deadline-"));
  const proxy = new HostedModelProxy({ endpoint, fetch: async () => { throw new DOMException("private provider detail", "TimeoutError"); } });
  try {
    const path = join(directory, "model.sock"); await proxy.listen(path);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ socketPath: path, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      }); request.on("error", reject); request.end(JSON.stringify({ model: "fixture", messages: [{ role: "user", content: "Fixture" }] }));
    });
    assert.equal(status, 502); assert.deepEqual(proxy.diagnostics(), { providerAttempts: 1, errorCode: "provider_timeout" });
  } finally { await proxy.close(); rmSync(directory, { recursive: true, force: true }); }
});


socketTest("HTTP continuation returns a durable 202 receipt, authorizes exact source and replays one quota-charged child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gt-timeout-http-"));
  let calls = 0;
  const server = await startCollaborationServer({ databasePath: join(directory, "db"), authTokenPepper: "synthetic-http-timeout-pepper",
    hostedAgent: { ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`,
      runContainer: async () => { if (++calls === 1) throw new Error("container_timeout"); return JSON.stringify({ answer: "Continued answer", files: [] }); } } });
  try {
    const owner = server.database.bootstrapIdentity({ display_name: "Owner", device_name: "Fixture" });
    const peer = server.database.createIdentity({ display_name: "Peer", device_name: "Fixture" });
    const session = server.service.createSession(owner.actor, { title: "Fixture", mode: "multi", idempotency_key: "http-timeout-session" }).session;
    server.service.setMembership(owner.actor, session.id, peer.actor.user_id, "participant", "http-timeout-peer");
    const post = async (body: unknown, token = owner.token) => {
      const response = await fetch(`${server.origin}/v1/sessions/${session.id}/hosted-agent-requests`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as { data: unknown } };
    };
    const first = await post(input); assert.equal(first.status, 202);
    const receipt = HostedAgentAcceptedSchema.parse(first.body.data);
    for (let attempts = 0; server.database.hostedActiveRuns() && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 5));
    const marker = server.service.replay(owner.actor, session.id, 0, 100).events.find(event => event.type === "agent_response")!;
    assert.equal(HostedAgentFailurePayloadSchema.parse(marker.payload).outcome, "timed_out");
    server.database.sqlite.prepare("UPDATE hosted_agent_user_activity SET last_started_at=? WHERE user_id=?")
      .run(new Date(Date.now() - 31_000).toISOString(), owner.actor.user_id);
    const continuing = { ...input, continue_from_event_id: receipt.request_event.id, idempotency_key: "http-timeout-child" };
    assert.equal((await post(continuing, peer.token)).status, 403);
    assert.equal((await post({ ...continuing, content: "Other task" })).status, 409);
    assert.equal((await post({ ...continuing, private_state: "not accepted" })).status, 400);
    const second = await post(continuing); assert.equal(second.status, 202);
    const child = HostedAgentAcceptedSchema.parse(second.body.data);
    const replay = HostedAgentAcceptedSchema.parse((await post(continuing)).body.data);
    assert.equal(replay.replayed, true); assert.equal(replay.request_event.id, child.request_event.id);
    for (let attempts = 0; server.database.hostedActiveRuns() && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 5));
    server.database.sqlite.prepare("UPDATE hosted_agent_user_activity SET last_started_at=? WHERE user_id=?")
      .run(new Date(Date.now() - 31_000).toISOString(), owner.actor.user_id);
    assert.equal((await post({ ...continuing, idempotency_key: "http-second-child" })).status, 409);
    assert.equal(calls, 2); assert.equal(server.database.hostedAgentUsage(owner.actor, 20, 20).user_used_runs, 2);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

socketTest("Continue loads only current saved requester cloud code, never claims to recover killed unsaved edits", async () => {
  const f = fixture(); const repository = new CodeRepository(f.db, join(f.directory, "code")); let calls = 0;
  const enabled = repository.enable(f.actor, f.session.project_id, { idempotency_key: "timeout-enable-code" });
  const saved = { path: "saved.txt", content_base64: Buffer.from("Observed saved work.\n").toString("base64"), executable: false };
  const agent = new HostedAgent(f.service, repository, { ...limits, endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`,
    runContainer: async args => {
      if (++calls === 1) throw new Error("container_timeout");
      const mount = args.find(value => value.endsWith("dst=/input,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
      assert.equal(readFileSync(join(mount, "saved.txt"), "utf8"), "Observed saved work.\n");
      return JSON.stringify({ answer: "Verified the saved work.", files: [saved], save_error: null });
    } });
  try {
    const original = { ...input, include_code: true };
    const first = await agent.request(f.actor, f.session.id, original);
    repository.checkpoint(f.actor, f.session.project_id, { base_commit: enabled.commit, files: [saved], message: "Observed saved checkpoint", idempotency_key: "timeout-saved-checkpoint" });
    f.advance(); await agent.request(f.actor, f.session.id, { ...original, continue_from_event_id: first.request_event.id, idempotency_key: "timeout-code-continue" });
    assert.equal(calls, 2); assert.deepEqual(repository.snapshot(f.actor, f.session.project_id, "main").snapshot.files, []);
  } finally { f.close(); }
});
