import assert from "node:assert/strict";
import test from "node:test";
import { mountInvitationLink, invitationFromHash } from "../src/invitation-link.js";
import { projectInvitationLink, projectInvitationShareText } from "../src/invitation-share.js";
import { HttpCollaborationApi } from "../src/api.js";
import { translateUiText } from "../src/i18n.js";

const token = "gti_fixture-only-not-a-real-invitation-secret";
const preview = { project: { id: "project-fixture", title: "Fixture project <script>" }, inviter_display_name: "Fixture inviter",
  role: "participant", created_at: "2026-10-12T00:00:00.000Z", expires_at: "2026-10-13T00:00:00.000Z", already_member: false };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(overrides = {}) {
  const nodes = new Map();
  const document = { documentElement: { lang: "zh-CN" }, getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: "", handlers: {}, focus() {},
      setAttribute() {}, addEventListener(event, callback) { this.handlers[event] = callback; },
      click() { if (!this.disabled) return this.handlers.click?.(); } });
    return nodes.get(id);
  } };
  const location = { href: projectInvitationLink(token, "https://gatherthread.example"), hash: `#invite=${token}`,
    replace(url) { this.destination = url; }, reload() { this.reloaded = true; } };
  const calls = { accept: 0, preview: 0, dismiss: 0, show: 0, switch: 0 };
  const context = { value: { scope: "account-1:device-1:generation-1", username: "Fixture recipient" } };
  const api = {
    async previewInvitation() { calls.preview += 1; return structuredClone(preview); },
    async acceptInvitation() { calls.accept += 1; return { invitation: { projectId: preview.project.id } }; },
    ...overrides.api,
  };
  const controller = mountInvitationLink({ document, location, history: { replaceState(_, __, url) { location.href = url; location.hash = new URL(url).hash; } },
    api, localizer: { t: value => translateUiText(value, document.documentElement.lang) }, getContext: () => context.value,
    onShow() { calls.show += 1; }, onDismiss() { calls.dismiss += 1; }, onSwitchAccount() { calls.switch += 1; context.value = null; } });
  return { controller, document, node: id => document.getElementById(id), context, api, location, calls };
}

test("share link uses the actual server and only a fragment capability; fallback key, bilingual instructions and expiry remain", () => {
  const url = new URL(projectInvitationLink(token, "https://selfhost.example/path?ignored=1#ignored"));
  assert.equal(url.origin, "https://selfhost.example"); assert.equal(url.pathname, "/app/"); assert.equal(url.search, "");
  assert.equal(invitationFromHash(url.hash).token, token);
  for (const locale of ["zh-CN", "en"]) {
    const text = projectInvitationShareText(token, { createdAt: preview.created_at, expiresAt: preview.expires_at }, locale, url.origin);
    assert.ok(text.includes(url.href)); assert.equal(text.split(token).length - 1, 2);
    assert.match(text, locale === "en" ? /Invitation secret:.*\n.*Join another project/u : /邀请密钥：.*\n.*加入其他项目/u);
    assert.ok(text.includes(locale === "en" ? "2026-10-13 08:00" : "2026/10/13 08:00"));
  }
  assert.throws(() => projectInvitationLink(token, "javascript:alert(1)"));
  assert.throws(() => projectInvitationLink(token, "https://user:password@example.test"));
  for (const hash of ["#invite=gta_device-credential", `#invite=${token}&invite=${token}`, "#invite=", "#invite=%00bad"]) {
    assert.deepEqual(invitationFromHash(hash), { present: true, token: null });
  }
  assert.equal(invitationFromHash("#project=p1").present, false);
});

test("preview API sends the capability in a same-origin POST body and rejects unexpected response fields", async () => {
  const api = new HttpCollaborationApi(); let wire;
  api.request = async (path, options) => { wire = { path, options }; return preview; };
  assert.deepEqual(await api.previewInvitation(token), preview);
  assert.equal(wire.path, "/v1/invitations/preview"); assert.equal(wire.options.method, "POST");
  assert.deepEqual(JSON.parse(wire.options.body), { invite_token: token });
  api.request = async () => ({ ...preview, invite_token: token });
  await assert.rejects(api.previewInvitation(token), error => error.code === "invalid_response" && /Invitation response is invalid/.test(error.message));
});

test("unauthenticated entry waits through registration/sign-in without any preview or acceptance", async () => {
  const h = harness(); h.context.value = null;
  assert.equal(h.controller.hasPending(), true); await h.controller.open();
  assert.equal(h.calls.preview, 0); assert.equal(h.calls.accept, 0);
  assert.equal(h.node("invitation-auth-hint").hidden, false);
  assert.equal(h.node("invitation-link-view").hidden, true);
  h.context.value = { scope: "registered-account", username: "New user" };
  await h.controller.open(); assert.equal(h.calls.preview, 1); assert.equal(h.calls.accept, 0);
  assert.equal(h.node("invitation-link-title").textContent, `加入（${preview.project.title}）`);
  assert.equal(h.node("invitation-account").textContent, "New user");
  assert.equal(h.node("invitation-confirm-button").textContent, "确认加入");
  h.document.documentElement.lang = "en"; h.controller.refreshLanguage();
  assert.equal(h.node("invitation-link-title").textContent, `Join (${preview.project.title})`);
});

