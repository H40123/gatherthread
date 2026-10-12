import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type JsonValue, type CodeFile } from "@gatherthread/protocol";
import type { LiveOutputUpdate } from "@gatherthread/adapters";
import { createHostedContainerOutputDecoder, createHostedLiveOutputConsumer, hostedContainerResult, type HostedContainerProgress, type HostedProgressCallback } from "../src/hosted-live-output.js";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { CodeRepository } from "../src/code-repository.js";
import { HostedAgent, type HostedAgentOptions } from "../src/hosted-agent.js";
import { HostedGithub } from "../src/hosted-github.js";

const unixTest = process.platform === "win32" ? test.skip : test;
const progress = (item_id = "item-1", content = "Visible output ", kind: HostedContainerProgress["kind"] = "answer"): HostedContainerProgress => ({ version: 1, item_id, kind, content, state: "running" });
const encoded = (value: unknown) => `GT_HOSTED_PROGRESS:${JSON.stringify(value)}\n`;
const endpoint = { id: "one", profileId: "coding", label: "Coding", provider: "openai-compatible" as const,
  model: "coding", baseUrl: "https://model.example/v1", apiToken: "synthetic-model-fixture", quotaGroup: "one", dailyRuns: 20, maxConcurrent: 2 };
const options: HostedAgentOptions = { endpoints: [endpoint], image: `sha256:${"a".repeat(64)}`, userDailyRuns: 20, globalDailyRuns: 20, maxConcurrent: 2 };
const { createOpencodeLiveOutput, createHostedProgressWriter } = await import(new URL("../../../../ops/hosted-agent/live-output.mjs", import.meta.url).href);

test("private progress lines decode incrementally before final legacy JSON, including split UTF-8/tags", () => {
  const records: HostedContainerProgress[] = [];
  const decoder = createHostedContainerOutputDecoder((entry) => records.push(entry));
  const first = Buffer.from(encoded(progress("item-1", "你好 answer ")));
  for (let offset = 0; offset < first.length; offset += 3) decoder.write(first.subarray(offset, offset + 3));
  assert.equal(records.length, 1, "progress is delivered while no final JSON is available");
  assert.equal(records[0]!.content, "你好 answer ");
  const final = JSON.stringify({ answer: "Final result", files: [], save_error: null });
  decoder.write(final.slice(0, 7)); decoder.write(final.slice(7));
  assert.equal(decoder.finish(), final);
  assert.equal(decoder.resultBytes(), Buffer.byteLength(final), "progress never consumes the legacy final JSON quota");
  assert.equal(hostedContainerResult(final), final, "legacy runner mocks remain valid");
});

test("private progress allowance is independent of final output bytes and stops extra telemetry", () => {
  const records: HostedContainerProgress[] = [];
  const line = encoded(progress());
  const decoder = createHostedContainerOutputDecoder((entry) => records.push(entry), Buffer.byteLength(line));
  decoder.write(line); decoder.write(line);
  assert.equal(records.length, 1);
  assert.equal(decoder.resultBytes(), 0);
  const final = '{"answer":"Legacy quota remains available","files":[]}';
  decoder.write(final);
  assert.equal(decoder.finish(), final);
  assert.equal(decoder.resultBytes(), Buffer.byteLength(final));
});

test("unrecognized/oversized private frames cannot inject fields or poison the final result", () => {
  const records: HostedContainerProgress[] = [];
  const decoder = createHostedContainerOutputDecoder((entry) => records.push(entry));
  for (const invalid of [ { ...progress(), version: 2 }, { ...progress(), session_id: "private-native" },
    { ...progress(), item_id: "msg_native" }, { ...progress(), kind: "system" }, { ...progress(), state: "finished" },
    { ...progress(), plan: [{ step: "Unexpected", status: "pending" }] },
    { ...progress(), kind: "plan", plan: [{ step: "Test", status: "completed", metadata: "private" }] } ]) decoder.write(encoded(invalid));
  decoder.write("GT_HOSTED_PROGRESS:{invalid JSON}\n");
  decoder.write("GT_HOSTED_PROGRESS:" + "x".repeat(64_001));
  decoder.write("discarded until newline\n");
  decoder.write(encoded(progress()));
  decoder.write('{"answer":"Done","files":[]}');
  assert.equal(decoder.finish(), '{"answer":"Done","files":[]}');
  assert.equal(records.length, 1);
});

