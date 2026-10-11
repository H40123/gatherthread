import assert from "node:assert/strict";
import test from "node:test";
import { createAgentOutputStream, type AgentStreamChunk } from "../src/agent-output-stream.js";

/**
 * The stream owns two things the connector must be able to rely on: it never
 * loses public text, and it never publishes faster than the server write
 * budget allows. Both are asserted here without a running App Server.
 */
function harness(options: { intervalMs?: number; maxChunkBytes?: number; maxFlushChunks?: number } = {}) {
  let now = 0;
  let streamCounter = 0;
  const published: AgentStreamChunk[] = [];
  const stream = createAgentOutputStream({
    publish: (chunk) => { published.push(chunk); },
    now: () => now,
    intervalMs: options.intervalMs ?? 1_000,
    maxChunkBytes: options.maxChunkBytes ?? 4_096,
    ...(options.maxFlushChunks === undefined ? {} : { maxFlushChunks: options.maxFlushChunks }),
    newStreamId: () => `s${String(++streamCounter)}`,
  });
  return {
    stream,
    published,
    advance: (ms: number) => { now += ms; },
  };
}

test("the first fragment publishes immediately so the reader sees output without waiting a tick", async () => {
  const app = harness();
  await app.stream.onDelta("item-1", "Checking the ");
  assert.deepEqual(app.published, [
    { id: "s1:1", content: "Checking the ", phase: "stream", streamId: "s1" },
  ]);
});

test("later fragments coalesce until the interval elapses", async () => {
  const app = harness();
  await app.stream.onDelta("item-1", "first ");
  await app.stream.onDelta("item-1", "second ");
  assert.equal(app.published.length, 1, "text inside one interval stays buffered");

  app.advance(1_000);
  await app.stream.onDelta("item-1", "third");
  assert.equal(app.published.length, 2);
  assert.equal(app.published[1]?.content, "second third");
});

test("a whitespace-only fragment is never published, and its whitespace is kept for the next one", async () => {
  const app = harness();
  await app.stream.onDelta("item-1", "one");
  app.advance(1_000);
  await app.stream.onDelta("item-1", "\n\n");
  assert.equal(app.published.length, 1, "blank output is not worth a canonical event");

  app.advance(1_000);
  await app.stream.onDelta("item-1", "two");
  assert.equal(app.published.length, 2);
  assert.equal(app.published[1]?.content, "\n\ntwo", "the separator must survive into the merged view");
});

test("completing a native item flushes its tail and returns the text it streamed", async () => {
  const app = harness();
  await app.stream.onDelta("item-1", "answer");
  app.advance(10);
  await app.stream.onDelta("item-1", " tail");
  assert.equal(app.published.length, 1);

  assert.equal(await app.stream.onItemCompleted("item-1"), "answer tail");
  assert.equal(app.published.length, 2);
  assert.equal(app.published[1]?.content, " tail");
});

test("an item that never streamed reports nothing so the caller keeps its own publication", async () => {
  const app = harness();
  assert.equal(await app.stream.onItemCompleted("never-seen"), undefined);
  assert.deepEqual(app.published, []);
});

test("concurrent items stream under separate identities", async () => {
  const app = harness();
  await app.stream.onDelta("item-1", "one");
  await app.stream.onDelta("item-2", "two");
  assert.deepEqual(app.published.map((chunk) => chunk.streamId), ["s1", "s2"]);
  assert.deepEqual(app.published.map((chunk) => chunk.id), ["s1:1", "s2:1"]);
});

test("an item that speaks again after completing starts a new stream", async () => {
  const app = harness();
  await app.stream.onDelta("item-1", "first");
  await app.stream.onItemCompleted("item-1");
  app.advance(1_000);
  await app.stream.onDelta("item-1", "second");
  assert.deepEqual(app.published.map((chunk) => chunk.streamId), ["s1", "s2"]);
});

test("one publication never exceeds the byte budget, and a split character is never broken", async () => {
  const app = harness({ maxChunkBytes: 5 });
  await app.stream.onDelta("item-1", "汉语词典");
  assert.deepEqual(app.published.map((chunk) => chunk.content), ["汉"],
    "five bytes hold one three-byte character but not two");

  assert.equal(await app.stream.onItemCompleted("item-1"), "汉语词典");
  assert.deepEqual(app.published.map((chunk) => chunk.content), ["汉", "语", "词", "典"],
    "the closing item drains the rest, one bounded publication at a time");
  assert.ok(app.published.every((chunk) => Buffer.byteLength(chunk.content) <= 5));
});

test("an item whose tail could not be fully published reports only what it streamed", async () => {
  const app = harness({ maxChunkBytes: 5, maxFlushChunks: 1 });
  await app.stream.onDelta("item-1", "汉语词典");
  assert.equal(await app.stream.onItemCompleted("item-1"), "汉语",
    "the caller compares this with the completed text and publishes the remainder itself");
});

test("settling the turn flushes every buffered item exactly once", async () => {
  const app = harness();
  await app.stream.onDelta("item-1", "one");
  app.advance(1);
  await app.stream.onDelta("item-1", " more");
  await app.stream.onDelta("item-2", "two");
  app.advance(1);
  await app.stream.onDelta("item-2", " more");

  await app.stream.onTurnSettled();
  assert.deepEqual(app.published.map((chunk) => chunk.content), ["one", "two", " more", " more"]);
  await app.stream.onTurnSettled();
  assert.equal(app.published.length, 4, "a settled turn must not republish");
});

test("the time of the last publication is observable so a silent stream can fall back to a heartbeat", async () => {
  const app = harness();
  assert.equal(app.stream.lastPublishedAt(), undefined, "nothing is published yet");
  await app.stream.onDelta("item-1", "hello");
  assert.equal(app.stream.lastPublishedAt(), 0);
  app.advance(2_500);
  await app.stream.onDelta("item-1", "again");
  assert.equal(app.stream.lastPublishedAt(), 2_500);
});
