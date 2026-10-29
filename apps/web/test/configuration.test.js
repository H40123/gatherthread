import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { exportPreferences, importPreferences, mountPreferencesConfiguration } from "../src/configuration.js";
import { configurationPrompt, configurationSkillContent, teamConfigurationsInReply } from "../src/configuration-assistant.js";
import { createSoloDrafts } from "../src/solo-drafts.js";

function preferencesEditor() {
  const doc = { activeElement: null, createElement(tag) {
    const listeners = new Map();
    const node = { tagName: tag, children: [], dataset: {}, value: "", textContent: "", open: false,
      append(...children) { this.children.push(...children); }, setAttribute() {},
      addEventListener(type, callback) { const callbacks = listeners.get(type) ?? []; callbacks.push(callback); listeners.set(type, callbacks); },
      dispatch(type) { return Promise.all((listeners.get(type) ?? []).map(callback => callback({ target: this }))); },
      click() { return this.dispatch("click"); }, focus() { doc.activeElement = this; },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)]); },
      showModal() { this.open = true; }, close() { this.open = false; void this.dispatch("close"); },
    };
    node.classList = { add(value) { node.className += ` ${value}`; } }; return node;
  } };
  doc.body = doc.createElement("body");
  const button = doc.createElement("button"), staged = [];
  const ui = mountPreferencesConfiguration({ document: doc, button, getSettings: () => DEFAULT_SETTINGS,
    getInterfaceMode: () => "desktop", onStage: value => staged.push(value) });
  const dialog = doc.body.children[0], input = dialog.children.find(node => node.tagName === "textarea"),
    file = dialog.children.find(node => node.tagName === "input"), status = dialog.children.find(node => node.className === "form-error");
  void button.click();
  return { ui, button, dialog, input, status, staged, read(result, size = 100) {
    file.files = [{ size, text: () => result.promise }]; return file.dispatch("change");
  } };
}

const preferencesFile = theme => JSON.stringify({ version: 1, kind: "gatherthread.preferences", settings: { appearance: { theme } } });

for (const first of ["older", "newer"]) test(`preferences import keeps the last selected file when ${first} read completes first`, async () => {
  const f = preferencesEditor(), baseline = f.input.value, older = Promise.withResolvers(), newer = Promise.withResolvers();
  const oldRead = f.read(older), newRead = f.read(newer);
  if (first === "older") {
    older.resolve(preferencesFile("dark")); await oldRead;
    assert.equal(f.input.value, baseline, "an obsolete read cannot replace the editor while the newer file is pending");
    newer.resolve(preferencesFile("light")); await newRead;
  } else {
    newer.resolve(preferencesFile("light")); await newRead;
    older.resolve(preferencesFile("dark")); await oldRead;
  }
  assert.equal(f.input.value, preferencesFile("light")); assert.equal(f.status.textContent, ""); assert.deepEqual(f.staged, []);
});

for (const restored of [false, true]) test(`preferences typing invalidates a pending import${restored ? " even after restoring its original text" : ""}`, async () => {
  const f = preferencesEditor(), baseline = f.input.value, pending = Promise.withResolvers(), read = f.read(pending);
  f.input.value = preferencesFile("light"); await f.input.dispatch("input");
  if (restored) { f.input.value = baseline; await f.input.dispatch("input"); }
  const edited = f.input.value;
  pending.resolve(preferencesFile("dark")); await read;
  assert.equal(f.input.value, edited); assert.equal(f.status.textContent, ""); assert.deepEqual(f.staged, []);
});

for (const replacement of ["file", "typing"]) test(`an obsolete preferences read error cannot overwrite newer ${replacement}`, async () => {
  const f = preferencesEditor(), older = Promise.withResolvers(), read = f.read(older);
  if (replacement === "file") {
    const newer = Promise.withResolvers(), newRead = f.read(newer); newer.resolve(preferencesFile("light")); await newRead;
  } else { f.input.value = preferencesFile("light"); await f.input.dispatch("input"); }
  older.reject(new Error("outdated file failed")); await read;
  assert.equal(f.input.value, preferencesFile("light")); assert.equal(f.status.textContent, "");
});

for (const failure of [false, true]) test(`closing and reopening preferences fences a previous file ${failure ? "error" : "result"}`, async () => {
  const f = preferencesEditor(), pending = Promise.withResolvers(), read = f.read(pending);
  f.ui.close(); await f.button.click(); const reopened = f.input.value;
  if (failure) pending.reject(new Error("closed file failed")); else pending.resolve(preferencesFile("dark"));
  await read; assert.equal(f.dialog.open, true); assert.equal(f.input.value, reopened); assert.equal(f.status.textContent, "");
});

