import assert from "node:assert/strict";
import test from "node:test";
import { ProjectInvitationPreviewSchema, PreviewProjectInvitationInputSchema } from "@gatherthread/protocol";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";
import { startCollaborationServer } from "../src/server.js";
import { browserSessionFixture } from "./auth-fixtures.js";

test("preview discloses only confirmation metadata and never consumes an invitation or changes membership", () => {
  const db = new CollaborationDatabase(":memory:");
  try {
    const service = new CollaborationService(db);
    const owner = db.bootstrapIdentity({ display_name: "Inviter", device_name: "Laptop" }).actor;
    const peer = db.createIdentity({ display_name: "Recipient", device_name: "Browser" }).actor;
    const project = service.createProject(owner, { title: "Invitation test", idempotency_key: "invite-preview-project" });
    for (const role of ["participant", "viewer"] as const) {
      const invitation = service.createProjectInvitation(owner, project.id, { role });
      const before = db.sqlite.prepare("SELECT * FROM project_invitations WHERE id = ?").get(invitation.invitation.id);
      const audit = service.listProjectInvitationAudit(owner, project.id);
      const preview = ProjectInvitationPreviewSchema.parse(service.previewProjectInvitation(peer, invitation.invite_token));
      assert.deepEqual(preview, { project: { id: project.id, title: project.title }, inviter_display_name: "Inviter", role,
        created_at: invitation.invitation.created_at, expires_at: invitation.invitation.expires_at, already_member: false });
      assert.deepEqual(db.sqlite.prepare("SELECT * FROM project_invitations WHERE id = ?").get(invitation.invitation.id), before);
      assert.deepEqual(service.listProjectInvitationAudit(owner, project.id), audit);
      assert.deepEqual(service.listProjects(peer), []);
      assert.equal(service.previewProjectInvitation(owner, invitation.invite_token).already_member, true);
      assert.equal(service.listProjectInvitations(owner, project.id).find(row => row.id === invitation.invitation.id)?.claimed_at, null);
    }
  } finally { db.close(); }
});

test("preview refuses revoked, expired, deleted, archived and foreign-consumed capabilities; uncertain acceptance recovers for the current member only", () => {
  const db = new CollaborationDatabase(":memory:");
  try {
    const service = new CollaborationService(db);
    const owner = db.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" }).actor;
    const peer = db.createIdentity({ display_name: "Peer", device_name: "Phone" }).actor;
    const other = db.createIdentity({ display_name: "Other", device_name: "Phone" }).actor;
    const project = service.createProject(owner, { title: "Private", idempotency_key: "invite-unavailable-project" });
    const issue = () => service.createProjectInvitation(owner, project.id, { role: "viewer", ttl: "1h" });
    const unavailable = (secret: string, actor = peer) => assert.throws(() => service.previewProjectInvitation(actor, secret),
      (error: unknown) => (error as { code: string }).code === "invitation_unavailable");
    const revoked = issue(); service.revokeProjectInvitation(owner, project.id, revoked.invitation.id); unavailable(revoked.invite_token);
    const expired = issue();
    db.sqlite.prepare("UPDATE project_invitations SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", expired.invitation.id);
    unavailable(expired.invite_token);
    assert.equal(db.sqlite.prepare("SELECT expired_at FROM project_invitations WHERE id = ?").get(expired.invitation.id)?.expired_at, null);
    const consumed = issue(); service.claimInvitationForActor(peer, consumed.invite_token);
    assert.equal(service.previewProjectInvitation(peer, consumed.invite_token).already_member, true);
    unavailable(consumed.invite_token, other);
    unavailable(consumed.invite_token, owner);
    assert.throws(() => service.claimInvitationForActor(peer, consumed.invite_token)); // Existing accept contract is unchanged.
    service.removeProjectMembership(owner, project.id, peer.user_id);
    unavailable(consumed.invite_token);
    const pending = issue();
    db.sqlite.prepare("UPDATE projects SET state = 'archived' WHERE id = ?").run(project.id);
    unavailable(pending.invite_token);
    db.sqlite.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    unavailable(pending.invite_token);
    const second = service.createProject(owner, { title: "Device gate", idempotency_key: "invite-device-project" });
    const fresh = service.createProjectInvitation(owner, second.id, { role: "participant" });
    db.sqlite.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), peer.device_id);
    assert.throws(() => service.previewProjectInvitation(peer, fresh.invite_token));
  } finally { db.close(); }
});

test("preview HTTP requires current browser authentication, Origin, strict bounded input and a token-free response", async () => {
  const origin = "http://127.0.0.1:8787";
  const running = await startCollaborationServer({ databasePath: ":memory:", allowedOrigins: [origin],
    authTokenPepper: "invitation-fixture-pepper-not-a-credential" }, 0);
  try {
    const owner = running.database.bootstrapIdentity({ display_name: "Owner", device_name: "Laptop" });
    const peer = running.database.createIdentity({ display_name: "Recipient", device_name: "Browser" });
    const cookie = browserSessionFixture(running, { token: peer.token, origin }).headers.get("set-cookie")!.split(";", 1)[0]!;
    const project = running.service.createProject(owner.actor, { title: "HTTP invitation", idempotency_key: "invite-http-project" });
    const invitation = running.service.createProjectInvitation(owner.actor, project.id, { role: "participant" });
    const body = { invite_token: invitation.invite_token };
    const post = (input: unknown, headers: Record<string, string> = { cookie, origin }) => fetch(`${running.origin}/v1/invitations/preview`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input),
    });
    assert.equal((await post(body, { origin })).status, 401);
    assert.equal((await post(body, { authorization: `Bearer ${peer.token}`, origin })).status, 403);
    assert.equal((await post(body, { cookie })).status, 403);
    assert.equal((await post(body, { cookie, origin: "https://untrusted.example" })).status, 403);
    for (const input of [{ ...body, project_id: project.id }, { ...body, user_id: owner.actor.user_id }, {},
      { invite_token: peer.token }, { invite_token: "gti_" + "x".repeat(1024) }]) {
      assert.equal(PreviewProjectInvitationInputSchema.safeParse(input).success, false);
      assert.notEqual((await post(input)).status, 200);
    }
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json() as { data: unknown };
    assert.equal(ProjectInvitationPreviewSchema.parse(payload.data).already_member, false);
    assert.equal(JSON.stringify(payload).includes(invitation.invite_token), false);
    const accept = await fetch(`${running.origin}/v1/invitations/accept`, {
      method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(body),
    });
    assert.equal(accept.status, 200);
    assert.equal(ProjectInvitationPreviewSchema.parse((await post(body).then(r => r.json()) as { data: unknown }).data).already_member, true);
    running.database.sqlite.prepare("UPDATE browser_sessions SET revoked_at = ? WHERE user_id = ?").run(new Date().toISOString(), peer.actor.user_id);
    assert.equal((await post(body)).status, 401);
  } finally { await running.close(); }
});
