import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCodexConnectCli } from "../src/codex-connect.js";
import { runClaudeConnectCli } from "../src/claude-connect.js";

for (const harness of ["codex", "claude"] as const) {
  for (const stage of ["device-authorizations/claim", "me", "projects"] as const) {
    test(`${harness} Launcher Stop aborts pending startup ${stage} without a failed exit or retry`, { timeout: 3000 }, async t => {
      const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
      const control = new PassThrough();
      Object.defineProperty(process, "stdin", { value: control, configurable: true });
      const entered = Promise.withResolvers<void>();
      let pendingSignal: AbortSignal | undefined, pendingCalls = 0;
      t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
        if (String(input).endsWith(`/${stage}`)) {
          pendingCalls++;
          pendingSignal = init.signal ?? undefined;
          entered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(pendingSignal!.reason);
            pendingSignal!.addEventListener("abort", abort, { once: true });
            if (pendingSignal!.aborted) abort();
            t.signal.addEventListener("abort", () => reject(new Error("Fixture never cancelled")), { once: true });
          });
        }
        assert.match(String(input), /\/me$/u, "Stop must not advance into native setup");
        return Response.json({ data: { id: "fixture-user", username: "Fixture", device_id: "fixture-device" } });
      });
      const args = ["--url", "http://127.0.0.1:9", "--project", "fixture-project", "--workspace", process.cwd(),
        ...(harness === "claude" ? ["--model", "claude-fixture"] : [])];
      const run = harness === "claude" ? runClaudeConnectCli : runCodexConnectCli;
      const token = stage === "device-authorizations/claim" ? `gtd_${"a".repeat(43)}` : "gta_fixture";
      try {
        const operation = run(args, { GATHERTHREAD_TOKEN: token, GATHERTHREAD_LAUNCHER_CONTROL: "stdin-v1" });
        await entered.promise;
        assert.equal(pendingSignal?.aborted, false);
        control.write("gatherthread:stop\n");
        await operation;
        assert.equal(pendingSignal?.aborted, true);
        assert.equal(pendingCalls, 1, "an interrupted one-use grant or request must not be retried");
        assert.equal(control.listenerCount("data"), 0);
      } finally { Object.defineProperty(process, "stdin", stdin); control.destroy(); }
    });
  }
}