test("an oversized preferences selection supersedes a pending read while current errors remain visible and retryable", async () => {
  const f = preferencesEditor(), baseline = f.input.value, older = Promise.withResolvers(), read = f.read(older);
  await f.read({ promise: Promise.resolve("unused") }, 128 * 1024 + 1);
  const limitError = f.status.textContent; assert.match(limitError, /128 KiB/u);
  older.resolve(preferencesFile("dark")); await read;
  assert.equal(f.input.value, baseline); assert.equal(f.status.textContent, limitError);
  await f.read({ promise: Promise.resolve("invalid json") }); assert.match(f.status.textContent, /JSON/u);
  await f.read({ promise: Promise.resolve(preferencesFile("light")) });
  assert.equal(f.input.value, preferencesFile("light")); assert.equal(f.status.textContent, ""); assert.deepEqual(f.staged, []);
});

test("portable preference roundtrip preserves exact unrelated bindings and partial fields", () => {
  const source = structuredClone(DEFAULT_SETTINGS);
  source.agents.projectProfiles.secret = { harness: "codex", codex: { model: "gpt-5.6-sol", effort: "low" } };
  const exported = exportPreferences(source, "mobile");
  assert.equal(exported.settings.agents.projectProfiles, undefined);
  const result = importPreferences(JSON.stringify({ version: 1, kind: "gatherthread.preferences",
    settings: { appearance: { theme: "dark" } } }), source);
  assert.equal(result.settings.appearance.theme, "dark");
  assert.equal(result.settings.appearance.motion, source.appearance.motion);
  assert.equal(result.settings.agents.projectProfiles.secret.codex.model, "gpt-5.6-sol");
  assert.equal(importPreferences(JSON.stringify(exported), source).interfaceMode, "mobile");
});

test("invalid fields, permissions, limits and malformed JSON never mutate current settings", () => {
  const current = structuredClone(DEFAULT_SETTINGS);
  const baseline = JSON.stringify(current);
  for (const patch of [{ token: "not-a-real-secret" }, { appearance: { theme: "blue" } },
    { layout: { rightPanelPixels: 5000 } }, { agents: { projectProfiles: {} } },
    { agents: { enabledHarnesses: ["cloud"] } }]) {
    assert.throws(() => importPreferences(JSON.stringify({ version: 1, kind: "gatherthread.preferences", settings: patch }), current));
  }
  assert.throws(() => importPreferences('{"__proto__":{}}', current));
  assert.throws(() => importPreferences(" ".repeat(131073), current));
  assert.equal(JSON.stringify(current), baseline);
});

test("configuration skill only expands explicit invocation; reply imports are strict drafts", () => {
  assert.equal(configurationSkillContent("ordinary question"), "ordinary question");
  const prompt = configurationPrompt("zh-CN");
  assert.ok(prompt.endsWith("需求："));
  const expanded = configurationSkillContent(prompt);
  const json = expanded.match(/Example: (.*)\n/u)[1];
  assert.equal(teamConfigurationsInReply(`Here's your team:\n\`\`\`json\n${json}\n\`\`\``).length, 1);
  const parsed = JSON.parse(json); parsed.enabled = true;
  assert.deepEqual(teamConfigurationsInReply(JSON.stringify(parsed)), []);
  assert.deepEqual(teamConfigurationsInReply('{"kind":"gatherthread.agent-team"}'), []);
});

test("empty Solo cleanup is deduplicated and never deletes Multi or submitted conversations", async () => {
  let calls = 0; let finish;
  const removed = [];
  const drafts = createSoloDrafts({ api: { discardEmptySolo: async id => { calls++; return new Promise(resolve => { finish = () => resolve({ session_id: id, discarded: true }); }); } }, onDiscard: id => removed.push(id) });
  drafts.remember({ id: "multi", mode: "multi" }); await drafts.leave("multi");
  drafts.remember({ id: "sent", mode: "solo" }); drafts.submitted("sent"); await drafts.leave("sent");
  drafts.remember({ id: "solo", mode: "solo" });
  const a = drafts.leave("solo"), b = drafts.leave("solo");
  await Promise.resolve();
  assert.equal(calls, 1); finish(); await Promise.all([a, b]);
  assert.deepEqual(removed, ["solo"]);
});

test("cleanup cannot cross logout, preserves raced messages and remains retryable after transport failure", async () => {
  const removed = []; let errors = 0; let resolve;
  const api = { discardEmptySolo: () => new Promise(r => { resolve = r; }) };
  const drafts = createSoloDrafts({ api, onDiscard: id => removed.push(id), onError: () => errors++ });
  drafts.remember({ id: "first", mode: "solo" }); const leaving = drafts.leave("first");
  await Promise.resolve();
  drafts.clear(); resolve({ discarded: true }); await leaving; assert.deepEqual(removed, []);
  api.discardEmptySolo = async () => ({ discarded: false });
  drafts.remember({ id: "raced", mode: "solo" }); await drafts.leave("raced"); assert.deepEqual(removed, []);
  api.discardEmptySolo = () => { throw Error("offline"); };
  drafts.remember({ id: "retry", mode: "solo" }); await drafts.leave("retry"); assert.equal(errors, 1);
  api.discardEmptySolo = async () => ({ discarded: true }); await drafts.leave("retry"); assert.deepEqual(removed, ["retry"]);
});
