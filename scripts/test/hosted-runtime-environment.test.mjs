import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { isTransientRuntimeDirectory } from "../../ops/hosted-agent/runtime-environment.mjs";

const imageSource = readFileSync(new URL("../../ops/hosted-agent/Dockerfile", import.meta.url), "utf8");
const environmentModule = new URL("../../ops/hosted-agent/runtime-environment.mjs", import.meta.url);
const entrypointSource = readFileSync(new URL("../../ops/hosted-agent/entrypoint.mjs", import.meta.url), "utf8");

function snapshotFixture(repository) {
  const root = mkdtempSync(join(tmpdir(), "gt-runtime-snapshot-"));
  const input = join(root, "input"), workspaceRoot = join(root, "workspace");
  const workspace = repository ? join(workspaceRoot, "project") : workspaceRoot;
  mkdirSync(input); mkdirSync(workspace, { recursive: true });
  const workspaceReads = [];
  const mapped = (path) => {
    if (path === "/input" || path.startsWith("/input/")) return join(input, path.slice(6));
    if (path === "/workspace" || path.startsWith("/workspace/")) return join(workspaceRoot, path.slice(10));
    throw new Error("Unexpected inventory filesystem path");
  };
  // Execute the actual production inventory functions, without main(), a
  // harness or a model. Only their filesystem roots are confined to this fixture.
  const inventorySource = entrypointSource.slice(entrypointSource.indexOf("const INPUT ="), entrypointSource.indexOf("function run("));
  assert.ok(inventorySource.includes("function initialFiles()") && inventorySource.includes("function outputFiles()"));
  const inventory = runInNewContext(`${inventorySource}\n({ initialFiles, outputFiles, MAX_FILES, MAX_BYTES });`, {
    process: { env: { GT_HOSTED_REPOSITORY: repository ? "1" : "0" } },
    // The extracted functions run in a Linux container. Keep virtual paths
    // POSIX on Windows too; mapped() alone translates into host-native paths.
    join: posix.join, dirname: posix.dirname, isTransientRuntimeDirectory,
    mkdirSync: (path, ...args) => mkdirSync(mapped(path), ...args),
    copyFileSync: (from, to) => copyFileSync(mapped(from), mapped(to)),
    chmodSync: (path, mode) => chmodSync(mapped(path), mode),
    lstatSync: (path) => lstatSync(mapped(path)),
    readFileSync: (path) => readFileSync(mapped(path)),
    readdirSync: (path) => {
      if (path === "/workspace" || path.startsWith("/workspace/")) {
        workspaceReads.push(path);
        if (path.split("/").some(isTransientRuntimeDirectory)) throw new Error("Fresh runtime directories must not be scanned");
      }
      return readdirSync(mapped(path));
    },
  });
  const put = (target, path, content, executable = false) => {
    const absolute = join(target, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content); chmodSync(absolute, executable ? 0o755 : 0o644);
    return { path, content_base64: Buffer.from(content).toString("base64"), executable };
  };
  return { root, input, workspace, workspaceReads, put, ...inventory,
    // Normalize only cross-realm object prototypes, not production file data.
    collect: () => JSON.parse(JSON.stringify(inventory.outputFiles())),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

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
  assert.match(entrypoint, /if \(\(!includeTransient && isTransientRuntimeDirectory\(name\)\) \|\| repository && excluded\.has\(name\)\) continue/u);
});

