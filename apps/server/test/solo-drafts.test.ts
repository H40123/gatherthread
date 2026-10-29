import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { DiscardEmptySoloInputSchema } from "@gatherthread/protocol";
import { startCollaborationServer } from "../src/server.js";
import { identityFixture, browserSessionFixture } from "./auth-fixtures.js";

test("discard-empty HTTP requires owner authentication and CSRF, and preserves used and Multi sessions", async () => {
  const origin = "http://solo-fixture.invalid";
  const server = await startCollaborationServer({ databasePath: ":memory:", allowedOrigins: [origin], authTokenPepper: "solo-http-synthetic-pepper-long-enough" }, 0);
  try {
    const owner = identityFixture(server, {}).body.data;
    const other = identityFixture(server, {}).body.data;
    const cookie = (token: string) => browserSessionFixture(server, { token }).headers.get("set-cookie")!.split(";")[0]!;
    const ownerCookie = cookie(owner.token), otherCookie = cookie(other.token);
    const project = server.service.createProject(owner.actor, { title: "Solo fixture", idempotency_key: "solo-http-project" });
    const make = (title: string, mode: "solo" | "multi" = "solo") => server.service.createSession(owner.actor, { project_id: project.id, title, mode, idempotency_key: `solo-http-${title}` }).session;
    const post = (id: string, body: unknown = {}, auth = ownerCookie, from = origin) => fetch(`${server.origin}/v1/sessions/${id}/discard-empty`, {
      method: "POST", headers: { cookie: auth, origin: from, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const empty = make("empty");
    assert.equal((await post(empty.id, {}, "")).status, 401);
    assert.equal((await post(empty.id, {}, ownerCookie, "http://foreign.invalid")).status, 403);
    assert.ok([403, 404].includes((await post(empty.id, {}, otherCookie)).status));
    assert.equal((await post(empty.id, { force: true })).status, 400);
    const multi = make("multi", "multi");
    assert.deepEqual(await (await post(multi.id)).json(), { data: { session_id: multi.id, discarded: false } });
    const used = make("used");
    server.service.appendEvent(owner.actor, used.id, { type: "human_chat", visibility: "session", idempotency_key: "solo-http-message", payload: { content: "Retain this accepted message" } });
    assert.deepEqual(await (await post(used.id)).json(), { data: { session_id: used.id, discarded: false } });
    assert.deepEqual(await (await post(empty.id)).json(), { data: { session_id: empty.id, discarded: true } });
    assert.equal((await post(empty.id)).status, 404);
  } finally { await server.close(); }
});

test("discard-empty is owner-only, mode-safe and checks accepted history in the delete transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "gt-solo-draft-"));
  const db = new CollaborationDatabase(join(dir, "test.sqlite"), { authTokenPepper: "test-only-pepper-for-solo-drafts" });
  try {
    const service = new CollaborationService(db);
    const owner = db.bootstrapIdentity({ display_name: "Owner", device_name: "Browser", user_id: "owner", device_id: "device" }).actor;
    const stranger = db.createIdentity({ display_name: "Stranger", device_name: "Browser", user_id: "stranger", device_id: "stranger-device" }).actor;
    const project = service.createProject(owner, { title: "Drafts", idempotency_key: "create-draft-project" });
    const make = (name: string, mode: "solo" | "multi" = "solo") => service.createSession(owner,
      { project_id: project.id, title: name, mode, idempotency_key: `create-draft-${name}` }).session;
    const empty = make("empty");
    assert.throws(() => service.discardEmptySolo(stranger, empty.id));
    assert.equal(service.discardEmptySolo(owner, make("multi", "multi").id).discarded, false);
    const sent = make("sent");
    service.appendEvent(owner, sent.id, { type: "human_chat", visibility: "session", idempotency_key: "first-draft-message", payload: { content: "keep" } });
    assert.equal(service.discardEmptySolo(owner, sent.id).discarded, false);
    assert.equal(service.getSession(owner, sent.id).session.id, sent.id);
    assert.deepEqual(service.discardEmptySolo(owner, empty.id), { session_id: empty.id, discarded: true });
    assert.throws(() => service.getSession(owner, empty.id));
    assert.throws(() => service.discardEmptySolo(owner, empty.id));
    const revoked = make("revoked");
    service.revokeDevice(owner, owner.device_id);
    assert.throws(() => service.discardEmptySolo(owner, revoked.id));
    assert.equal(db.requireSession(revoked.id).id, revoked.id);
    assert.throws(() => DiscardEmptySoloInputSchema.parse({ force: true }));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
