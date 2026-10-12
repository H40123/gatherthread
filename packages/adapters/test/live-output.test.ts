import assert from "node:assert/strict";
import test from "node:test";
import { createLiveOutputPublisher, type LiveOutputUpdate } from "../src/live-output.js";

function fixture(publish?: (update: LiveOutputUpdate) => Promise<boolean | void> | boolean | void) {
  let now = 0;
  const output: LiveOutputUpdate[] = [];
  const stream = createLiveOutputPublisher({ now: () => now, intervalMs: 1000, schedule: false,
    publish: publish ?? ((update) => { output.push(update); }) });
  return { stream, output, advance: () => { now += 1000; } };
}

test("snapshots grow, preserve whitespace and replace interleaved items without native IDs", async () => {
  const app = fixture();
  await app.stream.onDelta("native-1", "Hello ");
  await app.stream.onDelta("native-2", "Testing ", "reasoning");
  await app.stream.onDelta("native-1", "world\n");
  app.advance(); await app.stream.flush(); await app.stream.finish();
  assert.equal(app.output.findLast((x) => x.streamKind === "answer")?.content, "Hello world\n");
  assert.equal(app.output.findLast((x) => x.streamKind === "reasoning")?.content, "Testing ");
  assert.ok(app.output.every((x) => x.streamMode === "snapshot" && !x.streamId.includes("native")));
});

