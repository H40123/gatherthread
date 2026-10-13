import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostedModelProxy } from "../src/hosted-agent.js";
import { ApiError } from "../src/errors.js";
import { CLOUD_API_PROVIDERS } from "../src/cloud-api.js";
import type { HostedEndpoint } from "../src/hosted-agent-pool.js";

const socketTest = process.platform === "win32" ? test.skip : test;
const endpoint = { id: "anthropic", profileId: "anthropic", label: "Claude fixture", provider: "anthropic" as const,
  transport: "anthropic-messages" as const, model: "claude-fixture", baseUrl: "https://api.anthropic.com/v1",
  apiToken: "private-anthropic-key", quotaGroup: "personal-fixture", dailyRuns: 100, maxConcurrent: 1 };
const nativeBody = { model: endpoint.model, messages: [{ role: "user", content: "Fixture" }], max_tokens: 512, stream: true };
function post(path: string, socketPath: string, body: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "x-api-key": "untrusted" } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body })); res.on("error", reject);
    }); req.on("error", reject); req.end(JSON.stringify(body));
  });
}
socketTest("native Anthropic uses fixed Messages route and host-only credentials, streaming tools intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "gt-native-api-")), socket = join(root, "model.sock"); let calls = 0;
  const stream = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"bash","id":"tool-1","input":{}}}\n\n';
  const proxy = new HostedModelProxy({ endpoint, fetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.anthropic.com/v1/messages"); assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers); assert.equal(headers.get("x-api-key"), endpoint.apiToken);
    assert.equal(headers.get("anthropic-version"), "2023-06-01"); assert.equal(headers.get("authorization"), null);
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, endpoint.model); assert.equal(body.max_tokens, 1024);
    assert.equal(body.n, undefined); assert.equal(body.max_completion_tokens, undefined); assert.equal(body.thinking, undefined);
    return new Response(stream, { headers: { "content-type": "text/event-stream", "x-private-provider": endpoint.apiToken } });
  } });
  try {
    await proxy.listen(socket);
    assert.equal((await post("/v1/chat/completions", socket, nativeBody)).status, 404);
    assert.equal((await post("/v1/messages", socket, { ...nativeBody, model: "other" })).status, 400);
    assert.equal((await post("/v1/messages", socket, { ...nativeBody, max_tokens: 8192 })).status, 400);
    const response = await post("/v1/messages", socket, { ...nativeBody, thinking: { type: "enabled", budget_tokens: 8096 } });
    assert.equal(response.status, 200); assert.equal(response.body, stream); assert.equal(calls, 1);
    for (let n = 0; n < 7; n++) assert.equal((await post("/v1/messages", socket, nativeBody)).status, 200);
    assert.equal((await post("/v1/messages", socket, nativeBody)).status, 429); assert.equal(calls, 8);
  } finally { await proxy.close(); rmSync(root, { recursive: true, force: true }); }
});
socketTest("native streaming rechecks authorization on each chunk and cancels pending upstream", async () => {
  const root = mkdtempSync(join(tmpdir(), "gt-native-revoke-")), socket = join(root, "model.sock");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let authorized = true, upstreamSignal: AbortSignal | undefined;
  const proxy = new HostedModelProxy({ endpoint, authorize: () => { if (!authorized) throw new ApiError(403, "revoked", "Revoked"); },
    fetch: async (_url, init) => { upstreamSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ async start(control) {
        control.enqueue(new TextEncoder().encode("first")); entered.resolve(); await release.promise;
        control.enqueue(new TextEncoder().encode("private late content")); control.close();
      } }), { headers: { "content-type": "text/event-stream" } }); },
  });
  try {
    await proxy.listen(socket); const reply = post("/v1/messages", socket, nativeBody).catch(() => ({ status: 0, body: "" }));
    await entered.promise; authorized = false; release.resolve(); const response = await reply;
    assert.doesNotMatch(response.body, /private late content/); assert.equal(upstreamSignal?.aborted, true);
  } finally { release.resolve(); await proxy.close(); rmSync(root, { recursive: true, force: true }); }
});

function personalEndpoint(baseUrl: string): HostedEndpoint {
  return { ...endpoint, id: "personal-fixture", profileId: "api-10000000-0000-4000-8000-000000000001", provider: "openai-compatible", transport: "openai-chat", model: "my-enabled-model", baseUrl,
    personal: { configId: "10000000-0000-4000-8000-000000000001", configRevision: "20000000-0000-4000-8000-000000000001", userId: "fixture-user" } };
}

test("personal API egress rejects every non-exact origin/path and transport before any request", () => {
  for (const baseUrl of ["http://127.0.0.1/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1/", "https://dashscope.aliyuncs.com/compatible-mode/v1?x=1",
    "https://dashscope.aliyuncs.com:443/compatible-mode/v1", "https://key@dashscope.aliyuncs.com/compatible-mode/v1", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://ark.cn-beijing.volces.com/api/v3/../v1", "https://open.bigmodel.cn/api/paas/v4/other"]) {
    assert.throws(() => new HostedModelProxy({ endpoint: personalEndpoint(baseUrl), fetch: async () => { throw Error("must not fetch"); } }), /personal.*destination/i);
  }
  assert.throws(() => new HostedModelProxy({ endpoint: { ...personalEndpoint("https://api.anthropic.com/v1"), transport: "openai-chat" }, fetch: async () => { throw Error("must not fetch"); } }), /personal.*destination/i);
});

socketTest("domestic providers use only their exact fixed chat endpoint with no redirects or model substitution", async () => {
  const root = mkdtempSync(join(tmpdir(), "gt-domestic-api-"));
  try {
    for (const id of ["qwen", "glm", "doubao"]) {
      const preset = CLOUD_API_PROVIDERS.find(item => String(item.id) === id); assert.ok(preset);
      const selected = personalEndpoint(preset.base_url); let calls = 0;
      const proxy = new HostedModelProxy({ endpoint: selected, fetch: async (url, init) => {
        calls++; assert.equal(url, `${preset.base_url}/chat/completions`); assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${selected.apiToken}`);
        assert.equal(JSON.parse(String(init?.body)).model, "my-enabled-model");
        return Response.json({ choices: [{ message: { content: "Fixture" }, finish_reason: "stop" }] });
      } });
      try {
        const socket = join(root, `${id}.sock`); await proxy.listen(socket);
        const body = { model: selected.model, messages: [{ role: "user", content: "Fixture" }] };
        assert.equal((await post("/v1/chat/completions", socket, body)).status, 200); assert.equal(calls, 1);
        selected.baseUrl = "https://api.openai.com/v1";
        assert.equal((await post("/v1/chat/completions", socket, body)).status, 502); assert.equal(calls, 1, "an allowlisted but different provider cannot receive this credential");
        selected.baseUrl = "https://127.0.0.1/v1";
        assert.equal((await post("/v1/chat/completions", socket, body)).status, 502); assert.equal(calls, 1);
      } finally { await proxy.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
