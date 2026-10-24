import test from "node:test";
import assert from "node:assert/strict";
import { HttpCollaborationApi, MockCollaborationApi } from "../src/api.js";
import { translateUiText } from "../src/i18n.js";

test("private creation checks server support before any POST and preserves the choice on the wire", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push([String(url), options]);
    return Response.json({ data: options.method === "POST"
      ? { session: { id: "private", mode: "solo", visibility: "private", title: "Personal" } }
      : { session_visibility_options: ["project", "private"] } });
  };
  try {
    const session = await new HttpCollaborationApi().createSession("p", { name: "Personal", mode: "solo", visibility: "private", idempotencyKey: "create" });
    assert.equal(session.visibility, "private");
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1].method, undefined);
    assert.deepEqual(JSON.parse(calls[1][1].body), { title: "Personal", mode: "solo", visibility: "private", idempotency_key: "create" });
  } finally { globalThis.fetch = original; }
});

test("an older server cannot silently create a project-visible Solo requested as private", async () => {
  const original = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_url, options = {}) => { methods.push(options.method ?? "GET"); return Response.json({ data: { project: { id: "old" } } }); };
  try {
    await assert.rejects(() => new HttpCollaborationApi().createSession("old", { name: "Personal", mode: "solo", visibility: "private" }), e => e.code === "private_solo_unsupported");
    assert.deepEqual(methods, ["GET"]);
  } finally { globalThis.fetch = original; }
});

test("preview API hides private Solo after switching reader and keeps shared Solo readable", async () => {
  const api = new MockCollaborationApi({ latency: 0 });
  const mine = await api.createSession("project-orbit", { name: "Personal", mode: "solo", visibility: "private" });
  const shared = await api.createSession("project-orbit", { name: "Shared", mode: "solo", visibility: "project" });
  assert.equal((await api.getSession(mine.id)).visibility, "private");
  const teammate = api.sessions[0].members[0];
  api.currentUser = { ...teammate, id: "different-reader" };
  assert.equal((await api.listSessions()).some(s => s.id === mine.id), false);
  assert.equal((await api.listProjectSessions("project-orbit")).some(s => s.id === mine.id), false);
  await assert.rejects(() => api.getSession(mine.id), e => e.status === 404);
  assert.equal((await api.getSession(shared.id)).id, shared.id);
});

test("visibility labels are translated in member management", () => {
  assert.equal(translateUiText("Visible in this session", "zh-CN"), "本会话可见");
  assert.equal(translateUiText("Hidden in this session", "zh-CN"), "本会话不可见");
});
