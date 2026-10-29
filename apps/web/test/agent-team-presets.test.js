import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTeamConfiguration } from "@gatherthread/protocol";
import { AGENT_TEAM_PRESETS, createAgentTeamPreset } from "../src/agent-team-presets.js";

test("all presets are localized valid graphs without hidden Agent or model selections", () => {
  assert.equal(AGENT_TEAM_PRESETS.length, 5);
  for (const preset of AGENT_TEAM_PRESETS) for (const locale of ["en", "zh-CN"]) {
    const config = createAgentTeamConfiguration(createAgentTeamPreset(preset.id, locale));
    assert.equal(config.draft.nodes.length, 3);
    assert.equal(config.draft.edges.length, 2);
    assert.ok(config.draft.nodes.every(node => node.target === null && node.role && node.prompt));
    assert.ok(config.draft.nodes.some(node => node.id === config.draft.entry_node_id));
    assert.equal(config.draft.name, locale === "zh-CN" ? preset.zh : preset.en);
  }
});

test("resetting a preset retains only matching explicit routes, without mutating the previous draft", () => {
  const original = createAgentTeamPreset("development").draft;
  const route = { kind: "local", runtime_id: "runtime", harness: "codex", provider: "fixture", model: "selected" };
  original.nodes[0].target = route;
  original.nodes[0].prompt = "custom prompt";
  const reset = createAgentTeamPreset("development", "en", original).draft;
  assert.deepEqual(reset.nodes[0].target, route);
  assert.notEqual(reset.nodes[0].target, route);
  assert.notEqual(reset.nodes[0].prompt, "custom prompt");
  reset.nodes[0].target.model = "another";
  assert.equal(original.nodes[0].target.model, "selected");
  assert.ok(createAgentTeamPreset("research", "en", original).draft.nodes.every(node => node.target === null));
});