test("cross-fragment credentials are redacted before canonical callbacks and refusal/failure cannot block finalization", async () => {
  const updates: LiveOutputUpdate[] = [];
  const secret = "sk-" + "syntheticcredential".repeat(3);
  const consumer = createHostedLiveOutputConsumer((update) => { updates.push(update); return true; });
  consumer.accept(progress("item-1", "Visible sk-")); await delay(0);
  consumer.accept(progress("item-1", `Visible ${secret} result `));
  consumer.accept({ ...progress("item-2", "Observed output", "tool"), state: "completed", title: "Run tests" });
  consumer.accept({ ...progress("item-3", "", "plan"), plan: [{ step: "Run tests", status: "completed" }] });
  await consumer.finish();
  assert.ok(updates.some((update) => update.streamKind === "answer"));
  assert.ok(updates.some((update) => update.streamKind === "tool"));
  assert.ok(updates.some((update) => update.streamKind === "plan"));
  assert.ok(!JSON.stringify(updates).includes(secret));
  assert.ok(!JSON.stringify(updates).includes("item-1"));
  assert.ok(updates.every((update) => update.streamRevision >= 1 && update.streamMode === "snapshot"));
  const attempts: LiveOutputUpdate[] = [];
  let accepted = false;
  const refusing = createHostedLiveOutputConsumer((update) => { attempts.push(update); return accepted; });
  refusing.accept(progress()); await delay(0);
  accepted = true; refusing.accept(progress("item-1", "Visible retry ")); await delay(0);
  assert.equal(attempts[0]!.streamRevision, 1); assert.equal(attempts[1]!.streamRevision, 1);
  await refusing.finish(false);
  const count = attempts.length;
  refusing.accept(progress("item-1", "Late content ")); await delay(0);
  assert.equal(attempts.length, count);
});

