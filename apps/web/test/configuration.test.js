import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { exportPreferences, importPreferences } from "../src/configuration.js";
import { configurationPrompt, configurationSkillContent, teamConfigurationsInReply } from "../src/configuration-assistant.js";
import { createSoloDrafts } from "../src/solo-drafts.js";

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