// Numeric executable-mode preservation is a Linux image contract. These
// filesystem proofs run on Unix hosts; byte/limit checks below remain portable.
const unixSnapshotTest = process.platform === "win32" ? test.skip : test;
for (const repository of [false, true]) {
  const mode = repository ? "repository" : "trial";
  unixSnapshotTest(`${mode} preserves input runtime files byte-for-byte without copying or scanning new environments`, () => {
    const f = snapshotFixture(repository);
    try {
      const preserved = [
        f.put(f.input, ".venv/bin/saved.py", "#!/usr/bin/env python3\nprint('saved')\n", true),
        f.put(f.input, "__pycache__/saved.pyc", Buffer.from([0, 255, 128, 13, 10])),
        f.put(f.input, "src/__pycache__/nested.pyc", Buffer.from([1, 0, 254]), true),
      ];
      f.put(f.input, "main.py", "print('before')\n");
      f.initialFiles();
      assert.equal(existsSync(join(f.workspace, ".venv")), false);
      assert.equal(existsSync(join(f.workspace, "__pycache__")), false);
      assert.equal(existsSync(join(f.workspace, "src", "__pycache__")), false);
      const changed = f.put(f.workspace, "main.py", "print('after')\n", true);
      f.put(f.workspace, ".venv/bin/saved.py", "new runtime must not replace saved source", false);
      f.put(f.workspace, "__pycache__/new.pyc", "new cache");
      f.put(f.workspace, "src/__pycache__/new.pyc", "new nested cache");
      f.put(f.workspace, `.venv/${Array(20).fill("deep").join("/")}/new.py`, "ignored without scanning");
      assert.deepEqual(f.collect(), [...preserved, changed].sort((a, b) => a.path.localeCompare(b.path)));
      assert.ok(f.workspaceReads.every(path => !path.split("/").some(isTransientRuntimeDirectory)));
    } finally { f.close(); }
  });

  unixSnapshotTest(`${mode} keeps existing runtime files when a saved snapshot starts a later round`, () => {
    const first = snapshotFixture(repository), next = snapshotFixture(repository);
    try {
      const saved = first.put(first.input, ".venv/bin/existing", Buffer.from([0, 65, 255]), true);
      first.put(first.input, "main.py", "print('first')\n"); first.initialFiles();
      for (const item of first.collect()) next.put(next.input, item.path, Buffer.from(item.content_base64, "base64"), item.executable);
      next.initialFiles(); next.put(next.workspace, ".venv/bin/new", "not source");
      assert.deepEqual(next.collect().find(item => item.path === saved.path), saved);
      assert.equal(next.collect().some(item => item.path === ".venv/bin/new"), false);
    } finally { next.close(); first.close(); }
  });

  test(`${mode} counts retained input runtime files toward the unchanged snapshot file limit`, () => {
    const f = snapshotFixture(repository);
    try {
      f.put(f.input, ".venv/saved.txt", "saved"); f.initialFiles();
      for (let i = 0; i < f.MAX_FILES - 1; i++) f.put(f.workspace, `file-${i}.txt`, "source");
      assert.equal(f.collect().length, f.MAX_FILES);
      f.put(f.workspace, "overflow.txt", "source");
      assert.throws(() => f.outputFiles(), /workspace_limit/u);
    } finally { f.close(); }
  });

  test(`${mode} counts retained input runtime bytes toward the unchanged snapshot byte limit`, () => {
    const f = snapshotFixture(repository);
    try {
      let remaining = f.MAX_BYTES - 1, index = 0;
      while (remaining) {
        const size = Math.min(remaining, 2 * 1024 * 1024);
        f.put(f.input, `.venv/saved-${index++}.bin`, Buffer.alloc(size, 65)); remaining -= size;
      }
      f.initialFiles(); f.put(f.workspace, "main.txt", "x");
      assert.equal(f.collect().reduce((sum, item) => sum + Buffer.byteLength(item.content_base64, "base64"), 0), f.MAX_BYTES);
      f.put(f.workspace, "main.txt", "xx");
      assert.throws(() => f.outputFiles(), /workspace_limit/u);
    } finally { f.close(); }
  });

  test(`${mode} rejects symlinks in retained input runtime files rather than following them`, () => {
    const f = snapshotFixture(repository);
    try {
      const target = join(f.root, "private-target"); mkdirSync(target);
      mkdirSync(join(f.input, ".venv"));
      symlinkSync(target, join(f.input, ".venv", "linked"), process.platform === "win32" ? "junction" : "dir");
      f.initialFiles(); assert.throws(() => f.outputFiles(), /unsafe_file/u);
    } finally { f.close(); }
  });

  test(`${mode} enforces the existing depth bound on retained input runtime files`, () => {
    const f = snapshotFixture(repository);
    try {
      f.put(f.input, `.venv/${Array(16).fill("deep").join("/")}/saved.txt`, "too deep");
      f.initialFiles(); assert.throws(() => f.outputFiles(), /workspace_depth/u);
    } finally { f.close(); }
  });
}

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
