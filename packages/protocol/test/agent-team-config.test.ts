import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AgentTeamConfigSchema, AGENT_TEAM_CONFIG_JSON_SCHEMA, AGENT_TEAM_CONFIG_MAX_BYTES,
  AgentTeamConfigurationError, createAgentTeamConfiguration, parseAgentTeamConfiguration } from "../src/agent-team-config.js";

const example = () => createAgentTeamConfiguration({
  draft: { name: "Build and review", entry_node_id: "lead", nodes: [
    { id: "lead", label: "Coordinator", role: "Coordinate", x: 0, y: 0, target: null },
    { id: "review", label: "Reviewer", role: "Check results", x: 300, y: 0, target: null },
  ], edges: [{ id: "review-flow", source: "lead", target: "review", direction: "bidirectional" }] },
  max_calls: 12, max_duration_minutes: 30,
});

test("Team JSON preserves editable graph, prompts, limits and an explicitly selected exact route", () => {
  const config = example();
  config.draft.nodes[0]!.target = { kind: "local", runtime_id: "selected-runtime", harness: "codex",
    provider: "selected-provider", model: "selected-model", reasoning_effort: "high" };
  config.draft.nodes[0]!.prompt = "Return concrete evidence";
  config.draft.team_prompt = "Work within the request";
  assert.deepEqual(parseAgentTeamConfiguration("\uFEFF" + JSON.stringify(config)), config);
  assert.equal(parseAgentTeamConfiguration(JSON.stringify(example())).draft.nodes[1]!.target, null);
});

test("Team JSON rejects execution receipts, credentials and unknown fields at every level", () => {
  for (const field of ["enabled", "revision", "tested_revision", "test_run_id", "id", "api_key", "password", "__proto__"]) {
    const payload = JSON.stringify(example()).replace(/}$/, `,${JSON.stringify(field)}:true}`);
    assert.throws(() => parseAgentTeamConfiguration(payload), AgentTeamConfigurationError);
  }
  const extraNode = example(); Object.assign(extraNode.draft.nodes[0]!, { enabled: true });
  assert.equal(AgentTeamConfigSchema.safeParse(extraNode).success, false);
  const extraTarget = example(); Object.assign(extraTarget.draft.nodes[0]!, { target: { kind: "local", runtime_id: "runtime", harness: "codex", provider: "a", model: "b", api_key: "fixture" } });
  assert.equal(AgentTeamConfigSchema.safeParse(extraTarget).success, false);
});

test("Team JSON rejects unsupported versions, invalid graphs, missing limits and byte oversize", () => {
  assert.throws(() => parseAgentTeamConfiguration("{broken"), error => error instanceof AgentTeamConfigurationError && error.path === "json");
  assert.throws(() => parseAgentTeamConfiguration(" ".repeat(AGENT_TEAM_CONFIG_MAX_BYTES + 1)), error => error instanceof AgentTeamConfigurationError && error.path === "file_size");
  assert.throws(() => parseAgentTeamConfiguration("中".repeat(AGENT_TEAM_CONFIG_MAX_BYTES / 2)), error => error instanceof AgentTeamConfigurationError && error.path === "file_size");
  assert.equal(AgentTeamConfigSchema.safeParse({ ...example(), version: 2 }).success, false);
  assert.equal(AgentTeamConfigSchema.safeParse({ ...example(), max_calls: undefined }).success, false);
  assert.equal(AgentTeamConfigSchema.safeParse({ ...example(), max_calls: 49 }).success, false);
  const dangling = example(); dangling.draft.edges[0]!.target = "missing";
  assert.equal(AgentTeamConfigSchema.safeParse(dangling).success, false);
  const duplicate = example(); duplicate.draft.nodes[1]!.id = "lead";
  assert.equal(AgentTeamConfigSchema.safeParse(duplicate).success, false);
});

test("published Team schema and documented examples match the runtime configuration contract", () => {
  const folder = new URL("../../../../docs/configuration/", import.meta.url);
  assert.deepEqual(JSON.parse(readFileSync(new URL("agent-team.v1.schema.json", folder), "utf8")), AGENT_TEAM_CONFIG_JSON_SCHEMA);
  for (const name of ["agent-team.development.json", "agent-team.research.json"]) {
    const config = parseAgentTeamConfiguration(readFileSync(new URL(name, folder), "utf8"));
    assert.ok(config.draft.nodes.length >= 3);
    assert.ok(config.draft.nodes.every(node => node.target === null));
  }
});
