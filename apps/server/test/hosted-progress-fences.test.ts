import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LiveOutputUpdate } from "@gatherthread/adapters";
import { CollaborationDatabase } from "../src/database.js";
import { CollaborationService } from "../src/service.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gt-live-fence-"));
  const db = new CollaborationDatabase(join(dir, "db"), { authTokenPepper: "live-output-fixture-pepper" });
  const service = new CollaborationService(db);
  const actor = db.bootstrapIdentity({ display_name: "Author", device_name: "Browser" }).actor;
  const session = service.createSession(actor, { title: "Live fixture", mode: "multi", idempotency_key: "live-session" }).session;
  const result = service.reserveHostedAgentRequest(actor, session.id, { content: "Test", include_code: false,
    profile_id: "default", idempotency_key: "live-request" }, [{ id: "first", profileId: "default",
      provider: "openai-compatible", model: "fixture", quotaGroup: "fixture", dailyRuns: 10, maxConcurrent: 1 }],
    { maxConcurrent: 1, userDailyRuns: 10, globalDailyRuns: 10, userMinIntervalSeconds: 0, userMaxConcurrent: 1 });
  const streamId = randomUUID();
  const update: LiveOutputUpdate = { id: `${streamId}:1`, content: "Visible answer", phase: "stream",
    streamId, streamMode: "snapshot", streamKind: "answer", streamRevision: 1, streamState: "running" };
  return { db, service, actor, session, result, update, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("trusted hosted snapshots publish once with correct provenance and terminal fence", () => {
  const app = fixture();
  try {
    let deliveries = 0; app.service.onEvent(event => { if (event.type === "agent_progress") deliveries++; });
    assert.equal(app.service.appendHostedAgentProgress(app.result.event.id, app.update), true);
    assert.equal(app.service.appendHostedAgentProgress(app.result.event.id, app.update), true);
    const events = app.service.replay(app.actor, app.session.id, 0, 100).events.filter(event => event.type === "agent_progress");
    assert.equal(events.length, 1); assert.equal(deliveries, 1);
    assert.equal(events[0]?.reply_to_event_id, app.result.event.id);
    assert.equal(events[0]?.runtime_provenance?.harness, "opencode");
    app.service.finishHostedAgentRequest(app.result.event.id, { content: "Completed" });
    assert.equal(app.service.appendHostedAgentProgress(app.result.event.id, { ...app.update, id: `${app.update.streamId}:2`, streamRevision: 2 }), false);
  } finally { app.close(); }
});

for (const fence of ["pause", "revocation", "archive", "viewer"] as const) {
  test(`trusted hosted progress stops after ${fence}`, () => {
    const app = fixture();
    try {
      if (fence === "pause") app.service.pauseHostedAgentRequest(app.actor, app.session.id, app.result.event.id);
      if (fence === "revocation") app.db.sqlite.prepare("UPDATE devices SET revoked_at=? WHERE id=?").run(new Date().toISOString(), app.actor.device_id);
      if (fence === "archive") app.db.sqlite.prepare("UPDATE sessions SET state='archived' WHERE id=?").run(app.session.id);
      if (fence === "viewer") app.db.sqlite.prepare("UPDATE project_memberships SET role='viewer' WHERE project_id=? AND user_id=?").run(app.session.project_id, app.actor.user_id);
      assert.equal(app.service.appendHostedAgentProgress(app.result.event.id, app.update), false);
      assert.equal(app.db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type='agent_progress' AND json_extract(payload_json,'$.stream_mode')='snapshot'").get()?.n, 0);
    } finally { app.close(); }
  });
}

test("untrusted or oversized snapshots cannot be published through the private callback", () => {
  const app = fixture();
  try {
    assert.equal(app.service.appendHostedAgentProgress("foreign-request", app.update), false);
    assert.equal(app.service.appendHostedAgentProgress(app.result.event.id, { ...app.update, content: "x".repeat(24 * 1024 + 1) }), false);
  } finally { app.close(); }
});
