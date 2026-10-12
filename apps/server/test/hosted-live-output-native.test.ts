import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { HostedContainerProgress } from "../src/hosted-live-output.js";

// Exercise the exact modules copied into the OCI image, without OpenCode,
// Docker, provider requests, credentials, or a listening test server.
const { createOpencodeLiveOutput, createHostedProgressWriter, HOSTED_PROGRESS_PREFIX } = await import(new URL("../../../../ops/hosted-agent/live-output.mjs", import.meta.url).href);
const { runOpencodeSession } = await import(new URL("../../../../ops/hosted-agent/opencode-session.mjs", import.meta.url).href);
const own = "ses_fixture";
const info = (id = "msg_owned", role = "assistant", sessionID = own) => ({ type: "message.updated", properties: { sessionID, info: { id, role, sessionID } } });
const part = (id: string, type: string, value: Record<string, unknown>, messageID = "msg_owned", sessionID = own) => ({
  type: "message.part.updated", properties: { sessionID, part: { id, type, sessionID, messageID, ...value } },
});

test("pinned native events map owned assistant answer/reasoning, tool display, and todos with opaque IDs", () => {
  const output: HostedContainerProgress[] = [];
  const mapper = createOpencodeLiveOutput(own, (value: HostedContainerProgress) => output.push(value), { intervalMs: 0 });
  mapper.accept(info());
  mapper.accept(part("prt_answer", "text", { text: "Visible answer " }));
  mapper.accept(part("prt_reasoning", "reasoning", { text: "Visible analysis ", metadata: { signature: "private-signature" } }));
  mapper.accept(part("prt_tool", "tool", { tool: "bash", callID: "private-call-id", state: {
    status: "running", title: "Run tests", input: { password: "private-input" }, metadata: { output: "Observed test output ", authorization: "private-header" },
  } }));
  mapper.accept(part("prt_tool", "tool", { tool: "bash", state: { status: "completed", title: "Run tests", output: "Tests passed", attachments: [{ url: "private-attachment" }] } }));
  mapper.accept({ type: "todo.updated", properties: { sessionID: own, todos: [{ content: "Run tests", status: "completed", priority: "high", id: "private-todo" }] } });
  assert.deepEqual(output.map((entry) => entry.kind), ["answer", "reasoning", "tool", "tool", "plan"]);
  assert.equal(output[2]!.state, "running"); assert.equal(output[3]!.state, "completed");
  assert.equal(output[2]!.item_id, output[3]!.item_id);
  assert.deepEqual(output[4]!.plan, [{ step: "Run tests", status: "completed" }]);
  assert.ok(output.every((entry) => /^item-\d+$/u.test(entry.item_id)));
  assert.ok(!/ses_fixture|msg_owned|prt_|private-/u.test(JSON.stringify(output)));
  mapper.accept({ type: "todo.updated", properties: { sessionID: own, todos: [] } });
  assert.equal(output[5]!.item_id, output[4]!.item_id); assert.deepEqual(output[5]!.plan, []);
  mapper.close();
});

test("foreign sessions, system/user parts, synthetic text, unknown delta fields and raw metadata are excluded", () => {
  const output: HostedContainerProgress[] = [];
  const mapper = createOpencodeLiveOutput(own, (value: HostedContainerProgress) => output.push(value), { intervalMs: 0 });
  mapper.accept(info("msg_foreign", "assistant", "ses_foreign"));
  mapper.accept(info("msg_system", "system")); mapper.accept(info("msg_user", "user"));
  mapper.accept(part("prt_foreign", "text", { text: "private foreign" }, "msg_foreign", "ses_foreign"));
  mapper.accept(part("prt_system", "text", { text: "private system" }, "msg_system"));
  mapper.accept(part("prt_user", "text", { text: "private prompt" }, "msg_user"));
  mapper.accept(info());
  mapper.accept(part("prt_synthetic", "text", { text: "private synthetic", synthetic: true }));
  mapper.accept(part("prt_ignored", "text", { text: "private ignored", ignored: true }));
  mapper.accept(part("prt_snapshot", "snapshot", { snapshot: "private snapshot" }));
  mapper.accept(part("prt_mcp", "tool", { tool: "unapproved-mcp", state: { status: "completed", output: "private output" } }));
  mapper.accept(part("prt_answer", "text", { text: "Safe " }));
  mapper.accept({ type: "message.part.delta", properties: { sessionID: own, messageID: "msg_owned", partID: "prt_answer", field: "metadata", delta: "private metadata" } });
  mapper.accept({ type: "message.part.delta", properties: { sessionID: "ses_foreign", messageID: "msg_owned", partID: "prt_answer", field: "text", delta: "private foreign" } });
  mapper.accept({ type: "message.part.delta", properties: { sessionID: own, messageID: "msg_other", partID: "prt_answer", field: "text", delta: "private other message" } });
  mapper.accept({ type: "message.part.delta", properties: { sessionID: own, messageID: "msg_owned", partID: "prt_answer", field: "text", delta: "answer " } });
  mapper.accept(part("prt_answer", "text", { text: "Safe answer " }));
  assert.deepEqual(output.map((entry) => entry.content), ["Safe ", "Safe answer "]);
  mapper.close(); mapper.accept(part("prt_late", "text", { text: "private late" }));
  assert.equal(output.length, 2);
});

