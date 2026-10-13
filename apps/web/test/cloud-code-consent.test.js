import assert from "node:assert/strict";
import test from "node:test";
import { mountCloudCodeConsent } from "../src/cloud-code-consent.js";

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ storage, getProjectCode } = {}) {
  const values = new Map();
  storage ??= { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const checkbox = { checked: false, disabled: false, addEventListener: (_event, fn) => { checkbox.change = fn; } };
  const help = { textContent: "" };
  let context = { scope: "login-1:user-1:project-1", userId: "user-1", projectId: "project-1", writable: true, source: "trial" };
  let enabled = true;
  const calls = [], notifications = [];
  const options = { checkbox, help, storage, localizer: { t: text => text }, getContext: () => context,
    onChange: () => notifications.push(true),
    api: { getProjectCode: getProjectCode ?? (async id => { calls.push(id); return { repository: { enabled } }; }) } };
  let controller = mountCloudCodeConsent(options);
  return { checkbox, help, calls, values, notifications, get controller() { return controller; },
    change: patch => { context = { ...context, ...patch }; },
    enable: value => { enabled = value; },
    choose: value => { checkbox.checked = value; checkbox.change(); },
    reload: () => { controller = mountCloudCodeConsent(options); },
    logout: () => { context = null; } };
}

test("GT Cloud code defaults on and only an explicit choice changes the persisted preference", async () => {
  const f = fixture(); f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, true); assert.equal(f.controller.includeCode(), true);
  assert.equal(f.values.size, 0, "Rendering does not write consent preferences");
  f.choose(false); assert.equal(f.controller.includeCode(), false); assert.equal(f.values.size, 1);
  f.controller.updateContext(); f.change({ sessionId: "another-session", model: "another-model" }); f.controller.updateContext();
  assert.equal(f.checkbox.checked, false); assert.equal(f.calls.length, 1);
  f.reload(); f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, false); assert.equal(f.controller.includeCode(), false);
  assert.deepEqual([...f.values.values()], ["false"]);
});

test("selected code blocks submission until metadata resolves instead of silently using an empty workspace", async () => {
  let resolve;
  const f = fixture({ getProjectCode: () => new Promise(done => { resolve = done; }) });
  f.controller.updateContext();
  assert.equal(f.checkbox.checked, true);
  assert.equal(f.controller.submission().allowed, false);
  assert.match(f.controller.submission().reason, /Checking GT Cloud/);
  resolve({ repository: { enabled: true } }); await nextTurn();
  assert.deepEqual(f.controller.submission(), { allowed: true, includeCode: true, reason: "" });
  assert.ok(f.notifications.length >= 2, "Both pending and completed metadata notify the composer");
});

test("a metadata error blocks selected code but an explicit off choice allows an empty task", async () => {
  const f = fixture({ getProjectCode: async () => { throw Error("offline"); } });
  f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, true);
  assert.equal(f.controller.submission().allowed, false);
  assert.match(f.controller.submission().reason, /Could not check GT Cloud/);
  f.choose(false);
  assert.deepEqual(f.controller.submission(), { allowed: true, includeCode: false, reason: "" });
  assert.equal(f.checkbox.checked, false);
});

test("new scopes cannot reuse a previous account's off choice before synchronization", async () => {
  const f = fixture(); f.controller.updateContext(); await nextTurn(); f.choose(false);
  f.change({ scope: "login-2:user-2:project-1", userId: "user-2" });
  assert.equal(f.controller.submission().allowed, false);
  f.controller.updateContext(); await nextTurn();
  assert.deepEqual(f.controller.submission(), { allowed: true, includeCode: true, reason: "" });
  f.change({ source: "github" });
  assert.deepEqual(f.controller.submission(), { allowed: true, includeCode: false, reason: "" });
});

test("preferences are account and project scoped, not session or model scoped", async () => {
  const f = fixture(); f.controller.updateContext(); await nextTurn(); f.choose(false);
  f.change({ scope: "login-1:user-1:project-2", projectId: "project-2" }); f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, true);
  f.change({ scope: "login-1:user-2:project-1", userId: "user-2", projectId: "project-1" }); f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, true);
  f.change({ scope: "login-2:user-1:project-1", userId: "user-1" }); f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, false);
});

test("disabled storage, read-only sessions and GitHub selection do not erase the code preference", async () => {
  const f = fixture(); f.enable(false); f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, true); assert.equal(f.checkbox.disabled, true); assert.equal(f.controller.includeCode(), false);
  assert.equal(f.controller.submission().allowed, true, "Confirmed disabled sharing allows an empty task without changing the remembered choice");
  assert.match(f.help.textContent, /Enable GT Cloud/);
  f.enable(true); await f.controller.refresh();
  assert.equal(f.checkbox.checked, true); assert.equal(f.checkbox.disabled, false); assert.equal(f.controller.includeCode(), true);
  f.change({ writable: false }); f.controller.updateContext();
  assert.equal(f.checkbox.checked, true); assert.equal(f.checkbox.disabled, true); assert.equal(f.controller.includeCode(), false);
  f.change({ writable: true, source: "github" }); f.controller.updateContext();
  assert.equal(f.controller.includeCode(), false);
  f.change({ source: "trial" }); f.controller.updateContext(); assert.equal(f.controller.includeCode(), true);
  assert.equal(f.values.size, 0);
});

test("late project metadata cannot enable code for another account and reads fail closed", async () => {
  let finish;
  const f = fixture({ getProjectCode: id => id === "project-1" ? new Promise(done => { finish = done; }) : Promise.reject(Error("unavailable")) });
  f.controller.updateContext();
  f.change({ scope: "login-1:user-1:project-2", projectId: "project-2" }); f.controller.updateContext(); await nextTurn();
  finish({ repository: { enabled: true } }); await nextTurn();
  assert.equal(f.checkbox.checked, true); assert.equal(f.controller.submission().allowed, false); assert.equal(f.controller.includeCode(), false);
  f.logout(); f.controller.updateContext(); assert.equal(f.controller.includeCode(), false);
});

test("blocked local storage still remembers an explicit choice in the current page", async () => {
  const blocked = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
  const f = fixture({ storage: blocked }); f.controller.updateContext(); await nextTurn(); f.choose(false);
  f.change({ scope: "login-1:user-1:project-2", projectId: "project-2" }); f.controller.updateContext(); await nextTurn();
  f.change({ scope: "login-1:user-1:project-1", projectId: "project-1" }); f.controller.updateContext(); await nextTurn();
  assert.equal(f.checkbox.checked, false); assert.equal(f.controller.includeCode(), false);
});

test("page teardown never starts new metadata reads and restoring the page retains the preference", async () => {
  const f = fixture(); f.controller.updateContext(); await nextTurn(); f.choose(false);
  f.controller.suspend(); f.change({ scope: "login-2:user-1:project-1" });
  f.controller.updateContext(); await f.controller.refresh();
  assert.equal(f.calls.length, 1); assert.equal(f.controller.includeCode(), false);
  f.controller.resume(); f.controller.updateContext(); await nextTurn();
  assert.equal(f.calls.length, 2); assert.equal(f.checkbox.checked, false);
});