test("split credentials, assignments and unfinished private keys never reach a publication", async () => {
  const app = fixture();
  const fake = "sk-" + "a".repeat(24);
  await app.stream.onDelta("a", "Result " + fake.slice(0, 11));
  app.advance(); await app.stream.onDelta("a", fake.slice(11) + " done ");
  await app.stream.onDelta("b", "password=" + "xyz");
  await app.stream.onDelta("c", ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\n" + "dummy");
  await app.stream.finish();
  const all = JSON.stringify(app.output);
  assert.ok(!all.includes(fake) && !all.includes(fake.slice(0, 11)) && !all.includes("xyz") && !all.includes("dummy"));
  assert.match(all, /REDACTED/);
});

test("failed uploads are not acknowledged and the same revision is retried", async () => {
  const attempts: LiveOutputUpdate[] = [];
  let accept = false;
  const app = fixture((update) => { attempts.push(update); return accept; });
  await app.stream.onDelta("a", "Testing ");
  assert.equal(app.stream.lastPublishedAt(), undefined);
  accept = true; app.advance(); await app.stream.flush();
  assert.equal(attempts[0]?.id, attempts[1]?.id);
  assert.equal(app.stream.lastPublishedAt(), 1000);
  await app.stream.finish();
});

test("an uncertain acknowledgment retries the identical payload before the newer snapshot", async () => {
  const attempts: LiveOutputUpdate[] = [];
  let accept = false;
  const app = fixture((update) => { attempts.push(update); return accept; });
  await app.stream.onDelta("a", "First ");
  await app.stream.onDelta("a", "second ");
  assert.deepEqual(attempts[0], attempts[1]);
  accept = true; app.advance(); await app.stream.flush();
  app.advance(); await app.stream.flush(); await app.stream.finish();
  assert.equal(attempts.findLast((x) => x.streamState === "completed")?.content, "First second ");
});

test("updates received while publication is awaiting ACK are not lost", async () => {
  const output: LiveOutputUpdate[] = [];
  let acknowledge!: () => void;
  let started!: () => void;
  const publishing = new Promise<void>((resolve) => { started = resolve; });
  const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
  const app = fixture(async (update) => { output.push(update); if (output.length === 1) { started(); await ack; } });
  const first = app.stream.onDelta("a", "First ");
  await publishing;
  const second = app.stream.onDelta("a", "second ");
  acknowledge(); await Promise.all([first, second]);
  app.advance(); await app.stream.flush();
  assert.equal(output.at(-1)?.content, "First second ");
  await app.stream.finish();
});

test("quoted credential fields and Unicode truncation are safe", async () => {
  const app = fixture();
  await app.stream.onSnapshot("a", '{"access_token":"private-test-value","result":"ok"}', "tool", undefined, "completed");
  await app.stream.onSnapshot("b", "文本🙂 ".repeat(30_000), "answer");
  await app.stream.finish();
  assert.ok(!JSON.stringify(app.output).includes("private-test-value"));
  assert.ok(app.output.every((x) => !x.content.includes("\ufffd") && Buffer.byteLength(x.content) <= 24 * 1024));
});

test("one global throttle bounds many items, payload size and terminal drain", async () => {
  const app = fixture();
  for (let n = 0; n < 200; n++) await app.stream.onSnapshot(String(n), "item ".repeat(20_000), "tool");
  assert.equal(app.output.length, 1);
  await app.stream.finish();
  assert.ok(app.output.length <= 65);
  assert.ok(app.output.every((x) => Buffer.byteLength(x.content) <= 24 * 1024));
});

test("plans replace previous state and completed publishers never accept late deltas", async () => {
  const app = fixture();
  await app.stream.onPlan("plan", [{ step: "Fix parser", status: "in_progress" }]);
  app.advance(); await app.stream.onPlan("plan", [{ step: "Fix parser", status: "completed" }]);
  await app.stream.finish();
  assert.equal(app.output.at(-1)?.plan?.[0]?.status, "completed");
  const count = app.output.length;
  await app.stream.onDelta("late", "late output ");
  assert.equal(app.output.length, count);
});

test("Chinese output streams before completion without exposing a split ASCII credential", async () => {
  const app = fixture();
  await app.stream.onDelta("a", "正在检查项目，先查看配置。");
  assert.equal(app.output.at(-1)?.content, "正在检查项目，先查看配置。");
  const fake = "sk-" + "b".repeat(24);
  app.advance(); await app.stream.onDelta("a", "接下来检查：" + fake.slice(0, 12));
  assert.ok(!JSON.stringify(app.output).includes(fake.slice(0, 12)));
  app.advance(); await app.stream.onDelta("a", fake.slice(12) + "，已经完成。");
  assert.match(app.output.at(-1)?.content ?? "", /已经完成/);
  assert.ok(!JSON.stringify(app.output).includes(fake));
  await app.stream.finish();
});

test("empty plans clear previous steps and interrupted work is not marked completed", async () => {
  const app = fixture();
  await app.stream.onPlan("plan", [{ step: "Review files", status: "in_progress" }]);
  app.advance(); await app.stream.onPlan("plan", []);
  assert.deepEqual(app.output.at(-1)?.plan, []);
  app.advance(); await app.stream.onDelta("a", "Reviewing ");
  await app.stream.finish(false);
  assert.ok(app.output.filter(x => x.streamState !== "running").every(x => x.streamState === "failed"));
});

test("credential and private keys use structural sensitivity even in split serialized text", async () => {
  for (const key of ["refresh_token", "private_key", "authorization", "Cookie", "Set-Cookie", "developer_prompt", "provider_api_key", "refresh\\u005ftoken"]) {
    const app = fixture();
    const secret = ["fixtureOpaque", "PrivateValue"].join("");
    const body = `{"${key}":"${secret}","public":"kept"}\n`;
    await app.stream.onDelta("a", body.slice(0, body.indexOf(secret) + 8));
    app.advance(); await app.stream.onDelta("a", body.slice(body.indexOf(secret) + 8));
    await app.stream.finish();
    assert.ok(!JSON.stringify(app.output).includes(secret), key);
    assert.match(app.output.at(-1)?.content ?? "", /kept/);
  }
});

test("continuous first-stream updates cannot starve live plans or tools", async () => {
  const app = fixture();
  await app.stream.onDelta("a", "Growing ");
  await app.stream.onPlan("plan", [{ step: "Check tests", status: "in_progress" }]);
  await app.stream.onSnapshot("tool", "Checking ", "tool");
  for (let n = 0; n < 6; n++) { app.advance(); await app.stream.onDelta("a", "answer "); }
  assert.ok(app.output.some(x => x.streamKind === "plan"), "plan must be live, not only terminal");
  assert.ok(app.output.some(x => x.streamKind === "tool"), "tool must be live, not only terminal");
  assert.ok(app.output.length <= 7, "fairness must preserve the shared cadence");
  await app.stream.finish();
});
