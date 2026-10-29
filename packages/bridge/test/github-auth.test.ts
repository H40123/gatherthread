import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectGitHubAccount, runGitHubAuthCommand, type GitHubAuthCommand } from "../src/github-auth.js";

test("GitHub browser login starts only when this device lacks a persistent login", async () => {
  const calls: string[][] = [];
  const command: GitHubAuthCommand = async (args) => {
    calls.push([...args]);
    return calls.length !== 1;
  };
  await connectGitHubAccount(command);
  assert.deepEqual(calls, [
    ["auth", "status", "--hostname", "github.com"],
    ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--clipboard"],
    ["auth", "status", "--hostname", "github.com"],
  ]);
  calls.length = 0;
  await connectGitHubAccount(async (args) => { calls.push([...args]); return true; });
  assert.equal(calls.length, 1);
});

test("cancelled GitHub browser login cannot claim a connected device", async () => {
  await assert.rejects(connectGitHubAccount(async () => false), { code: "github_auth_failed" });
});

test("Launcher cancellation stops GitHub setup before a later login or verification step", async () => {
  for (const stopAt of [1, 2]) {
    const shutdown = new AbortController(), reason = new Error("Fixture stopped"); let calls = 0;
    await assert.rejects(connectGitHubAccount(async (_args, _timeout, signal) => {
      assert.equal(signal, shutdown.signal);
      if (++calls === stopAt) shutdown.abort(reason);
      return false;
    }, shutdown.signal), error => error === reason);
    assert.equal(calls, stopAt);
  }
});

test("GitHub login stop waits for its child exit and escalates a non-responsive local process", {
  skip: process.platform === "win32" ? "POSIX executable fixture; Windows lifecycle is covered by CI" : false,
  timeout: 5000,
}, async t => {
  const folder = await mkdtemp(path.join(tmpdir(), "gt-auth-stop-"));
  const marker = path.join(folder, "started"), command = path.join(folder, "gh");
  await writeFile(command, `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  await chmod(command, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = [folder, path.dirname(process.execPath), originalPath].filter(Boolean).join(path.delimiter);
  const shutdown = new AbortController(), reason = new Error("Fixture cancelled");
  let pid: number | undefined;
  const operation = runGitHubAuthCommand(["auth", "status"], 10000, shutdown.signal);
  const stopped = assert.rejects(operation, error => error === reason);
  const abortFixture = () => { shutdown.abort(reason); if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* fixture already exited */ } } };
  t.signal.addEventListener("abort", abortFixture, { once: true });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await readFile(marker, "utf8").catch(() => "");
      if (value) { pid = Number(value); break; }
      await delay(15);
    }
    assert.ok(pid, "fixture must be running before testing cancellation");
    shutdown.abort(reason);
    await stopped;
    t.signal.removeEventListener("abort", abortFixture);
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally {
    shutdown.abort(reason);
    await stopped;
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(folder, { recursive: true, force: true });
  }
});