function trialFixture(runContainer: NonNullable<HostedAgentOptions["runContainer"]>) {
  const directory = mkdtempSync(join(tmpdir(), "gt-live-output-"));
  const db = new CollaborationDatabase(join(directory, "db"), { authTokenPepper: "hosted-live-output-fixture-pepper" });
  const service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Owner", device_name: "Fixture" }).actor;
  const session = service.createSession(actor, { title: "Live fixture", mode: "multi", idempotency_key: "live-session" }).session;
  const agent = new HostedAgent(service, new CodeRepository(db, join(directory, "code")), { ...options, runContainer });
  return { directory, db, service, actor, session, agent,
    events: () => service.replay(actor, session.id, 0, 100).events,
    close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function settled(db: CollaborationDatabase) {
  for (let count = 0; db.hostedActiveRuns() && count < 100; count++) await delay(5);
  assert.equal(db.hostedActiveRuns(), 0);
}
const payload = (value: JsonValue) => value as Record<string, JsonValue>;

unixTest("ordinary hosted requests publish owned live work while running, then retain one legacy final response", { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<HostedProgressCallback>(), release = Promise.withResolvers<string>();
  const secret = "sk-" + "syntheticcredential".repeat(3);
  const f = trialFixture(async (args, _timeout, signal, onProgress) => {
    assert.equal(args[args.indexOf("--log-driver") + 1], "none");
    assert.ok(signal); assert.ok(onProgress); onProgress(progress("item-1", "Visible output sk-")); entered.resolve(onProgress); return release.promise;
  });
  try {
    const receipt = await f.agent.start(f.actor, f.session.id, { profile_id: "coding", content: "Run the fixture", include_code: false, idempotency_key: "live-request" });
    await entered.promise; await delay(10);
    const live = f.events().filter((event) => event.type === "agent_progress" && payload(event.payload).phase === "stream");
    assert.ok(live.length > 0); assert.ok(live.every((event) => event.reply_to_event_id === receipt.request_event.id));
    assert.equal(f.db.hostedActiveRuns(), 1); assert.ok(!f.events().some((event) => event.type === "agent_response"));
    (await entered.promise)(progress("item-1", `Visible output ${secret} result `));
    release.resolve(JSON.stringify({ answer: "Final fixture result", files: [], save_error: null }));
    await settled(f.db);
    const final = f.events().filter((event) => event.type === "agent_response");
    assert.equal(final.length, 1); assert.equal(payload(final[0]!.payload).content, "Final fixture result");
    assert.ok(!JSON.stringify(f.events()).includes(secret), "private snapshots are redacted before append-only canonical storage");
    assert.ok(f.events().some((event) => event.type === "agent_progress" && payload(event.payload).stream_state === "completed"));
  } finally { release.resolve(JSON.stringify({ answer: "Final fixture result", files: [] })); await settled(f.db); f.close(); }
});

unixTest("bounded long native transport reaches canonical final answer/tools/plan and retains exact legacy JSON accounting", { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const sentence = "This is one ordinary streamed answer sentence. ", answer = sentence.repeat(200);
  const lines: string[] = [];
  const f = trialFixture(async (_args, _timeout, _signal, onProgress) => {
    assert.ok(onProgress);
    const decoder = createHostedContainerOutputDecoder(onProgress);
    let now = 0;
    const writer = createHostedProgressWriter({ now: () => now, write: (line: string) => {
      lines.push(line);
      const bytes = Buffer.from(line);
      for (let offset = 0; offset < bytes.length; offset += 127) decoder.write(bytes.subarray(offset, offset + 127));
    } });
    const mapper = createOpencodeLiveOutput("ses_fixture", writer, { now: () => now });
    const nativeInfo = { id: "msg_owned", sessionID: "ses_fixture", role: "assistant" };
    const nativePart = { id: "prt_answer", sessionID: "ses_fixture", messageID: "msg_owned", type: "text" };
    mapper.accept({ type: "message.updated", properties: { sessionID: "ses_fixture", info: nativeInfo } });
    mapper.accept({ type: "message.part.updated", properties: { sessionID: "ses_fixture", part: { ...nativePart, text: "" } } });
    for (let index = 0; index < 200; index++) {
      now += 200;
      mapper.accept({ type: "message.part.delta", properties: { sessionID: "ses_fixture", messageID: "msg_owned", partID: "prt_answer", field: "text", delta: sentence } });
    }
    assert.equal(decoder.resultBytes(), 0);
    entered.resolve(); await release.promise;
    mapper.accept({ type: "message.part.updated", properties: { sessionID: "ses_fixture", part: { id: "prt_tool", sessionID: "ses_fixture", messageID: "msg_owned", type: "tool",
      tool: "bash", state: { status: "completed", title: "Run tests", output: "最终测试通过" } } } });
    mapper.accept({ type: "todo.updated", properties: { sessionID: "ses_fixture", todos: [{ content: "Verify final output", status: "completed" }] } });
    mapper.reconcile({ info: nativeInfo, parts: [{ ...nativePart, text: answer, time: { end: 1 } }] }); mapper.close();
    const final = JSON.stringify({ answer, files: [], save_error: null });
    decoder.write(final.slice(0, 17)); decoder.write(final.slice(17));
    assert.equal(decoder.resultBytes(), Buffer.byteLength(final));
    assert.ok(lines.reduce((total, line) => total + Buffer.byteLength(line), 0) <= 256_000);
    assert.equal(decoder.finish(), final);
    return final;
  });
  try {
    await f.agent.start(f.actor, f.session.id, { profile_id: "coding", content: "Long native fixture", include_code: false, idempotency_key: "long-live-request" });
    await entered.promise; await delay(10);
    assert.ok(f.events().some((event) => payload(event.payload).stream_kind === "answer"));
    assert.ok(!f.events().some((event) => event.type === "agent_response"));
    release.resolve(); await settled(f.db);
    const streamed = f.events().filter((event) => event.type === "agent_progress" && payload(event.payload).phase === "stream");
    const latest = streamed.findLast((event) => payload(event.payload).stream_kind === "answer")!;
    assert.equal(payload(latest.payload).content, answer); assert.equal(payload(latest.payload).stream_state, "completed");
    assert.ok(streamed.some((event) => payload(event.payload).stream_kind === "tool" && payload(event.payload).content === "最终测试通过"));
    assert.ok(streamed.some((event) => payload(event.payload).stream_kind === "plan" && JSON.stringify(payload(event.payload).plan).includes("completed")));
    assert.deepEqual(f.events().filter((event) => event.type === "agent_response").map((event) => payload(event.payload).content), [answer.trim()]);
    assert.ok(!/ses_fixture|msg_owned|prt_/u.test(JSON.stringify(f.events())));
  } finally { release.resolve(); await settled(f.db); f.close(); }
});

unixTest("pause fences late hosted progress and late answers while retaining executor capacity until settlement", { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<HostedProgressCallback>(), release = Promise.withResolvers<string>();
  const f = trialFixture(async (_args, _timeout, _signal, onProgress) => { assert.ok(onProgress); entered.resolve(onProgress); return release.promise; });
  try {
    const receipt = await f.agent.start(f.actor, f.session.id, { profile_id: "coding", content: "Hold fixture", include_code: false, idempotency_key: "live-pause" });
    const callback = await entered.promise;
    f.agent.pause(f.actor, f.session.id, receipt.request_event.id);
    callback(progress("item-1", "Late private content ")); await delay(10);
    assert.equal(f.db.hostedActiveRuns(), 1);
    assert.ok(!f.events().some((event) => payload(event.payload).phase === "stream"));
    release.resolve(JSON.stringify({ answer: "Late answer", files: [] })); await settled(f.db);
    assert.ok(!f.events().some((event) => event.type === "agent_response"));
  } finally { release.resolve(JSON.stringify({ answer: "Late answer", files: [] })); await settled(f.db); f.close(); }
});

unixTest("selected hosted history summaries use the same live path and settle a linked summary", { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const f = trialFixture(async (_args, _timeout, _signal, onProgress) => { assert.ok(onProgress); onProgress(progress("item-1", "Summarizing selected source ")); entered.resolve(); return release.promise; });
  try {
    const source = f.service.appendEvent(f.actor, f.session.id, { type: "human_chat", visibility: "session", idempotency_key: "source", payload: { content: "Selected fixture source" } });
    const receipt = await f.agent.startSummary(f.actor, f.session.id, { profile_id: "coding", source_event_ids: [source.id], idempotency_key: "live-summary" });
    await entered.promise; await delay(10);
    assert.ok(f.events().some((event) => event.type === "agent_progress" && event.reply_to_event_id === receipt.request_event.id && payload(event.payload).phase === "stream"));
    release.resolve(JSON.stringify({ answer: "A completed shared summary", files: [] })); await settled(f.db);
    assert.ok(f.events().some((event) => event.type === "agent_response" && event.reply_to_event_id === receipt.request_event.id));
  } finally { release.resolve(JSON.stringify({ answer: "A completed shared summary", files: [] })); await settled(f.db); f.close(); }
});

const file = (path: string, content: string): CodeFile => ({ path, content_base64: Buffer.from(content).toString("base64"), executable: false });
const files = [file("package.json", '{"name":"fixture","version":"1.0.0"}'), file("package-lock.json", '{"name":"fixture","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}'), file("index.ts", "export const fixture = 1;\n")];
function githubFixture(runContainer: NonNullable<HostedAgentOptions["runContainer"]>) {
  const f = trialFixture(runContainer);
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/login/oauth/access_token") return Response.json({ access_token: "ghu_fixture", refresh_token: "ghr_fixture", expires_in: 28800, refresh_token_expires_in: 15897600, scope: "" });
    if (path === "/user") return Response.json({ login: "fixture-owner" });
    if (path === "/repos/owner/project") return Response.json({ id: 123, full_name: "owner/project", permissions: { push: true } });
    if (path.endsWith("/branches/main")) return Response.json({ commit: { sha: "b".repeat(40) } });
    if (path.includes("/git/commits/")) return Response.json({ tree: { sha: "c".repeat(40) } });
    if (path.includes("/git/trees/")) return Response.json({ truncated: false, tree: files.map((entry, i) => ({ path: entry.path, type: "blob", mode: "100644", sha: `blob${i}`, size: Buffer.byteLength(entry.content_base64, "base64") })) });
    if (path.includes("/git/blobs/blob")) return Response.json({ encoding: "base64", content: files[Number(path.slice(-1))]!.content_base64 });
    throw new Error("Unexpected synthetic GitHub route");
  };
  const github = new HostedGithub(f.service, f.agent, { ...options, runContainer }, { clientId: "fixture-app", clientSecret: "synthetic-" + "app-fixture",
    encryptionKey: Buffer.alloc(32, 3).toString("base64"), callbackUrl: "https://gt.example/v1/hosted-github/callback", appSlug: "fixture-app", fetch: fetcher });
  return { ...f, github, async connect() {
    const authorization = new URL(github.authorize(f.actor).authorization_url);
    await github.complete(f.actor, { state: authorization.searchParams.get("state")!, code: "synthetic-code" });
    await github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
  }, async closeGithub() { await github.close(); f.close(); } };
}

unixTest("hosted GitHub repository tasks publish tools/plans live before private snapshot and final response settle", { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const f = githubFixture(async (args, _timeout, signal, onProgress) => {
    assert.ok(args.includes("GT_HOSTED_REPOSITORY=1")); assert.ok(signal); assert.ok(onProgress);
    assert.equal(args[args.indexOf("--log-driver") + 1], "none");
    onProgress({ ...progress("item-1", "Observed test output ", "tool"), title: "Run tests" });
    onProgress({ ...progress("item-2", "", "plan"), plan: [{ step: "Run tests", status: "in_progress" }] });
    entered.resolve(); return release.promise;
  });
  try {
    await f.connect();
    const task = f.github.start(f.actor, f.session.id, { profile_id: "coding", content: "Run tests", idempotency_key: "live-github" });
    await entered.promise; await delay(10);
    assert.equal(f.github.view(f.actor, task.id).state, "running");
    const live = f.events().filter((event) => event.type === "agent_progress" && payload(event.payload).phase === "stream");
    assert.ok(live.length > 0); assert.ok(live.some((event) => payload(event.payload).stream_kind === "tool"));
    assert.ok(!f.events().some((event) => event.type === "agent_response"));
    release.resolve(JSON.stringify({ answer: "Observed fixture tests passed", files, save_error: null }));
    await settled(f.db);
    assert.equal(f.github.view(f.actor, task.id).state, "completed");
    assert.ok(f.events().some((event) => event.type === "agent_progress" && payload(event.payload).stream_kind === "plan"));
    assert.equal(f.events().filter((event) => event.type === "agent_response").length, 1);
  } finally { release.resolve(JSON.stringify({ answer: "Observed fixture tests passed", files, save_error: null })); await settled(f.db); await f.closeGithub(); }
});

unixTest("disconnecting repository consent fences delayed hosted GitHub progress and completion", { timeout: 10_000 }, async () => {
  const entered = Promise.withResolvers<HostedProgressCallback>(), release = Promise.withResolvers<string>();
  const f = githubFixture(async (_args, _timeout, _signal, onProgress) => { assert.ok(onProgress); entered.resolve(onProgress); return release.promise; });
  try {
    await f.connect();
    const task = f.github.start(f.actor, f.session.id, { profile_id: "coding", content: "Hold task", idempotency_key: "live-github-disconnect" });
    const callback = await entered.promise;
    f.github.disconnect(f.actor); callback(progress("item-1", "Late repository result ")); await delay(10);
    assert.ok(!f.events().some((event) => payload(event.payload).phase === "stream"));
    release.resolve(JSON.stringify({ answer: "Late result", files, save_error: null })); await settled(f.db);
    assert.equal(f.github.view(f.actor, task.id).state, "interrupted");
    assert.ok(!f.events().some((event) => event.type === "agent_response" && String(payload(event.payload).content).includes("Late result")));
  } finally { release.resolve(JSON.stringify({ answer: "Late result", files, save_error: null })); await settled(f.db); await f.closeGithub(); }
});

for (const fence of ["rebind", "different-device", "revocation"] as const) {
  unixTest(`hosted repository live progress rechecks ${fence} against the active accepted job`, { timeout: 10_000 }, async () => {
    const entered = Promise.withResolvers<HostedProgressCallback>(), release = Promise.withResolvers<string>();
    const f = githubFixture(async (_args, _timeout, _signal, onProgress) => { assert.ok(onProgress); entered.resolve(onProgress); return release.promise; });
    try {
      await f.connect();
      const task = f.github.start(f.actor, f.session.id, { profile_id: "coding", content: "Hold task", idempotency_key: `live-fence-${fence}` });
      const callback = await entered.promise;
      if (fence === "rebind") await f.github.bind(f.actor, f.session.project_id, { repository: "owner/project", base_branch: "main" });
      if (fence === "different-device") {
        // Corrupt only the test record to prove an active same-user browser is
        // insufficient when the repository task and accepted job devices differ.
        const device = f.db.createDevice(f.actor.user_id, "Second browser");
        f.db.sqlite.prepare("UPDATE hosted_github_tasks SET device_id=? WHERE id=?").run(device.device_id, task.id);
      }
      if (fence === "revocation") f.db.revokeDevice(f.actor, f.actor.device_id);
      callback(progress("item-1", "Unaccepted late output ")); await delay(10);
      const count = f.db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type='agent_progress' AND json_extract(payload_json,'$.phase')='stream'").get();
      assert.equal(count?.n, 0);
      if (fence === "different-device") f.github.disconnect(f.actor);
      release.resolve(JSON.stringify({ answer: "Unaccepted late answer", files, save_error: null })); await settled(f.db);
      const saved = f.db.sqlite.prepare("SELECT state,result_files FROM hosted_github_tasks WHERE id=?").get(task.id);
      assert.ok(saved?.state !== "running"); assert.equal(saved?.result_files, null);
      assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type='agent_response' AND payload_json LIKE '%Unaccepted late answer%'").get()?.n, 0);
    } finally { release.resolve(JSON.stringify({ answer: "Unaccepted late answer", files, save_error: null })); await settled(f.db); await f.closeGithub(); }
  });
}
