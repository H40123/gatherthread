import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const imageSource = readFileSync(new URL("../../ops/hosted-agent/Dockerfile", import.meta.url), "utf8");
const environmentModule = new URL("../../ops/hosted-agent/runtime-environment.mjs", import.meta.url);

test("hosted image explicitly supplies minimal Python, venv and offline pip alongside existing tools", () => {
  const packages = imageSource.match(/apt-get install[^\n]+/u)?.[0] ?? "";
  for (const name of ["python3", "python3-venv", "python3-pip", "git", "socat", "ca-certificates"]) {
    assert.ok(packages.split(/\s+/u).includes(name), `Missing image package: ${name}`);
  }
  assert.match(imageSource, /PYTHONDONTWRITEBYTECODE=1/u);
  assert.match(imageSource, /PIP_NO_INDEX=1/u);
  assert.match(imageSource, /PIP_DISABLE_PIP_VERSION_CHECK=1/u);
  assert.match(imageSource, /USER 10001:10001/u);
  assert.doesNotMatch(packages, /(?:numpy|scipy|build-essential|sudo|gcc)/u);
});

test("both executor paths explain available workspace tools without asking users to change the host", async () => {
  assert.ok(existsSync(environmentModule), "Missing shared hosted runtime instructions");
  const { withHostedRuntimeInstructions } = await import(environmentModule.href);
  const prompt = "Synthetic task: calculate a square root.\nDo not alter this task.";
  const prepared = withHostedRuntimeInstructions(prompt);
  assert.ok(prepared.endsWith(prompt), "The exact existing prompt must be retained");
  for (const pattern of [/python3/u, /venv/u, /Node\.js/u, /Git/u, /no general network/u,
    /Do not ask the user to run sudo/u, /missing dependencies/u]) assert.match(prepared, pattern);
  const entrypoint = readFileSync(new URL("../../ops/hosted-agent/entrypoint.mjs", import.meta.url), "utf8");
  assert.match(entrypoint, /withHostedRuntimeInstructions\(readFileSync\("\/run\/gatherthread\/prompt\.txt", "utf8"\)\)/u);
  assert.match(imageSource, /COPY --chmod=0644 ops\/hosted-agent\/runtime-environment\.mjs/u);
});

test("temporary Python environments are not traversed or checkpointed as project source", async () => {
  assert.ok(existsSync(environmentModule), "Missing transient-runtime directory policy");
  const { isTransientRuntimeDirectory } = await import(environmentModule.href);
  for (const name of [".venv", "__pycache__"]) assert.equal(isTransientRuntimeDirectory(name), true);
  for (const name of ["venv.py", "src", "venv", ".env.example", "test.py"]) {
    assert.equal(isTransientRuntimeDirectory(name), false, `Source must remain eligible: ${name}`);
  }
  const entrypoint = readFileSync(new URL("../../ops/hosted-agent/entrypoint.mjs", import.meta.url), "utf8");
  assert.match(entrypoint, /if \(isTransientRuntimeDirectory\(name\) \|\| repository && excluded\.has\(name\)\) continue/u);
});

const localPythonTest = process.platform === "win32" ? test.skip : test;
localPythonTest("Python smoke actually executes a standard-library program and a venv without provider calls", () => {
  const fixture = new URL("../fixtures/hosted-python-smoke.py", import.meta.url);
  assert.ok(existsSync(fixture), "Missing executable Python fixture");
  const directory = mkdtempSync(join(tmpdir(), "gt-python-runtime-test-"));
  try {
    // This local check proves fixture behavior, not Linux/container isolation.
    const result = spawnSync("python3", [fileURLToPath(fixture), "--expected-uid", String(process.getuid?.() ?? -1)], {
      cwd: directory, timeout: 30_000, encoding: "utf8",
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
    });
    assert.equal(result.status, 0, "The Python runtime fixture must finish successfully");
    assert.match(result.stdout, /^PYTHON_STDLIB_OK$/mu);
    assert.match(result.stdout, /^PYTHON_VENV_PIP_OK$/mu);
    const smoke = readFileSync(new URL("../test-hosted-container.mjs", import.meta.url), "utf8");
    assert.match(smoke, /python3 python-smoke\.py/u);
    assert.match(smoke, /"PYTHON_STDLIB_OK", "PYTHON_VENV_PIP_OK"/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
