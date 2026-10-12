import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { CloudApiStore } from "../src/cloud-api.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";
import { ApiError } from "../src/errors.js";

const socketTest = process.platform === "win32" ? test.skip : test;
function fixture(runContainer: NonNullable<HostedAgentOptions["runContainer"]>) {
  const root = mkdtempSync(join(tmpdir(), "gt-personal-route-"));
  let time = Date.now();
  const database = new CollaborationDatabase(join(root, "identity.db"), { authTokenPepper: "personal-routing-fixture-pepper", clock: () => new Date(time) });
  const service = new CollaborationService(database);
  const actor = database.bootstrapIdentity({ display_name: "Owner", device_name: "Browser" }).actor;
  const session = service.createSession(actor, { mode: "multi", title: "Cloud", idempotency_key: "personal-route-session" }).session;
  const key = randomBytes(32).toString("base64"), store = new CloudApiStore(database, key);
  const saved = store.put(actor, randomUUID(), { expected_revision: null, provider_id: "anthropic", label: "My Claude",
    model: "claude-sonnet-fixture", enabled: true, api_key: ["synthetic", "personal", "provider", "secret"].join("-") });
  const agent = new HostedAgent(service, new CodeRepository(database, join(root, "code")), {
    personalApiEncryptionKey: key, image: `fixture/cloud@sha256:${"c".repeat(64)}`, endpoints: [{ id: "free", profileId: "free",
      provider: "deepseek", label: "Existing service model", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1",
      apiToken: "synthetic-operator-provider-secret", quotaGroup: "operator", dailyRuns: 4, maxConcurrent: 1 }],
    userDailyRuns: 1, globalDailyRuns: 4, maxConcurrent: 1, runContainer,
  });
  const input = { profile_id: saved.profile_id, api_config_revision: saved.revision, content: "Reply hello", include_code: false, idempotency_key: "personal-request" };
  return { root, database, service, actor, session, store, saved, agent, input, advance() { time += 31_000; },
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

socketTest("personal selection freezes private run credentials and leaves free allowance untouched", async () => {
  let executions = 0;
  const f = fixture(async args => {
    executions++;
    const control = args.find(value => value.endsWith("dst=/run/gatherthread,readonly"))!.split("src=")[1]!.split(",dst=")[0]!;
    const configText = readFileSync(join(control, "opencode.json"), "utf8"), config = JSON.parse(configText);
    assert.equal(config.provider.hosted.npm, "@ai-sdk/anthropic");
    assert.doesNotMatch(configText + args.join(" "), /synthetic-personal-provider|synthetic-operator-provider|api.anthropic.com/);
    return JSON.stringify({ answer: "Hello from the chosen model.", files: [] });
  });
  try {
    const status = f.agent.status(f.actor);
    assert.ok(status.profiles.some(p => p.id === f.saved.profile_id && p.source === "personal"));
    const result = await f.agent.request(f.actor, f.session.id, f.input);
    assert.equal(result.response_event?.runtime_provenance?.provider, "anthropic");
    assert.equal(executions, 1);
    assert.equal(f.database.hostedAgentUsage(f.actor, 1, 4).user_used_runs, 0);
    const binding = f.database.sqlite.prepare("SELECT * FROM cloud_api_run_bindings WHERE request_event_id=?").get(result.request_event.id)!;
    assert.equal(binding.config_id, f.saved.id); assert.equal(binding.config_revision, f.saved.revision);
    assert.equal((await f.agent.request(f.actor, f.session.id, f.input)).replayed, true);
    assert.equal(executions, 1);
    assert.doesNotMatch(JSON.stringify(f.service.replay(f.actor, f.session.id, 0, 100)), /synthetic-personal-provider|key_ciphertext/);
  } finally { f.close(); }
});

test("personal daily allowance spans configurations and never uses the unlimited free-model exception", () => {
  const f = fixture(async () => JSON.stringify({ answer: "Fixture", files: [] }));
  try {
    const second = f.store.put(f.actor, randomUUID(), { expected_revision: null, provider_id: "siliconflow-cn", label: "Free model with own key",
      model: "Qwen/Qwen3.5-4B", enabled: true, api_key: ["second", "personal", "fixture"].join("-") });
    const endpoints = [f.store.resolve(f.actor, f.saved.profile_id, f.saved.revision), f.store.resolve(f.actor, second.profile_id, second.revision)];
    assert.equal(endpoints[0]!.quotaGroup, endpoints[1]!.quotaGroup); assert.equal(endpoints[1]!.dailyRuns, 100);
    f.database.setHostedAgentUserLimit(f.actor.user_id, 0);
    const limits = { userDailyRuns: 100, globalDailyRuns: 1000, maxConcurrent: 1, billingSource: "personal" as const };
    for (let n = 0; n < 100; n++) {
      const endpoint = endpoints[n % 2]!;
      const row = f.database.reserveHostedAgentRequest(f.actor, f.session.id, { ...f.input, profile_id: endpoint.profileId,
        api_config_revision: endpoint.personal!.configRevision, idempotency_key: `personal-cap-${n}` }, [endpoint], limits);
      f.database.finishHostedAgentRequest(row.event.id, {}); f.advance();
    }
    assert.equal(f.database.hostedAgentUsage(f.actor, 1, 4).user_used_runs, 0);
    assert.equal(f.database.hostedAgentUsage(f.actor, 100, 1000, "personal").user_used_runs, 100);
    assert.throws(() => f.database.reserveHostedAgentRequest(f.actor, f.session.id, { ...f.input, idempotency_key: "personal-cap-over" },
      [endpoints[0]!], limits), e => e instanceof ApiError && e.code === "hosted_user_quota");
    assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

socketTest("personal requests and summaries keep exact pins; reused request keys cannot follow a rotated key", async () => {
  const f = fixture(async () => JSON.stringify({ answer: "Summary fixture", files: [] }));
  try {
    const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "own-api-summary-source",
      payload: { content: "Selected history fixture" } });
    const summarized = await f.agent.startSummary(f.actor, f.session.id, { profile_id: f.saved.profile_id, api_config_revision: f.saved.revision,
      source_event_ids: [source.id], idempotency_key: "own-api-summary" });
    for (let tries = 0; f.database.hostedActiveRuns() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(f.agent.selection(f.actor, f.session.id, summarized.request_event.id), { profile_id: f.saved.profile_id, api_config_revision: f.saved.revision });
    f.advance();
    const original = await f.agent.request(f.actor, f.session.id, f.input);
    const changed = f.agent.putPersonalApi(f.actor, f.saved.id, { expected_revision: f.saved.revision, provider_id: "anthropic",
      label: f.saved.label, model: f.saved.model, enabled: true, api_key: ["rotated", "fixture", "personal", "key"].join("-") });
    await assert.rejects(f.agent.request(f.actor, f.session.id, { ...f.input, api_config_revision: changed.revision }),
      e => e instanceof ApiError && e.code === "cloud_api_changed");
    assert.throws(() => f.agent.selection(f.actor, f.session.id, original.request_event.id), e => e instanceof ApiError && e.code === "cloud_api_changed");
  } finally { f.close(); }
});

socketTest("unknown, foreign, disabled or stale personal selection never falls back or reserves work", async () => {
  let executions = 0;
  const f = fixture(async () => { executions++; return JSON.stringify({ answer: "Should not execute", files: [] }); });
  try {
    const other = f.database.createIdentity({ display_name: "Other", device_name: "Browser" }).actor;
    f.service.setMembership(f.actor, f.session.id, other.user_id, "participant", "personal-other");
    for (const [actor, input] of [[f.actor, { ...f.input, api_config_revision: randomUUID() }], [other, f.input],
      [f.actor, { ...f.input, profile_id: `api-${randomUUID()}` }]] as const) {
      await assert.rejects(f.agent.request(actor, f.session.id, input));
    }
    assert.equal(executions, 0); assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { f.close(); }
});

socketTest("configuration replacement aborts active work, fences progress and suppresses late answer", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const f = fixture(async (_args, _timeout, cancellation) => { signal = cancellation; entered.resolve(); return release.promise; });
  try {
    const receipt = await f.agent.start(f.actor, f.session.id, f.input); await entered.promise;
    f.agent.putPersonalApi(f.actor, f.saved.id, { expected_revision: f.saved.revision, provider_id: "anthropic", label: "Changed",
      model: "claude-sonnet-fixture", enabled: true });
    assert.equal(signal?.aborted, true);
    assert.equal(f.service.appendHostedAgentProgress(receipt.request_event.id, { id: randomUUID(),
      content: "Late work", phase: "stream", streamId: randomUUID(), streamKind: "answer", streamRevision: 1,
      streamMode: "snapshot", streamState: "running" }), false);
    assert.equal(f.database.hostedActiveRuns(), 1, "capacity stays held until the executor exits");
    release.resolve(JSON.stringify({ answer: "Late answer must be refused", files: [] }));
    for (let tries = 0; f.database.hostedActiveRuns() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
    const result = f.service.replay(f.actor, f.session.id, 0, 100).events.find(event => event.type === "agent_response");
    assert.equal((result?.payload as { status: string }).status, "failed");
    assert.doesNotMatch(JSON.stringify(result), /Late answer/);
    assert.equal(f.database.hostedActiveRuns(), 0);
  } finally { release.resolve(JSON.stringify({ answer: "Late", files: [] })); f.close(); }
});
