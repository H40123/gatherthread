import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Client, fetch as modelFetch, type Agent } from "undici";
import { createHostedModelDispatcher, destroyHostedModelDispatcher, HOSTED_AGENT_TIMEOUT_MS, isHostedTransportTimeout } from "../src/hosted-model-transport.js";

// Undici's maintained test clock advances parser timers without waiting 12 real
// minutes. HTTP sockets, Agent, Client and streaming fetch are otherwise real.
const require = createRequire(import.meta.url);
const clock = require("undici/lib/util/timers.js") as { tick(milliseconds: number): void; reset(): void };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

for (const phase of ["headers", "body"] as const) {
  test(`real model transport permits ${phase} past Node's old five-minute limit and closes only its private dispatcher`, { timeout: 5000 }, async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const server = createServer(async (_request, response) => {
      if (phase === "body") { response.writeHead(200, { "content-type": "text/plain" }); response.write("first "); }
      entered.resolve(); await release.promise;
      if (!response.destroyed) response.end("completed");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    let observed: { headersTimeout?: number; bodyTimeout?: number } = {};
    const factory: Agent.Options["factory"] = (origin, options) => {
      observed = options as Client.Options;
      return new Client(origin, options as Client.Options);
    };
    const dispatcher = createHostedModelDispatcher(factory);
    const other = createHostedModelDispatcher();
    let settled = false;
    const result = modelFetch(`http://127.0.0.1:${address.port}`, { dispatcher, redirect: "error" })
      .then(response => response.text()).finally(() => { settled = true; });
    try {
      await entered.promise; await flush();
      assert.equal(observed.headersTimeout, 720_000); assert.equal(observed.bodyTimeout, 720_000);
      assert.equal(HOSTED_AGENT_TIMEOUT_MS, 720_000);
      clock.tick(0); clock.tick(301_000); await flush();
      assert.equal(settled, false, "the actual parser must stay alive past the old five-minute default");
      release.resolve(); assert.equal(await result, phase === "body" ? "first completed" : "completed");
      await destroyHostedModelDispatcher(dispatcher);
      assert.equal(dispatcher.destroyed, true); assert.equal(other.destroyed, false);
    } finally {
      release.resolve(); await destroyHostedModelDispatcher(dispatcher); await destroyHostedModelDispatcher(other);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); clock.reset();
    }
  });
}

test("real model header parser still times out at the 12-minute bound and exposes only safe timeout category", { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const server = createServer(() => entered.resolve());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dispatcher = createHostedModelDispatcher();
  const address = server.address() as { port: number };
  const result = modelFetch(`http://127.0.0.1:${address.port}`, { dispatcher });
  // Attach before advancing the clock, so an expected rejection is not unhandled.
  const checked = assert.rejects(result, isHostedTransportTimeout);
  try {
    await entered.promise; await flush(); clock.tick(0); clock.tick(721_000); await checked;
  } finally {
    await destroyHostedModelDispatcher(dispatcher); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); clock.reset();
  }
});

test("known Undici header/body/connect timeouts classify safely, unrelated transport failure remains failure", () => {
  for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]) {
    const cause = Object.assign(new Error("private network detail"), { code });
    assert.equal(isHostedTransportTimeout(new TypeError("fetch failed", { cause })), true);
  }
  assert.equal(isHostedTransportTimeout(Object.assign(new Error("private connection detail"), { code: "ECONNRESET" })), false);
});
