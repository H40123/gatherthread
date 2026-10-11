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
  await app.stream.onDelta("c", "-----BEGIN PRIVATE KEY-----\n" + "dummy");
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
