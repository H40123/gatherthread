import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = new URL("../test-environment/prepare-hosted-storage.py", import.meta.url);
const fixtureTest = process.platform === "win32" ? test.skip : test;

fixtureTest("hosted storage inspection is read-only by default and preparation creates only a new private tree", () => {
  assert.ok(existsSync(script), "Missing explicit hosted storage preparation script");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-storage-test-")));
  const root = join(directory, "new-hosted-space");
  const run = (...args) => spawnSync("python3", [fileURLToPath(script), root, "--min-free-mib", "1", ...args], {
    timeout: 10_000, encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  try {
    const inspected = run();
    assert.equal(inspected.status, 0);
    const proposal = JSON.parse(inspected.stdout);
    assert.equal(proposal.prepared, false);
    assert.equal(existsSync(root), false);
    assert.ok(proposal.free_bytes >= 1024 * 1024);
    assert.equal(proposal.candidate, join(root, "candidate"));
    assert.equal(proposal.image_export, join(root, "hosted-image"));
    const prepared = run("--prepare");
    assert.equal(prepared.status, 0);
    const report = JSON.parse(prepared.stdout);
    assert.equal(report.prepared, true);
    for (const child of ["cache", "hosted-tmp"]) assert.ok(existsSync(join(root, child)));
    // Candidate/export commands require entirely new output paths themselves.
    assert.equal(existsSync(report.candidate), false);
    assert.equal(existsSync(report.image_export), false);
    writeFileSync(join(root, "existing-data.txt"), "keep this data");
    assert.notEqual(run("--prepare").status, 0);
    assert.equal(readFileSync(join(root, "existing-data.txt"), "utf8"), "keep this data");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

fixtureTest("storage preparation refuses existing data, symlinks, ambiguous paths and inadequate free space", () => {
  assert.ok(existsSync(script), "Missing explicit hosted storage preparation script");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gt-storage-reject-test-")));
  try {
    const old = join(directory, "existing"); mkdirSync(old);
    const link = join(directory, "linked"); symlinkSync(old, link);
    const args = [old, link, join(link, "new"), "relative-path", "/", `${directory}/../new`];
    for (const root of args) {
      const result = spawnSync("python3", [fileURLToPath(script), root, "--prepare", "--min-free-mib", "1"], { encoding: "utf8" });
      assert.notEqual(result.status, 0, `Must refuse unsafe/reused root: ${root}`);
    }
    const large = spawnSync("python3", [fileURLToPath(script), join(directory, "too-large"),
      "--prepare", "--min-free-mib", "1073741824"], { encoding: "utf8" });
    assert.notEqual(large.status, 0);
    assert.equal(existsSync(join(directory, "too-large")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("large image archive staging uses the requested output filesystem rather than host temporary storage", () => {
  const exporter = readFileSync(new URL("../test-environment/export-hosted-image.sh", import.meta.url), "utf8");
  assert.match(exporter, /task_archive_work="\$\(mktemp -d "\$task_output\/\.staging\.XXXXXXXX"\)"/u);
  assert.match(exporter, /"\$task_archive_work\/hosted-image\.tar\.gz" "\$task_private\/archive\.json"/u);
  assert.doesNotMatch(exporter, /"\$task_private\/hosted-image\.tar\.gz"/u);
  assert.doesNotMatch(exporter, /(?:data-root|docker system prune|docker volume rm)/u);
});
