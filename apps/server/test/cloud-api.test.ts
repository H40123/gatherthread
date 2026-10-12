import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CloudApiStore } from "../src/cloud-api.js";
import { CollaborationDatabase } from "../src/database.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gt-cloud-api-test-"));
  const database = new CollaborationDatabase(join(root, "identity.db"), { authTokenPepper: "cloud-api-test-fixture-pepper" });
  const actor = database.bootstrapIdentity({ display_name: "Owner", device_name: "Browser" }).actor;
  const other = database.createIdentity({ display_name: "Other", device_name: "Browser" }).actor;
  const key = randomBytes(32).toString("base64");
  const store = new CloudApiStore(database, key);
  const input = { expected_revision: null, provider_id: "deepseek" as const, label: "My model", model: "deepseek-chat",
    enabled: true, api_key: "synthetic-private-provider-value" };
  return { root, database, actor, other, store, input, close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("personal model configuration is encrypted, account-private and write-only", () => {
  const f = fixture();
  try {
    const id = randomUUID(), saved = f.store.put(f.actor, id, f.input);
    assert.equal(saved.id, id); assert.equal(saved.has_key, true);
    assert.equal(f.store.status(f.other).configurations.length, 0);
    assert.doesNotMatch(JSON.stringify(f.store.status(f.actor)), /synthetic-private|ciphertext|nonce|auth_tag/);
    const row = f.database.sqlite.prepare("SELECT * FROM cloud_api_configs WHERE id=?").get(id)!;
    assert.doesNotMatch(JSON.stringify(row), /synthetic-private/);
    assert.equal(f.store.resolve(f.actor, saved.profile_id, saved.revision).apiToken, f.input.api_key);
    assert.throws(() => f.store.resolve(f.other, saved.profile_id, saved.revision), /unavailable/);
    assert.throws(() => f.store.put(f.other, id, f.input), /unavailable/);
  } finally { f.close(); }
});

test("configuration updates are exact-revision CAS, retain omitted keys and fence previous revisions", () => {
  const f = fixture();
  try {
    const id = randomUUID(), first = f.store.put(f.actor, id, f.input);
    assert.equal(f.store.put(f.actor, id, f.input).revision, first.revision, "uncertain create retry is idempotent");
    const { api_key: _key, ...metadata } = f.input;
    const updated = f.store.put(f.actor, id, { ...metadata, expected_revision: first.revision, model: "deepseek-reasoner" });
    assert.notEqual(updated.revision, first.revision);
    assert.equal(f.store.resolve(f.actor, updated.profile_id, updated.revision).apiToken, f.input.api_key);
    assert.throws(() => f.store.resolve(f.actor, first.profile_id, first.revision), /changed/);
    assert.throws(() => f.store.put(f.actor, id, { ...f.input, expected_revision: first.revision }), /changed/);
    assert.throws(() => f.store.remove(f.actor, id, first.revision), /changed/);
    f.store.remove(f.actor, id, updated.revision);
    assert.equal(f.store.status(f.actor).configurations.length, 0);
    assert.throws(() => f.store.resolve(f.actor, updated.profile_id, updated.revision), /unavailable/);
  } finally { f.close(); }
});

test("ciphertext cannot move between accounts, configuration IDs or revisions", () => {
  const f = fixture();
  try {
    const id = randomUUID(), saved = f.store.put(f.actor, id, f.input);
    f.database.sqlite.prepare("UPDATE cloud_api_configs SET revision=? WHERE id=?").run(randomUUID(), id);
    assert.throws(() => f.store.resolve(f.actor, saved.profile_id, f.store.status(f.actor).configurations[0]!.revision), /unavailable/);
  } finally { f.close(); }
});

test("missing master key, disabled configuration, revoked device and unsafe configuration fail closed", () => {
  const f = fixture();
  try {
    assert.equal(new CloudApiStore(f.database).status(f.actor).enabled, false);
    assert.throws(() => new CloudApiStore(f.database, "not-a-32-byte-master-key"), /encryption/);
    assert.throws(() => f.store.put(f.actor, randomUUID(), { ...f.input, base_url: "http://127.0.0.1" } as typeof f.input), /configuration/);
    assert.throws(() => f.store.put(f.actor, randomUUID(), { ...f.input, api_key: "header\r\ninjection" }), /configuration/);
    const saved = f.store.put(f.actor, randomUUID(), { ...f.input, enabled: false });
    assert.throws(() => f.store.resolve(f.actor, saved.profile_id, saved.revision), /unavailable/);
    f.database.revokeDevice(f.actor, f.actor.device_id);
    assert.throws(() => f.store.status(f.actor));
  } finally { f.close(); }
});

test("configuration storage is bounded and keys cascade on account deletion", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 8; i++) f.store.put(f.actor, randomUUID(), { ...f.input, label: `Model ${i}` });
    assert.throws(() => f.store.put(f.actor, randomUUID(), f.input), /limit/);
    f.database.deleteAccount(f.actor);
    assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM cloud_api_configs").get()!.count, 0);
  } finally { f.close(); }
});