test("native telemetry is byte/item bounded and a cut credential token is dropped before transport", () => {
  const output: HostedContainerProgress[] = [];
  const mapper = createOpencodeLiveOutput(own, (value: HostedContainerProgress) => output.push(value), { intervalMs: 0 });
  mapper.accept(info());
  mapper.accept(part("prt_large", "text", { text: "x".repeat(47_900) + " " + "sk-" + "cut-credential".repeat(1000) }));
  assert.ok(Buffer.byteLength(output[0]!.content) <= 48_000);
  assert.ok(output[0]!.content.endsWith("[TRUNCATED]"));
  assert.ok(!output[0]!.content.includes("sk-"));
  for (let i = 0; i < 150; i++) mapper.accept(part(`prt_${i}`, "text", { text: "Short output " }));
  assert.equal(output.length, 128);
  mapper.close();
  const lines: string[] = [];
  const writer = createHostedProgressWriter({ write: (line: string) => lines.push(line), maxBytes: 1000 });
  for (let i = 0; i < 100; i++) writer({ item_id: "item-1", kind: "answer", content: "Synthetic output", state: "running" });
  assert.ok(lines.length > 0 && lines.length < 100);
  assert.ok(lines.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0) <= 1000);
  assert.ok(lines.every((line) => line.startsWith(HOSTED_PROGRESS_PREFIX) && line.endsWith("\n") && JSON.parse(line.slice(HOSTED_PROGRESS_PREFIX.length)).version === 1));
});

test("native answer and reasoning stream Chinese without whitespace and truncate on valid UTF-8", () => {
  const output: HostedContainerProgress[] = [];
  const mapper = createOpencodeLiveOutput(own, (value: HostedContainerProgress) => output.push(value), { intervalMs: 0 });
  mapper.accept(info());
  mapper.accept(part("prt_answer", "text", { text: "正在检查项目" }));
  mapper.accept(part("prt_reasoning", "reasoning", { text: "根据工具结果分析" }));
  mapper.accept({ type: "message.part.delta", properties: { sessionID: own, messageID: "msg_owned", partID: "prt_answer", field: "text", delta: "并运行测试" } });
  assert.deepEqual(output.slice(0, 3).map((entry) => entry.content), ["正在检查项目", "根据工具结果分析", "正在检查项目并运行测试"]);
  mapper.accept(part("prt_large_chinese", "reasoning", { text: "中文".repeat(10_000) }));
  const last = output.at(-1)!;
  assert.ok(last.content.startsWith("中文")); assert.ok(last.content.endsWith("[TRUNCATED]"));
  assert.ok(!last.content.includes("�")); assert.ok(Buffer.byteLength(last.content) <= 48_000);
  mapper.close();
});