test("explicit confirm rechecks and accepts once, disables duplicate actions, then replaces the capability with the project destination", async () => {
  const h = harness(); await h.controller.open(); const write = deferred();
  h.api.acceptInvitation = async () => { h.calls.accept += 1; return write.promise; };
  h.node("invitation-confirm-button").click(); h.node("invitation-confirm-button").click(); await nextTurn();
  assert.equal(h.calls.preview, 2); assert.equal(h.calls.accept, 1);
  assert.equal(h.node("invitation-decline-button").disabled, true);
  assert.equal(h.node("invitation-switch-account-button").disabled, true);
  write.resolve({ invitation: { projectId: preview.project.id } }); await nextTurn();
  const destination = new URL(h.location.destination);
  assert.equal(destination.origin, "https://gatherthread.example");
  assert.equal(destination.hash, "#project=project-fixture"); assert.equal(destination.href.includes(token), false);
  assert.equal(h.location.reloaded, true);
});

test("declining or switching accounts never accepts and clears only the intended navigation state", async () => {
  const h = harness(); await h.controller.open(); h.node("invitation-decline-button").click();
  assert.equal(h.calls.accept, 0); assert.equal(h.calls.dismiss, 1); assert.equal(h.controller.hasPending(), false);
  assert.equal(h.location.href.includes(token), false);
  const second = harness(); await second.controller.open(); second.node("invitation-switch-account-button").click(); await nextTurn();
  assert.equal(second.calls.switch, 1); assert.equal(second.calls.accept, 0); assert.equal(second.controller.hasPending(), true);
  assert.equal(second.node("invitation-link-view").hidden, true);
});

test("existing membership and a lost acceptance response recover without another membership write", async () => {
  const h = harness(); await h.controller.open();
  h.api.acceptInvitation = async () => { h.calls.accept += 1; throw new Error("Uncertain delivery"); };
  h.node("invitation-confirm-button").click(); await nextTurn();
  assert.equal(h.calls.accept, 1); assert.equal(h.location.destination, undefined);
  assert.equal(h.node("invitation-retry-button").hidden, false);
  h.api.previewInvitation = async () => ({ ...preview, already_member: true });
  await h.controller.open(); assert.equal(h.node("invitation-confirm-button").textContent, "打开项目");
  h.node("invitation-confirm-button").click(); await nextTurn();
  assert.equal(h.calls.accept, 1); assert.ok(h.location.destination.endsWith("#project=project-fixture"));
});

test("expired/revoked invitation after preview refuses to write, with bilingual retry/error controls", async () => {
  const h = harness(); await h.controller.open();
  h.api.previewInvitation = async () => { throw { code: "invitation_unavailable", status: 410 }; };
  h.node("invitation-confirm-button").click(); await nextTurn();
  assert.equal(h.calls.accept, 0); assert.equal(h.location.destination, undefined);
  assert.match(h.node("invitation-link-status").textContent, /过期/u);
  h.document.documentElement.lang = "en"; h.controller.refreshLanguage();
  assert.match(h.node("invitation-link-status").textContent, /expired/);
});

test("stale preview/accept responses after account or invitation changes cannot render or redirect", async () => {
  const read = deferred(); const h = harness({ api: { previewInvitation: () => read.promise } });
  const pending = h.controller.open(); h.context.value = { scope: "another-account", username: "Another" };
  h.controller.reset(); read.resolve(preview); await pending;
  assert.equal(h.node("invitation-link-title").textContent, "加入项目"); assert.equal(h.node("invitation-link-view").hidden, true);
  const second = harness(); await second.controller.open(); const write = deferred();
  second.api.acceptInvitation = () => write.promise;
  second.node("invitation-confirm-button").click(); await nextTurn();
  second.location.hash = "#project=other-project"; second.controller.syncFromHash();
  write.resolve({ invitation: { projectId: preview.project.id } }); await nextTurn();
  assert.equal(second.location.destination, undefined);
  assert.equal(second.controller.hasPending(), false);
});

test("malformed links fail locally and older server preview failures retain the manual-key fallback", async () => {
  const h = harness(); h.location.hash = "#invite=gta_not-a-project-invitation"; h.controller.syncFromHash(); await h.controller.open();
  assert.equal(h.calls.preview, 0); assert.equal(h.node("invitation-confirm-button").disabled, true);
  const older = harness({ api: { previewInvitation: async () => { throw { status: 404 }; } } });
  await older.controller.open(); assert.match(older.node("invitation-link-status").textContent, /邀请密钥/u);
  assert.equal(older.calls.accept, 0);
  const incompatible = harness({ api: { previewInvitation: async () => { throw { code: "invalid_response" }; } } });
  await incompatible.controller.open(); assert.match(incompatible.node("invitation-link-status").textContent, /邀请密钥/u);
  assert.equal(incompatible.calls.accept, 0);
});

test("a timed out preview releases the controls and offers an explicit retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness({ api: { previewInvitation(_token, { signal }) {
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Timed out")), { once: true }));
  } } });
  const pending = h.controller.open();
  assert.equal(h.node("invitation-confirm-button").disabled, true);
  t.mock.timers.tick(15_000);
  await pending;
  assert.equal(h.node("invitation-retry-button").hidden, false);
  assert.equal(h.node("invitation-decline-button").disabled, false);
  assert.equal(h.node("invitation-switch-account-button").disabled, false);
  assert.equal(h.calls.accept, 0);
});