function sessionFixture(options: { eventFailure?: boolean; oversized?: boolean; finalFailure?: boolean; version?: string; eventHeaders?: Promise<void> } = {}) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kills: string[]; kill: (signal: string) => boolean };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); setImmediate(() => { child.emit("exit", null, signal); child.emit("close", null, signal); }); return true; };
  const paths: string[] = [], progress: HostedContainerProgress[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let stream: ReadableStreamDefaultController<Uint8Array>, cancelled = false, spawns = 0;
  const events = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { cancelled = true; } });
  const json = (value: unknown) => Response.json(value);
  const final = () => ({ info: { id: "msg_owned", sessionID: own, role: "assistant", time: { created: 1, completed: 2 }, finish: options.finalFailure ? undefined : "stop" },
    parts: [{ id: "prt_answer", sessionID: own, messageID: "msg_owned", type: "text", text: "你好 Answer done.", time: { start: 1, end: 2 } }] });
  const runOptions = {
    spawnProcess: () => { spawns++; return child; },
    onProgress: (value: HostedContainerProgress) => progress.push(value),
    fetchResponse: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname; paths.push(path);
      assert.equal(new URL(url).origin, "http://127.0.0.1:8790");
      assert.equal(init.redirect, "error");
      assert.equal((init.headers as Record<string, string>)["x-opencode-directory"], "/workspace");
      if (path === "/global/health") return json({ healthy: true, version: options.version ?? "1.18.32" });
      if (path === "/session") return json({ id: own });
      if (path === "/event") {
        await options.eventHeaders;
        return options.eventFailure ? json({ error: "private telemetry error" }) : new Response(events, { headers: { "content-type": "text/event-stream" } });
      }
      if (path === `/session/${own}/message`) {
        if (!options.eventFailure) {
          const data = options.oversized ? "data:" + "x".repeat(300_000) + "\n\n" : [info(), part("prt_answer", "text", { text: "你好 Answer " }),
            { type: "message.part.delta", properties: { sessionID: own, messageID: "msg_owned", partID: "prt_answer", field: "text", delta: "done." } }]
            .map((value) => `event: message\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join("");
          const encoded = Buffer.from(data);
          for (let offset = 0; offset < encoded.length; offset += 17) stream!.enqueue(encoded.subarray(offset, offset + 17));
        }
        entered.resolve(); await release.promise;
        return json(final());
      }
      if (path === "/session/status") return json({});
      throw new Error("unexpected synthetic route");
    },
  };
  return { child, paths, progress, entered, release, runOptions, cancelled: () => cancelled, spawns: () => spawns };
}

test("one pinned process subscribes before prompting and streams UTF-8 before final reply/idle/confirmed close", async () => {
  const f = sessionFixture();
  const pending = runOpencodeSession("/workspace", "Synthetic request", 64_000, f.runOptions);
  await f.entered.promise; await delay(10);
  assert.ok(f.progress.some((entry) => entry.content.startsWith("你好 Answer")));
  assert.deepEqual(f.child.kills, []);
  assert.deepEqual(f.paths.slice(0, 4), ["/global/health", "/session", "/event", `/session/${own}/message`]);
  f.release.resolve();
  assert.equal(await pending, "你好 Answer done.");
  assert.equal(f.spawns(), 1); assert.equal(f.cancelled(), true);
  assert.deepEqual(f.child.kills, ["SIGTERM"]);
  assert.ok(f.progress.every((entry) => !entry.content.includes("�")));
});

test("a slow event subscription must finish registration before the one prompt dispatch", async () => {
  const ready = Promise.withResolvers<void>();
  const f = sessionFixture({ eventHeaders: ready.promise });
  const pending = runOpencodeSession("/workspace", "Synthetic request", 64_000, f.runOptions);
  await delay(10);
  assert.deepEqual(f.paths, ["/global/health", "/session", "/event"]);
  assert.deepEqual(f.child.kills, []);
  ready.resolve(); await f.entered.promise; f.release.resolve();
  assert.equal(await pending, "你好 Answer done.");
  assert.equal(f.paths.filter((path) => path.endsWith("/message")).length, 1);
  assert.equal(f.cancelled(), true);
});

test("unexpected owned process exit tears down the live subscription and refuses a delayed final reply", async () => {
  const f = sessionFixture();
  const pending = runOpencodeSession("/workspace", "Synthetic request", 64_000, f.runOptions);
  const refused = assert.rejects(pending, { message: "agent_failed" });
  await f.entered.promise;
  f.child.emit("exit", 1, null); f.child.emit("close", 1, null); f.release.resolve();
  await refused;
  assert.equal(f.cancelled(), true);
  assert.equal(f.spawns(), 1);
});

test("unavailable or oversized telemetry never replaces valid final checks; partial final still fails", async () => {
  for (const scenario of [{ eventFailure: true }, { oversized: true }, { finalFailure: true }]) {
    const f = sessionFixture(scenario);
    const pending = runOpencodeSession("/workspace", "Synthetic request", 64_000, f.runOptions);
    const result = scenario.finalFailure ? assert.rejects(pending, { message: "agent_failed" }) : pending;
    await f.entered.promise; f.release.resolve();
    await result;
    assert.deepEqual(f.child.kills, ["SIGTERM"]);
    assert.ok(!JSON.stringify(f.progress).includes("private telemetry error"));
  }
  const f = sessionFixture({ version: "unsupported" });
  await assert.rejects(runOpencodeSession("/workspace", "Synthetic request", 64_000, f.runOptions), { message: "agent_failed" });
  assert.ok(!f.paths.includes("/event")); assert.equal(f.progress.length, 0);
});
